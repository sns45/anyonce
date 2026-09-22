package conformance

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Options select vectors and describe the target.
type Options struct {
	Tiers        []string
	Capabilities []string
	Only         []string
	ResetPath    string
	CounterPath  string
	// VectorsDir, when set, makes Run load the vectors from this directory instead of the embedded copy
	// (DefaultVectors).
	VectorsDir string
	Client     *http.Client
}

// StepOutcome is the result of evaluating one step's response against its expectation.
type StepOutcome struct {
	StepID   string   `json:"stepId"`
	Failures []string `json:"failures"`
}

// VectorResult is the outcome of running one vector.
type VectorResult struct {
	ID     string        `json:"id"`
	Tier   string        `json:"tier"`
	Status string        `json:"status"`
	Steps  []StepOutcome `json:"steps"`
	Error  string        `json:"error,omitempty"`
}

// Summary aggregates the results of a run.
type Summary struct {
	Results       []VectorResult `json:"results"`
	Passed        int            `json:"passed"`
	Failed        int            `json:"failed"`
	NotApplicable int            `json:"notApplicable"`
	Errored       int            `json:"errored"`
}

type sendResult struct {
	obs observed
	err error
}

type runner struct {
	client      *http.Client
	baseURL     string
	resetPath   string
	counterPath string
}

func (r *runner) send(ctx context.Context, req StepRequest) (observed, error) {
	var body io.Reader
	if req.Body != nil {
		body = strings.NewReader(*req.Body)
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, r.baseURL+req.Path, body)
	if err != nil {
		return observed{}, fmt.Errorf("build request: %w", err)
	}
	for k, v := range req.Headers {
		// Direct map assignment, not Header.Set: Set canonicalizes the name, and a vector that spells the
		// field name in lowercase is testing exactly that spelling on the wire (REQ-CONF-6).
		httpReq.Header[k] = []string{v}
	}
	res, err := r.client.Do(httpReq)
	if err != nil {
		return observed{}, fmt.Errorf("send %s %s: %w", req.Method, req.Path, err)
	}
	defer func() { _ = res.Body.Close() }()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return observed{}, fmt.Errorf("read %s %s: %w", req.Method, req.Path, err)
	}
	return observed{status: res.StatusCode, header: res.Header, body: data}, nil
}

func (r *runner) counter(ctx context.Context) *int {
	obs, err := r.send(ctx, StepRequest{Method: http.MethodGet, Path: r.counterPath})
	if err != nil || obs.status != http.StatusOK {
		return nil
	}
	var parsed struct {
		Count *int `json:"count"`
	}
	if json.Unmarshal(obs.body, &parsed) != nil {
		return nil
	}
	return parsed.Count
}

type pendingStep struct {
	step Step
	ch   chan sendResult
}

func (r *runner) start(ctx context.Context, step Step) pendingStep {
	ch := make(chan sendResult, 1)
	go func() {
		obs, err := r.send(ctx, step.Request)
		ch <- sendResult{obs: obs, err: err}
	}()
	return pendingStep{step: step, ch: ch}
}

// runVector follows the README ordering rules: deferred steps are sent and left pending; a step with
// concurrentWith is sent while they are pending and the group is checked together with one counter read.
func (r *runner) runVector(ctx context.Context, v Vector) VectorResult {
	// A per-vector cancellation tears down any step still in flight on an error path (a failed group, a
	// cancelled delay, a missing concurrentWith reference) before the next vector's reset runs (REQ-CONF-6).
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	result := VectorResult{ID: v.ID, Tier: v.Tier, Steps: []StepOutcome{}}
	fail := func(err error) VectorResult {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	reset, err := r.send(ctx, StepRequest{Method: http.MethodPost, Path: r.resetPath})
	if err != nil {
		return fail(err)
	}
	if reset.status < 200 || reset.status >= 300 {
		return fail(fmt.Errorf("reset returned %d", reset.status))
	}
	deferred := map[string]bool{}
	for _, step := range v.Steps {
		for _, id := range step.ConcurrentWith {
			deferred[id] = true
		}
	}
	prior := map[string][]byte{}
	pending := map[string]pendingStep{}
	pendingOrder := []string{}

	evaluateGroup := func(group []pendingStep) error {
		results := make([]sendResult, len(group))
		for i, p := range group {
			results[i] = <-p.ch
			if results[i].err != nil {
				return results[i].err
			}
		}
		var invocations *int
		for _, p := range group {
			if p.step.Expect.HandlerInvocations != nil {
				invocations = r.counter(ctx)
				break
			}
		}
		for i, p := range group {
			ctxEval := evalContext{prior: prior, invocations: invocations}
			result.Steps = append(result.Steps, StepOutcome{StepID: p.step.ID, Failures: evaluate(p.step.Expect, results[i].obs, ctxEval)})
			prior[p.step.ID] = results[i].obs.body
		}
		return nil
	}
	settlePending := func() error {
		if len(pending) == 0 {
			return nil
		}
		group := make([]pendingStep, 0, len(pending))
		for _, id := range pendingOrder {
			group = append(group, pending[id])
		}
		pending = map[string]pendingStep{}
		pendingOrder = nil
		return evaluateGroup(group)
	}

	for _, step := range v.Steps {
		if len(step.ConcurrentWith) == 0 {
			if err := settlePending(); err != nil {
				return fail(err)
			}
		}
		if step.DelayMs > 0 {
			select {
			case <-time.After(time.Duration(step.DelayMs) * time.Millisecond):
			case <-ctx.Done():
				return fail(ctx.Err())
			}
		}
		started := r.start(ctx, step)
		if deferred[step.ID] {
			pending[step.ID] = started
			pendingOrder = append(pendingOrder, step.ID)
			continue
		}
		if len(step.ConcurrentWith) > 0 {
			group := make([]pendingStep, 0, len(step.ConcurrentWith)+1)
			for _, id := range step.ConcurrentWith {
				p, ok := pending[id]
				if !ok {
					return fail(fmt.Errorf("step %s: concurrentWith references %s, which is not pending", step.ID, id))
				}
				group = append(group, p)
				delete(pending, id)
			}
			// Filter pendingOrder in place rather than rebuilding it from the map, whose iteration order is
			// randomized: the remaining ids must keep their original insertion order (REQ-CONF-6).
			kept := pendingOrder[:0]
			for _, id := range pendingOrder {
				if _, ok := pending[id]; ok {
					kept = append(kept, id)
				}
			}
			pendingOrder = kept
			group = append(group, started)
			if err := evaluateGroup(group); err != nil {
				return fail(err)
			}
			continue
		}
		if err := evaluateGroup([]pendingStep{started}); err != nil {
			return fail(err)
		}
	}
	if err := settlePending(); err != nil {
		return fail(err)
	}
	result.Status = "pass"
	for _, s := range result.Steps {
		if len(s.Failures) > 0 {
			result.Status = "fail"
		}
	}
	return result
}

// RunVectors runs the selected vectors sequentially against baseURL (REQ-CONF-6).
func RunVectors(ctx context.Context, baseURL string, vectors []Vector, opts Options) (Summary, error) {
	r := &runner{client: opts.Client, baseURL: strings.TrimSuffix(baseURL, "/"), resetPath: opts.ResetPath, counterPath: opts.CounterPath}
	if r.client == nil {
		r.client = &http.Client{Timeout: 30 * time.Second}
	}
	if r.resetPath == "" {
		r.resetPath = "/reset"
	}
	if r.counterPath == "" {
		r.counterPath = "/counter"
	}
	tiers := map[string]bool{}
	for _, t := range opts.Tiers {
		tiers[t] = true
	}
	only := map[string]bool{}
	for _, id := range opts.Only {
		only[id] = true
	}
	capabilities := map[string]bool{}
	for _, c := range opts.Capabilities {
		capabilities[c] = true
	}
	var summary Summary
	summary.Results = []VectorResult{}
	for _, v := range vectors {
		if len(tiers) > 0 && !tiers[v.Tier] {
			continue
		}
		if len(only) > 0 && !only[v.ID] {
			continue
		}
		var missing []string
		for _, c := range v.Requires {
			if !capabilities[c] {
				missing = append(missing, c)
			}
		}
		var result VectorResult
		if len(missing) > 0 {
			result = VectorResult{ID: v.ID, Tier: v.Tier, Status: "not-applicable", Steps: []StepOutcome{}, Error: "requires " + strings.Join(missing, ", ")}
		} else {
			result = r.runVector(ctx, v)
		}
		summary.Results = append(summary.Results, result)
		switch result.Status {
		case "pass":
			summary.Passed++
		case "fail":
			summary.Failed++
		case "not-applicable":
			summary.NotApplicable++
		default:
			summary.Errored++
		}
	}
	return summary, ctx.Err()
}
