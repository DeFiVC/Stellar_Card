// Unit tests for secure in-memory zeroization of secret keys (#687).
import { describe, it, expect } from 'vitest';
import { zeroizeSecret } from '../ows';

describe('zeroizeSecret', () => {
  it('fills a Uint8Array with zeros in place', () => {
    const secret = new Uint8Array([1, 2, 3, 4, 255]);
    zeroizeSecret(secret);
    expect(Array.from(secret)).toEqual([0, 0, 0, 0, 0]);
  });

  it('zeroizes a Buffer (a Uint8Array subclass)', () => {
    const secret = Buffer.from([10, 20, 30, 40]);
    zeroizeSecret(secret);
    expect(Array.from(secret)).toEqual([0, 0, 0, 0]);
    expect(secret.toString('hex')).toBe('00000000');
  });

  it('handles an empty buffer without throwing', () => {
    const secret = new Uint8Array(0);
    expect(() => zeroizeSecret(secret)).not.toThrow();
    expect(secret.byteLength).toBe(0);
  });
});