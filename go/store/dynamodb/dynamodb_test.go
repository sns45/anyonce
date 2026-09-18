package dynamodb_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/dynamodb"
	"github.com/sns45/anyonce/go/store/internal/servicetest"
	"github.com/sns45/anyonce/go/storetest"
)

func client() *awsdynamodb.Client {
	return awsdynamodb.New(awsdynamodb.Options{
		Region:       "us-east-1",
		BaseEndpoint: aws.String("http://127.0.0.1:18000"),
		Credentials:  credentials.NewStaticCredentialsProvider("local", "local", ""),
	})
}

func TestDynamoDBStore(t *testing.T) {
	servicetest.Require(t, "dynamodb", "127.0.0.1:18000")
	ctx := context.Background()
	c := client()
	table := fmt.Sprintf("anyonce_go_%d", time.Now().UnixNano())
	if err := dynamodb.EnsureTable(ctx, c, table); err != nil {
		t.Fatal(err)
	}
	storetest.Run(t, "dynamodb", func(*testing.T) storetest.Harness {
		s := dynamodb.New(c, dynamodb.Options{Table: table})
		return storetest.Harness{Store: s, PhysicallyRemove: s.PhysicallyRemove, MaxResultBytes: dynamodb.MaxResultBytes, NativePurge: true}
	})

	t.Run("REQ-ST-DDB-1: EnsureTable is idempotent, taking the ResourceInUse and already-enabled TTL branches", func(t *testing.T) {
		if err := dynamodb.EnsureTable(ctx, c, table); err != nil {
			t.Fatalf("second EnsureTable on the same table: %v", err)
		}
	})

	t.Run("REQ-ST-DDB-1: a refused begin classifies from the returned old item and the ttl attribute is enabled", func(t *testing.T) {
		s := dynamodb.New(c, dynamodb.Options{Table: table})
		op := anyonce.Operation{Scope: fmt.Sprintf("rvocf-%d", time.Now().UnixNano()), Key: "k", Fingerprint: "a"}
		opts := anyonce.BeginOptions{Lease: storetest.Lease, TTL: storetest.TTL, Now: storetest.T0}
		if _, err := s.Begin(ctx, op, opts); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Complete(ctx, op, 1, anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Body: []byte{1}}, storetest.T0.Add(time.Millisecond)); err != nil {
			t.Fatal(err)
		}
		out, err := s.Begin(ctx, anyonce.Operation{Scope: op.Scope, Key: op.Key, Fingerprint: "b"}, opts)
		if err != nil || out.Kind != anyonce.BeginMismatch || out.Record == nil || out.Record.Result == nil || string(out.Record.Result.Body) != "\x01" {
			t.Fatalf("%+v %v", out, err)
		}
		ttl, err := c.DescribeTimeToLive(ctx, &awsdynamodb.DescribeTimeToLiveInput{TableName: aws.String(table)})
		if err != nil || ttl.TimeToLiveDescription.TimeToLiveStatus != types.TimeToLiveStatusEnabled || *ttl.TimeToLiveDescription.AttributeName != "ttl" {
			t.Fatalf("%+v %v", ttl, err)
		}
		if n, err := s.Purge(ctx, time.Now()); err != nil || n != 0 {
			t.Fatalf("purge %d %v", n, err)
		}
	})

	t.Run("REQ-ST-DDB-1: the native ttl attribute is the wall clock plus the ttl plus the grace, in seconds", func(t *testing.T) {
		s := dynamodb.New(c, dynamodb.Options{Table: table, NativeTTLGrace: 90 * time.Second})
		op := anyonce.Operation{Scope: fmt.Sprintf("ttlattr-%d", time.Now().UnixNano()), Key: "k", Fingerprint: "a"}
		before := time.Now()
		if _, err := s.Begin(ctx, op, anyonce.BeginOptions{Lease: storetest.Lease, TTL: time.Hour, Now: storetest.T0}); err != nil {
			t.Fatal(err)
		}
		item, err := c.GetItem(ctx, &awsdynamodb.GetItemInput{
			TableName:      aws.String(table),
			Key:            map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: dynamodb.ItemKey(op.Scope, op.Key)}},
			ConsistentRead: aws.Bool(true),
		})
		if err != nil {
			t.Fatal(err)
		}
		ttlAttr, ok := item.Item["ttl"].(*types.AttributeValueMemberN)
		if !ok {
			t.Fatalf("no numeric ttl attribute: %+v", item.Item)
		}
		var seconds int64
		if _, err := fmt.Sscan(ttlAttr.Value, &seconds); err != nil {
			t.Fatal(err)
		}
		low, high := before.Add(time.Hour+90*time.Second).Unix(), time.Now().Add(time.Hour+90*time.Second).Unix()
		if seconds < low || seconds > high {
			t.Fatalf("ttl %d outside [%d, %d]", seconds, low, high)
		}
		// The logical expiry comes from opts.Now, never from the wall clock.
		expires, ok := item.Item["expires_at"].(*types.AttributeValueMemberN)
		if !ok || expires.Value != fmt.Sprint(storetest.T0.Add(time.Hour).UnixMilli()) {
			t.Fatalf("expires_at %+v", item.Item["expires_at"])
		}
	})

	t.Run("REQ-ST-DDB-1: the item lives under the single partition key pk, the scope and key joined (Q22)", func(t *testing.T) {
		s := dynamodb.New(c, dynamodb.Options{Table: table})
		op := anyonce.Operation{Scope: fmt.Sprintf("q22-%d", time.Now().UnixNano()), Key: "k/with/slashes", Fingerprint: "a"}
		if _, err := s.Begin(ctx, op, anyonce.BeginOptions{Lease: storetest.Lease, TTL: storetest.TTL, Now: storetest.T0}); err != nil {
			t.Fatal(err)
		}
		composite := op.Scope + string(rune(31)) + op.Key
		if dynamodb.ItemKey(op.Scope, op.Key) != composite {
			t.Fatalf("ItemKey is %q", dynamodb.ItemKey(op.Scope, op.Key))
		}
		item, err := c.GetItem(ctx, &awsdynamodb.GetItemInput{
			TableName:      aws.String(table),
			Key:            map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: composite}},
			ConsistentRead: aws.Bool(true),
		})
		if err != nil {
			t.Fatal(err)
		}
		pk, ok := item.Item["pk"].(*types.AttributeValueMemberS)
		if !ok || pk.Value != composite {
			t.Fatalf("pk %+v", item.Item["pk"])
		}
		if _, hasSort := item.Item["sk"]; hasSort {
			t.Fatal("the item still carries a sort key")
		}
		rec, err := s.Get(ctx, op.Scope, op.Key, storetest.T0.Add(time.Millisecond))
		if err != nil || rec == nil || rec.Scope != op.Scope || rec.Key != op.Key {
			t.Fatalf("%+v %v", rec, err)
		}
	})

	t.Run("REQ-ST-DDB-1: every core and profile vector passes through httpmw with the DynamoDB store", func(t *testing.T) {
		f := fixture.New()
		// No MaxResultBytes in the policy on purpose: the store implements anyonce.ResultCapper, so httpmw caps
		// the policy at it and the run proves the automatic cap rather than an explicit override.
		mw := httpmw.New(dynamodb.New(c, dynamodb.Options{Table: table}), httpmw.Options{Required: true, Policy: anyonce.Policy{TTL: 2 * time.Second}})
		mux := http.NewServeMux()
		mux.Handle("POST /reset", f.Handler())
		mux.Handle("/", mw.Handler(f.Handler()))
		summary := conformance.Run(t, mux, conformance.Options{Capabilities: []string{"short-ttl"}})
		if summary.Passed != len(summary.Results) || len(summary.Results) != 20 {
			t.Fatalf("passed %d of %d", summary.Passed, len(summary.Results))
		}
	})
}
