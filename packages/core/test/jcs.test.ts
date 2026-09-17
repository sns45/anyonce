import { describe, expect, test } from 'bun:test';
import { canonicalize, JcsError } from '../src/jcs';

/** Decodes an IEEE 754 double from its 16 hex digit big-endian representation. */
function fromHex(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 8; i++) view.setUint8(i, Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  return view.getFloat64(0);
}

describe('canonicalize', () => {
  test('REQ-CORE-4: RFC 8785 section 3.2.3 example canonicalizes byte for byte', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    );
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  test('REQ-CORE-4: object keys sort by UTF-16 code units, not locale', () => {
    expect(canonicalize({ b: 1, a: 2, é: 3, B: 4, '10': 5, '9': 6 })).toBe(
      '{"10":5,"9":6,"B":4,"a":2,"b":1,"é":3}',
    );
  });

  test('REQ-CORE-4: nested structures, empty containers and strings with control characters', () => {
    expect(canonicalize({ z: [{ y: {} }, []], a: 'tab\there\x01' })).toBe(
      '{"a":"tab\\there\\u0001","z":[{"y":{}},[]]}',
    );
  });

  test('REQ-CORE-4: undefined properties are dropped, matching JSON.stringify', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  const numbers: Array<[string, string]> = [
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['41b3de4355555555', '333333333.3333333'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['44b52d02c7e14af6', '1e+23'],
  ];
  for (const [hex, expected] of numbers) {
    test(`REQ-CORE-4: number ${hex} serializes as ${expected}`, () => {
      expect(canonicalize(fromHex(hex))).toBe(expected);
    });
  }

  test('REQ-CORE-4: non-finite numbers, undefined, bigint and functions throw JcsError', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(JcsError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(JcsError);
    expect(() => canonicalize(undefined)).toThrow(JcsError);
    expect(() => canonicalize(10n)).toThrow(JcsError);
    expect(() => canonicalize(() => 1)).toThrow(JcsError);
    expect(() => canonicalize([undefined])).toThrow(JcsError);
  });

  test('REQ-CORE-4: a sparse array canonicalizes holes as null', () => {
    // Built by index rather than written as [1, , 3] so the linter's sparse array rule stays happy.
    const sparse: unknown[] = [];
    sparse[0] = 1;
    sparse[2] = 3;
    expect(1 in sparse).toBe(false);
    expect(canonicalize(sparse)).toBe('[1,null,3]');
    expect(canonicalize(sparse)).toBe(JSON.stringify(sparse));
    const allHoles: unknown[] = [];
    allHoles.length = 2;
    expect(canonicalize(allHoles)).toBe('[null,null]');
    expect(canonicalize({ a: sparse })).toBe('{"a":[1,null,3]}');
  });

  test('REQ-CORE-4: toJSON is honored like JSON.stringify', () => {
    expect(canonicalize({ d: new Date(0) })).toBe('{"d":"1970-01-01T00:00:00.000Z"}');
  });
});
