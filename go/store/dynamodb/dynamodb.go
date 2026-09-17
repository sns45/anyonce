// Package dynamodb is the DynamoDB store (REQ-ST-DDB-1): begin, complete and abandon are each one conditional
// write, and a refused write carries the old item back through ReturnValuesOnConditionCheckFailure, so no second
// read is needed to classify it.
package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/store/internal/rowcodec"
)

// MaxResultBytes is Q20: a DynamoDB item is capped at 400 KB, so bodies above this are stored in the omitted form.
const MaxResultBytes = 307_200

// DefaultTable is the table name New uses when Options.Table is empty.
const DefaultTable = "anyonce_records"

// DefaultNativeTTLGrace is added to the native ttl attribute when Options.NativeTTLGrace is zero.
const DefaultNativeTTLGrace = 60 * time.Second

const (
	inFlight  = string(anyonce.StateInFlight)
	completed = string(anyonce.StateCompleted)
)

// KeySeparator is the unit separator: the scope and the key are joined with it into the single partition key
// pk, so one composed key stays unambiguous (Q22).
const KeySeparator = string(rune(31))

// ItemKey is the item key an operation maps to: the scope and the key joined by KeySeparator (Q22).
func ItemKey(scope, k string) string { return scope + KeySeparator + k }

// Options configure the store. Table defaults to DefaultTable, whose single partition key pk holds the scope
// and the key (Q22); there is no sort key.
// NativeTTLGrace is added to the native ttl attribute so a late complete from the previous fence holder still
// finds its row; it defaults to DefaultNativeTTLGrace.
type Options struct {
	Table          string
	NativeTTLGrace time.Duration
}

// Store is the DynamoDB implementation of anyonce.Store.
type Store struct {
	client *awsdynamodb.Client
	table  string
	grace  time.Duration
}

// New builds a store over an existing DynamoDB client.
func New(client *awsdynamodb.Client, opts Options) *Store {
	s := &Store{client: client, table: opts.Table, grace: opts.NativeTTLGrace}
	if s.table == "" {
		s.table = DefaultTable
	}
	if s.grace == 0 {
		s.grace = DefaultNativeTTLGrace
	}
	return s
}

func key(scope, k string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		"pk": &types.AttributeValueMemberS{Value: ItemKey(scope, k)},
	}
}

// splitKey undoes ItemKey, splitting on the first separator: a scope never contains one, a key may.
func splitKey(pk string) (scope, k string) {
	at := strings.Index(pk, KeySeparator)
	if at < 0 {
		return pk, ""
	}
	return pk[:at], pk[at+len(KeySeparator):]
}

func num(value int64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(value, 10)}
}

func str(value string) types.AttributeValue {
	return &types.AttributeValueMemberS{Value: value}
}

func readNum(item map[string]types.AttributeValue, name string) int64 {
	if attr, ok := item[name].(*types.AttributeValueMemberN); ok {
		if parsed, err := strconv.ParseInt(attr.Value, 10, 64); err == nil {
			return parsed
		}
	}
	return 0
}

func readStr(item map[string]types.AttributeValue, name string) string {
	if attr, ok := item[name].(*types.AttributeValueMemberS); ok {
		return attr.Value
	}
	return ""
}

func itemToRow(item map[string]types.AttributeValue) rowcodec.Row {
	scope, k := splitKey(readStr(item, "pk"))
	row := rowcodec.Row{
		Scope:         scope,
		Key:           k,
		Fingerprint:   readStr(item, "fingerprint"),
		State:         readStr(item, "state"),
		Fence:         readNum(item, "fence"),
		LeaseUntil:    readNum(item, "lease_until"),
		CreatedAt:     readNum(item, "created_at"),
		ExpiresAt:     readNum(item, "expires_at"),
		ResultOmitted: readNum(item, "result_omitted"),
	}
	if row.State == "" {
		row.State = inFlight
	}
	if attr, ok := item["result_meta"].(*types.AttributeValueMemberS); ok {
		meta := attr.Value
		row.ResultMeta = &meta
	}
	if attr, ok := item["result_body"].(*types.AttributeValueMemberB); ok {
		row.ResultBody = attr.Value
	}
	return row
}

// refusal returns the old item a conditional write carried back, and whether err was such a refusal.
func refusal(err error) (map[string]types.AttributeValue, bool) {
	var failed *types.ConditionalCheckFailedException
	if !errors.As(err, &failed) {
		return nil, false
	}
	return failed.Item, true
}

// unclassifiableRefusal is the error for a refusal that carried no old item back, which leaves Begin with
// nothing to classify. It names the option that has to be honoured, as the TypeScript store's message does.
func unclassifiableRefusal(err error) error {
	return fmt.Errorf("dynamodb: begin was refused without returning the old item, so the refusal cannot be "+
		"classified; the endpoint must honour ReturnValuesOnConditionCheckFailure (DynamoDB Local 2.x or later, "+
		"or a live table): %w", err)
}

// Begin claims the operation with one conditional UpdateItem. A refusal is classified from the old item the
// write returned: TTL expiry first, then fingerprint, then state and lease.
func (s *Store) Begin(ctx context.Context, op anyonce.Operation, opts anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	nowMs := opts.Now.UnixMilli()
	for attempt := 0; attempt < 3; attempt++ {
		// The native attribute is a wall clock deadline in seconds; every logical field comes from opts.Now.
		ttlSeconds := time.Now().Add(opts.TTL + s.grace).Unix()
		out, err := s.client.UpdateItem(ctx, &awsdynamodb.UpdateItemInput{
			TableName:           aws.String(s.table),
			Key:                 key(op.Scope, op.Key),
			ConditionExpression: aws.String("attribute_not_exists(pk) OR expires_at <= :now OR (fingerprint = :fp AND #state = :in_flight AND lease_until <= :now)"),
			UpdateExpression: aws.String("SET fingerprint = :fp, #state = :in_flight, fence = if_not_exists(fence, :zero) + :one, " +
				"lease_until = :lease, created_at = :now, expires_at = :exp, #ttl = :ttl, result_omitted = :zero REMOVE result_meta, result_body"),
			ExpressionAttributeNames: map[string]string{"#state": "state", "#ttl": "ttl"},
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":fp":        str(op.Fingerprint),
				":in_flight": str(inFlight),
				":now":       num(nowMs),
				":zero":      num(0),
				":one":       num(1),
				":lease":     num(opts.Now.Add(opts.Lease).UnixMilli()),
				":exp":       num(opts.Now.Add(opts.TTL).UnixMilli()),
				":ttl":       num(ttlSeconds),
			},
			ReturnValues:                        types.ReturnValueAllNew,
			ReturnValuesOnConditionCheckFailure: types.ReturnValuesOnConditionCheckFailureAllOld,
		})
		if err == nil {
			return anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: readNum(out.Attributes, "fence")}, nil
		}
		item, refused := refusal(err)
		if !refused {
			return anyonce.BeginOutcome{}, fmt.Errorf("dynamodb: begin: %w", err)
		}
		if item == nil {
			return anyonce.BeginOutcome{}, unclassifiableRefusal(err)
		}
		row := itemToRow(item)
		if row.ExpiresAt <= nowMs {
			continue
		}
		record := rowcodec.ToRecord(row)
		if row.Fingerprint != op.Fingerprint {
			return anyonce.BeginOutcome{Kind: anyonce.BeginMismatch, Record: &record}, nil
		}
		if row.State == completed {
			return anyonce.BeginOutcome{Kind: anyonce.BeginCompleted, Record: &record}, nil
		}
		if row.LeaseUntil > nowMs {
			return anyonce.BeginOutcome{Kind: anyonce.BeginInFlight, LeaseUntil: time.UnixMilli(row.LeaseUntil).UTC()}, nil
		}
	}
	return anyonce.BeginOutcome{}, errors.New("dynamodb: begin could not settle after three attempts")
}

// Complete stores the result if the fence still holds and the row is live and in flight.
func (s *Store) Complete(ctx context.Context, op anyonce.Operation, fence int64, result anyonce.StoredResult, now time.Time) (anyonce.CompleteStatus, error) {
	if !result.Omitted && len(result.Body) > MaxResultBytes {
		return "", fmt.Errorf("dynamodb: cannot store a %d byte body because an item is capped at 400 KB (Q20); "+
			"set Policy.MaxResultBytes to at most %d so a larger result is stored in the omitted form instead",
			len(result.Body), MaxResultBytes)
	}
	meta, err := rowcodec.EncodeMeta(result)
	if err != nil {
		return "", fmt.Errorf("dynamodb: complete: %w", err)
	}
	nowMs := now.UnixMilli()
	omitted := int64(0)
	if result.Omitted {
		omitted = 1
	}
	values := map[string]types.AttributeValue{
		":fence":     num(fence),
		":now":       num(nowMs),
		":in_flight": str(inFlight),
		":completed": str(completed),
		":meta":      str(meta),
		":om":        num(omitted),
	}
	update := "SET #state = :completed, result_meta = :meta, result_omitted = :om"
	if !result.Omitted && result.Body != nil {
		values[":body"] = &types.AttributeValueMemberB{Value: result.Body}
		update += ", result_body = :body"
	} else {
		update += " REMOVE result_body"
	}
	_, err = s.client.UpdateItem(ctx, &awsdynamodb.UpdateItemInput{
		TableName:                           aws.String(s.table),
		Key:                                 key(op.Scope, op.Key),
		ConditionExpression:                 aws.String("fence = :fence AND expires_at > :now AND #state = :in_flight"),
		UpdateExpression:                    aws.String(update),
		ExpressionAttributeNames:            map[string]string{"#state": "state"},
		ExpressionAttributeValues:           values,
		ReturnValuesOnConditionCheckFailure: types.ReturnValuesOnConditionCheckFailureAllOld,
	})
	if err == nil {
		return anyonce.CompleteOK, nil
	}
	item, refused := refusal(err)
	if !refused {
		return "", fmt.Errorf("dynamodb: complete: %w", err)
	}
	if item == nil {
		return anyonce.CompleteNotFound, nil
	}
	row := itemToRow(item)
	switch {
	case row.ExpiresAt <= nowMs:
		return anyonce.CompleteNotFound, nil
	case row.Fence != fence:
		return anyonce.CompleteStaleFence, nil
	default:
		// The row is already completed at this fence: completing twice is idempotent.
		return anyonce.CompleteOK, nil
	}
}

// Abandon deletes the in-flight row if the fence still holds.
func (s *Store) Abandon(ctx context.Context, op anyonce.Operation, fence int64) (anyonce.CompleteStatus, error) {
	_, err := s.client.DeleteItem(ctx, &awsdynamodb.DeleteItemInput{
		TableName:           aws.String(s.table),
		Key:                 key(op.Scope, op.Key),
		ConditionExpression: aws.String("fence = :fence AND #state = :in_flight"),
		ExpressionAttributeNames: map[string]string{
			"#state": "state",
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":fence":     num(fence),
			":in_flight": str(inFlight),
		},
		ReturnValuesOnConditionCheckFailure: types.ReturnValuesOnConditionCheckFailureAllOld,
	})
	if err == nil {
		return anyonce.CompleteOK, nil
	}
	item, refused := refusal(err)
	if !refused {
		return "", fmt.Errorf("dynamodb: abandon: %w", err)
	}
	if item == nil {
		return anyonce.CompleteNotFound, nil
	}
	row := itemToRow(item)
	if row.State != inFlight {
		return anyonce.CompleteNotFound, nil
	}
	if row.Fence == fence {
		return anyonce.CompleteNotFound, nil
	}
	return anyonce.CompleteStaleFence, nil
}

// Get reads the record with a strongly consistent read; a row past its expires_at counts as absent.
func (s *Store) Get(ctx context.Context, scope, k string, now time.Time) (*anyonce.Record, error) {
	out, err := s.client.GetItem(ctx, &awsdynamodb.GetItemInput{
		TableName:      aws.String(s.table),
		Key:            key(scope, k),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("dynamodb: get: %w", err)
	}
	if out.Item == nil {
		return nil, nil
	}
	row := itemToRow(out.Item)
	if row.ExpiresAt <= now.UnixMilli() {
		return nil, nil
	}
	record := rowcodec.ToRecord(row)
	return &record, nil
}

// Purge is a no-op that returns 0: the native ttl attribute sweeps expired items (REQ-ST-DDB-1).
func (s *Store) Purge(context.Context, time.Time) (int, error) {
	return 0, nil
}

// PhysicallyRemove deletes the item unconditionally, which is what a TTL sweep does. Test-only.
func (s *Store) PhysicallyRemove(ctx context.Context, scope, k string) error {
	if _, err := s.client.DeleteItem(ctx, &awsdynamodb.DeleteItemInput{TableName: aws.String(s.table), Key: key(scope, k)}); err != nil {
		return fmt.Errorf("dynamodb: physically remove: %w", err)
	}
	return nil
}

// EnsureTable creates the table with the single pk string partition key and on-demand billing, waits for it to
// become active, then enables TTL on the ttl attribute. It is idempotent. Meant for tests and local
// development; a production table comes from infrastructure code.
func EnsureTable(ctx context.Context, client *awsdynamodb.Client, table string) error {
	if table == "" {
		table = DefaultTable
	}
	_, err := client.CreateTable(ctx, &awsdynamodb.CreateTableInput{
		TableName:   aws.String(table),
		BillingMode: types.BillingModePayPerRequest,
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS},
		},
		KeySchema: []types.KeySchemaElement{
			{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash},
		},
	})
	if err != nil {
		var inUse *types.ResourceInUseException
		if !errors.As(err, &inUse) {
			return fmt.Errorf("dynamodb: create table %s: %w", table, err)
		}
	}
	waiter := awsdynamodb.NewTableExistsWaiter(client)
	if err := waiter.Wait(ctx, &awsdynamodb.DescribeTableInput{TableName: aws.String(table)}, 30*time.Second); err != nil {
		return fmt.Errorf("dynamodb: wait for table %s: %w", table, err)
	}
	_, err = client.UpdateTimeToLive(ctx, &awsdynamodb.UpdateTimeToLiveInput{
		TableName:               aws.String(table),
		TimeToLiveSpecification: &types.TimeToLiveSpecification{AttributeName: aws.String("ttl"), Enabled: aws.Bool(true)},
	})
	if err != nil {
		// Already enabled: DynamoDB answers with a ValidationException naming the current state. The SDK models
		// no Go type for it, so the message is what identifies it, as in the TypeScript store.
		if strings.Contains(strings.ToLower(err.Error()), "timetolive is already enabled") {
			return nil
		}
		return fmt.Errorf("dynamodb: enable ttl on %s: %w", table, err)
	}
	return nil
}
