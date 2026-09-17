package dynamodb_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/store/dynamodb"
	"github.com/sns45/anyonce/go/storetest"
)

// clientTo builds a client against an arbitrary endpoint; no service is needed for these guards.
func clientTo(endpoint string) *awsdynamodb.Client {
	return awsdynamodb.New(awsdynamodb.Options{
		Region:           "us-east-1",
		BaseEndpoint:     aws.String(endpoint),
		Credentials:      credentials.NewStaticCredentialsProvider("local", "local", ""),
		RetryMaxAttempts: 1,
	})
}

func TestDynamoDBGuards(t *testing.T) {
	ctx := context.Background()
	op := anyonce.Operation{Scope: "guards", Key: "k", Fingerprint: "a"}

	t.Run("REQ-ST-DDB-1: Complete refuses a body above the item cap and names the policy option", func(t *testing.T) {
		// Port 1 is never a listener, so a missing guard would surface as a dial error rather than this message.
		s := dynamodb.New(clientTo("http://127.0.0.1:1"), dynamodb.Options{Table: "t"})
		body := make([]byte, dynamodb.MaxResultBytes+1)
		status, err := s.Complete(ctx, op, 1, anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Body: body}, storetest.T0)
		if err == nil {
			t.Fatalf("a %d byte body was accepted, status %v", len(body), status)
		}
		if status != "" {
			t.Fatalf("status %q alongside the error", status)
		}
		for _, want := range []string{"MaxResultBytes", "307201", "307200", "Q20", "omitted"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("the message does not name %q: %v", want, err)
			}
		}
	})

	t.Run("REQ-ST-DDB-1: a body exactly at the cap is handed to DynamoDB rather than refused", func(t *testing.T) {
		s := dynamodb.New(clientTo("http://127.0.0.1:1"), dynamodb.Options{Table: "t"})
		body := make([]byte, dynamodb.MaxResultBytes)
		_, err := s.Complete(ctx, op, 1, anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Body: body}, storetest.T0)
		if err == nil || strings.Contains(err.Error(), "MaxResultBytes") {
			t.Fatalf("a body at the cap must reach the endpoint and fail there, got %v", err)
		}
	})

	t.Run("REQ-ST-DDB-1: a refusal with no old item names ReturnValuesOnConditionCheckFailure", func(t *testing.T) {
		// An endpoint that refuses every conditional write the way one that ignores
		// ReturnValuesOnConditionCheckFailure does: the exception without the Item member.
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/x-amz-json-1.0")
			w.Header().Set("x-amzn-errortype", "ConditionalCheckFailedException")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"__type":"com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException","message":"The conditional request failed"}`))
		}))
		t.Cleanup(server.Close)
		s := dynamodb.New(clientTo(server.URL), dynamodb.Options{Table: "t"})
		_, err := s.Begin(ctx, op, anyonce.BeginOptions{Lease: storetest.Lease, TTL: storetest.TTL, Now: storetest.T0})
		if err == nil {
			t.Fatal("expected an error")
		}
		for _, want := range []string{"ReturnValuesOnConditionCheckFailure", "DynamoDB Local 2.x"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("the message does not name %q: %v", want, err)
			}
		}
	})

	t.Run("REQ-ST-DDB-1: Purge is a no-op that returns 0 without touching the endpoint", func(t *testing.T) {
		s := dynamodb.New(clientTo("http://127.0.0.1:1"), dynamodb.Options{Table: "t"})
		n, err := s.Purge(ctx, time.Now())
		if err != nil || n != 0 {
			t.Fatalf("purge %d %v", n, err)
		}
	})
}
