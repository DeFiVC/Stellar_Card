// Unit tests for buildTransactionMemo (#739) — type-safe Stellar memo
// construction with byte-accurate length validation.

import { describe, it, expect } from 'vitest';
import { Memo } from '@stellar/stellar-sdk';
import { buildTransactionMemo, MEMO_TEXT_MAX_BYTES, MEMO_HASH_BYTES } from '../stellar';
import { InvalidMemoError } from '../errors';

describe('buildTransactionMemo — text', () => {
  it('builds a MEMO_TEXT from a short ASCII string', () => {
    const memo = buildTransactionMemo('text', 'order-4821');
    expect(memo.type).toBe('text');
    expect(memo.value).toBe('order-4821');
  });

  it('accepts a string exactly at the 28-byte limit', () => {
    const value = 'a'.repeat(MEMO_TEXT_MAX_BYTES);
    const memo = buildTransactionMemo('text', value);
    expect(memo.value).toBe(value);
  });

  it('rejects an ASCII string one byte over the limit', () => {
    const value = 'a'.repeat(MEMO_TEXT_MAX_BYTES + 1);
    expect(() => buildTransactionMemo('text', value)).toThrow(InvalidMemoError);
  });

  it('validates by UTF-8 byte length, not character count, for multi-byte text', () => {
    // Each 'é' is 2 bytes in UTF-8 — 14 of them is exactly 28 bytes, 15 is 30.
    const fits = 'é'.repeat(14);
    const overflows = 'é'.repeat(15);
    expect(Buffer.byteLength(fits, 'utf-8')).toBe(28);
    expect(() => buildTransactionMemo('text', fits)).not.toThrow();
    expect(() => buildTransactionMemo('text', overflows)).toThrow(InvalidMemoError);
  });

  it('rejects emoji text that is short in characters but long in bytes', () => {
    // Each emoji below is 4 UTF-8 bytes; 8 of them is 32 bytes > 28.
    const emoji = '🚀'.repeat(8);
    expect(emoji.length).toBeLessThan(MEMO_TEXT_MAX_BYTES);
    expect(() => buildTransactionMemo('text', emoji)).toThrow(InvalidMemoError);
  });

  it('includes the byte count in the thrown error message', () => {
    const value = 'a'.repeat(40);
    try {
      buildTransactionMemo('text', value);
      expect.unreachable('expected buildTransactionMemo to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidMemoError);
      expect((err as InvalidMemoError).message).toContain('40 bytes');
    }
  });

  it('rejects a non-string value for memo type text', () => {
    expect(() => buildTransactionMemo('text', 123 as unknown as string)).toThrow(InvalidMemoError);
  });

  it('accepts an empty string', () => {
    const memo = buildTransactionMemo('text', '');
    expect(memo.value).toBe('');
  });
});

describe('buildTransactionMemo — id', () => {
  it('builds a MEMO_ID from a number', () => {
    const memo = buildTransactionMemo('id', 42);
    expect(memo.type).toBe('id');
    expect(memo.value).toBe('42');
  });

  it('builds a MEMO_ID from a numeric string', () => {
    const memo = buildTransactionMemo('id', '123456789');
    expect(memo.value).toBe('123456789');
  });

  it('builds a MEMO_ID from a bigint', () => {
    const memo = buildTransactionMemo('id', 18446744073709551615n);
    expect(memo.value).toBe('18446744073709551615');
  });

  it('accepts zero', () => {
    const memo = buildTransactionMemo('id', 0);
    expect(memo.value).toBe('0');
  });

  it('rejects a negative number', () => {
    expect(() => buildTransactionMemo('id', -1)).toThrow(InvalidMemoError);
  });

  it('rejects a non-integer number', () => {
    expect(() => buildTransactionMemo('id', 1.5)).toThrow(InvalidMemoError);
  });

  it('rejects a value exceeding uint64 max', () => {
    expect(() => buildTransactionMemo('id', 18446744073709551616n)).toThrow(InvalidMemoError);
  });

  it('rejects a non-numeric string', () => {
    expect(() => buildTransactionMemo('id', 'not-a-number')).toThrow(InvalidMemoError);
  });

  it('rejects a string with a negative sign', () => {
    expect(() => buildTransactionMemo('id', '-5')).toThrow(InvalidMemoError);
  });
});

describe('buildTransactionMemo — hash', () => {
  const validHashHex = 'a'.repeat(MEMO_HASH_BYTES * 2);
  const validHashBuffer = Buffer.from(validHashHex, 'hex');

  it('builds a MEMO_HASH from a 32-byte Buffer', () => {
    const memo = buildTransactionMemo('hash', validHashBuffer);
    expect(memo.type).toBe('hash');
  });

  it('builds a MEMO_HASH from a 32-byte Uint8Array', () => {
    const memo = buildTransactionMemo('hash', new Uint8Array(validHashBuffer));
    expect(memo.type).toBe('hash');
  });

  it('builds a MEMO_HASH from a 64-character hex string', () => {
    const memo = buildTransactionMemo('hash', validHashHex);
    expect(memo.type).toBe('hash');
  });

  it('round-trips the exact bytes through the SDK Memo value', () => {
    const memo = buildTransactionMemo('hash', validHashBuffer);
    const builtViaSdk = Memo.hash(validHashHex);
    expect(Buffer.from(memo.value as Buffer).equals(Buffer.from(builtViaSdk.value as Buffer))).toBe(
      true,
    );
  });

  it('rejects a buffer shorter than 32 bytes', () => {
    expect(() => buildTransactionMemo('hash', Buffer.alloc(16))).toThrow(InvalidMemoError);
  });

  it('rejects a buffer longer than 32 bytes', () => {
    expect(() => buildTransactionMemo('hash', Buffer.alloc(64))).toThrow(InvalidMemoError);
  });

  it('rejects an odd-length hex string', () => {
    expect(() => buildTransactionMemo('hash', 'abc')).toThrow(InvalidMemoError);
  });

  it('rejects a non-hex string', () => {
    expect(() => buildTransactionMemo('hash', 'z'.repeat(64))).toThrow(InvalidMemoError);
  });

  it('rejects an unsupported value type', () => {
    expect(() => buildTransactionMemo('hash', 42 as unknown as Buffer)).toThrow(InvalidMemoError);
  });
});

describe('buildTransactionMemo — return', () => {
  const validHashHex = 'b'.repeat(MEMO_HASH_BYTES * 2);

  it('builds a MEMO_RETURN from a 32-byte hex string', () => {
    const memo = buildTransactionMemo('return', validHashHex);
    expect(memo.type).toBe('return');
  });

  it('rejects an incorrectly-sized buffer', () => {
    expect(() => buildTransactionMemo('return', Buffer.alloc(10))).toThrow(InvalidMemoError);
  });
});

describe('buildTransactionMemo — invalid memo type', () => {
  it('throws InvalidMemoError for an unknown memo type', () => {
    expect(() => buildTransactionMemo('bogus' as unknown as 'text', 'value')).toThrow(
      InvalidMemoError,
    );
  });
});
