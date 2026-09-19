// Command conformance runs the anyonce conformance suite over HTTP against a running target. It mirrors
// packages/conformance/src/cli.ts flag for flag (REQ-CONF-8). It exists because a fetch()-based client always
// lowercases the header names it sends, so the TypeScript CLI cannot put a non-canonical spelling on the wire;
// this runner sets the request header map directly (go/conformance/run.go), which Go's client writes exactly as
// given, so core/header-name-case-insensitive can be graded for real (docs/superpowers/questions.md Q52).
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/sns45/anyonce/go/conformance"
)

const usageText = "usage: conformance -url <base> [-tier core|profile]... [-only <id>]... " +
	"[-capability short-ttl]... [-ttl-ms <n>] [-report json|markdown|junit] [-out <file>]"

// stringList is a flag.Value that appends every occurrence of a repeatable flag, since the standard flag
// package has no built-in support for a flag given more than once.
type stringList []string

func (s *stringList) String() string {
	if s == nil {
		return ""
	}
	return strings.Join(*s, ",")
}

func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

type options struct {
	url          string
	tiers        []string
	only         []string
	capabilities []string
	ttlMs        int
	report       string
	out          string
}

// parseArgs is a pure function so the flag handling and its usage errors are testable without a server.
func parseArgs(args []string) (options, error) {
	fs := flag.NewFlagSet("conformance", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	var tiers, only, capabilities stringList
	var url, report, out string
	var ttlMs int

	fs.StringVar(&url, "url", "", "base URL of the target")
	fs.Var(&tiers, "tier", "tier to run, repeatable (core or profile); default every tier")
	fs.Var(&only, "only", "vector id to run, repeatable; default every selected vector")
	fs.Var(&capabilities, "capability", "capability the target supports, repeatable (short-ttl)")
	fs.IntVar(&ttlMs, "ttl-ms", 0, "the target's configured record TTL in milliseconds")
	fs.StringVar(&report, "report", "markdown", "report format: json, markdown or junit")
	fs.StringVar(&out, "out", "", "file to write the report to; stdout when empty")

	if err := fs.Parse(args); err != nil {
		return options{}, fmt.Errorf("%v\n%s", err, usageText)
	}

	ttlMsSet := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "ttl-ms" {
			ttlMsSet = true
		}
	})

	for _, tier := range tiers {
		if tier != "core" && tier != "profile" {
			return options{}, fmt.Errorf("unknown tier %q\n%s", tier, usageText)
		}
	}
	for _, capability := range capabilities {
		if capability != "short-ttl" {
			return options{}, fmt.Errorf("unknown capability %q\n%s", capability, usageText)
		}
	}
	switch report {
	case "json", "markdown", "junit":
	default:
		return options{}, fmt.Errorf("unknown report format %q\n%s", report, usageText)
	}
	if url == "" {
		return options{}, fmt.Errorf("-url is required\n%s", usageText)
	}
	if ttlMsSet && ttlMs <= 0 {
		return options{}, fmt.Errorf("-ttl-ms must be a positive integer, got %d", ttlMs)
	}
	for _, capability := range capabilities {
		if capability == "short-ttl" && ttlMsSet && ttlMs > 2000 {
			return options{}, fmt.Errorf("short-ttl requires a target TTL of at most 2000 ms, got %d", ttlMs)
		}
	}

	return options{
		url:          url,
		tiers:        []string(tiers),
		only:         []string(only),
		capabilities: []string(capabilities),
		ttlMs:        ttlMs,
		report:       report,
		out:          out,
	}, nil
}

// run loads the vectors, runs them against opts.url, writes the formatted report to stdout (or opts.out), and
// returns the process exit code: 0 when nothing failed or errored, 1 otherwise.
func run(ctx context.Context, opts options, stdout io.Writer) (int, error) {
	vectors, err := conformance.LoadVectors(conformance.DefaultVectorsDir())
	if err != nil {
		return 0, fmt.Errorf("load vectors: %w", err)
	}
	runOpts := conformance.Options{Tiers: opts.tiers, Only: opts.only, Capabilities: opts.capabilities}
	summary, err := conformance.RunVectors(ctx, opts.url, vectors, runOpts)
	if err != nil {
		return 0, fmt.Errorf("run vectors: %w", err)
	}
	report, err := conformance.Format(summary, opts.report, opts.url)
	if err != nil {
		return 0, fmt.Errorf("format report: %w", err)
	}
	if opts.out != "" {
		if err := os.WriteFile(opts.out, report, 0o600); err != nil {
			return 0, fmt.Errorf("write %s: %w", opts.out, err)
		}
	} else if _, err := stdout.Write(report); err != nil {
		return 0, fmt.Errorf("write report: %w", err)
	}
	if summary.Failed == 0 && summary.Errored == 0 {
		return 0, nil
	}
	return 1, nil
}

func main() {
	opts, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	code, err := run(context.Background(), opts, os.Stdout)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(code)
}
