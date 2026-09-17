package anyonce_test

import (
	"encoding/json"
	"math"
	"strconv"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

func fromHex(t *testing.T, hex string) float64 {
	t.Helper()
	bits, err := strconv.ParseUint(hex, 16, 64)
	if err != nil {
		t.Fatal(err)
	}
	return math.Float64frombits(bits)
}

func TestCanonicalize(t *testing.T) {
	t.Run("REQ-CORE-4: RFC 8785 section 3.2.3 example canonicalizes byte for byte", func(t *testing.T) {
		var input any
		text := "{\"numbers\":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],\"string\":\"\\u20ac$\\u000F\\u000aA'\\u0042\\u0022\\u005c\\\\\\\"\\/\",\"literals\":[null,true,false]}"
		if err := json.Unmarshal([]byte(text), &input); err != nil {
			t.Fatal(err)
		}
		got, err := anyonce.Canonicalize(input)
		if err != nil {
			t.Fatal(err)
		}
		want := "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}"
		if string(got) != want {
			t.Fatalf("got  %s\nwant %s", got, want)
		}
	})

	t.Run("REQ-CORE-4: object keys sort by UTF-16 code units", func(t *testing.T) {
		got, err := anyonce.Canonicalize(map[string]any{"b": 1, "a": 2, "é": 3, "B": 4, "10": 5, "9": 6})
		if err != nil || string(got) != "{\"10\":5,\"9\":6,\"B\":4,\"a\":2,\"b\":1,\"é\":3}" {
			t.Fatalf("got %s, %v", got, err)
		}
	})

	t.Run("REQ-CORE-4: nested structures, empty containers, control characters, no HTML escaping", func(t *testing.T) {
		got, err := anyonce.Canonicalize(map[string]any{"z": []any{map[string]any{"y": map[string]any{}}, []any{}}, "a": "tab\there\x01<&>"})
		if err != nil || string(got) != "{\"a\":\"tab\\there\\u0001<&>\",\"z\":[{\"y\":{}},[]]}" {
			t.Fatalf("got %s, %v", got, err)
		}
	})

	t.Run("REQ-CORE-4: structs and integers go through encoding/json first", func(t *testing.T) {
		type payload struct {
			Amount int    `json:"amount"`
			ID     string `json:"id"`
		}
		got, err := anyonce.Canonicalize(payload{Amount: 5, ID: "x"})
		if err != nil || string(got) != `{"amount":5,"id":"x"}` {
			t.Fatalf("got %s, %v", got, err)
		}
	})

	numbers := []struct{ hex, want string }{
		{"0000000000000000", "0"},
		{"8000000000000000", "0"},
		{"0000000000000001", "5e-324"},
		{"7fefffffffffffff", "1.7976931348623157e+308"},
		{"4340000000000000", "9007199254740992"},
		{"444b1ae4d6e2ef4f", "999999999999999900000"},
		{"444b1ae4d6e2ef50", "1e+21"},
		{"3eb0c6f7a0b5ed8d", "0.000001"},
		{"3eb0c6f7a0b5ed8c", "9.999999999999997e-7"},
		{"41b3de4355555555", "333333333.3333333"},
		{"becbf647612f3696", "-0.0000033333333333333333"},
		{"44b52d02c7e14af6", "1e+23"},
	}
	for _, tc := range numbers {
		t.Run("REQ-CORE-4: number "+tc.hex+" serializes as "+tc.want, func(t *testing.T) {
			got, err := anyonce.Canonicalize(fromHex(t, tc.hex))
			if err != nil || string(got) != tc.want {
				t.Fatalf("got %s, %v; want %s", got, err, tc.want)
			}
		})
	}

	t.Run("REQ-CORE-4: non-finite numbers and unsupported values are errors", func(t *testing.T) {
		for _, v := range []any{math.NaN(), math.Inf(1), func() {}, make(chan int)} {
			if _, err := anyonce.Canonicalize(v); err == nil {
				t.Fatalf("expected error for %T", v)
			}
		}
	})
}
