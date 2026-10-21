import { describe, it, expect } from 'vitest';
import { stroopsToDecimal, parseCurrencyAmount } from '../stellar';
import { decimalToStroops } from '../soroban';
import { InvalidAmountError } from '../errors';

describe('stroopsToDecimal', () => {
  it('converts whole stroops to decimal', () => {
    expect(stroopsToDecimal(10_000_000n)).toBe('1');
    expect(stroopsToDecimal(100_000_000n)).toBe('10');
    expect(stroopsToDecimal(1_000_000_000n)).toBe('100');
  });

  it('converts fractional stroops to decimal with precision', () => {
    expect(stroopsToDecimal(1n)).toBe('0.0000001');
    expect(stroopsToDecimal(10n)).toBe('0.000001');
    expect(stroopsToDecimal(100n)).toBe('0.00001');
    expect(stroopsToDecimal(1000n)).toBe('0.0001');
    expect(stroopsToDecimal(10000n)).toBe('0.001');
    expect(stroopsToDecimal(100000n)).toBe('0.01');
    expect(stroopsToDecimal(1000000n)).toBe('0.1');
  });

  it('converts mixed stroops to decimal', () => {
    expect(stroopsToDecimal(12_345_678n)).toBe('1.2345678');
    expect(stroopsToDecimal(50_000_000n)).toBe('5');
    expect(stroopsToDecimal(50_500_000n)).toBe('5.05');
    expect(stroopsToDecimal(50_000_500n)).toBe('5.00005');
  });

  it('removes trailing zeros from fractional part', () => {
    expect(stroopsToDecimal(10_000_000n)).toBe('1');
    expect(stroopsToDecimal(10_100_000n)).toBe('1.01');
    expect(stroopsToDecimal(10_010_000n)).toBe('1.001');
    expect(stroopsToDecimal(10_001_000n)).toBe('1.0001');
    expect(stroopsToDecimal(10_000_100n)).toBe('1.00001');
  });

  it('handles zero stroops', () => {
    expect(stroopsToDecimal(0n)).toBe('0');
  });

  it('handles large amounts', () => {
    expect(stroopsToDecimal(1_000_000_000_000n)).toBe('100000');
    expect(stroopsToDecimal(999_999_999_999n)).toBe('99999.9999999');
  });

  it('accepts number input', () => {
    expect(stroopsToDecimal(10_000_000)).toBe('1');
    expect(stroopsToDecimal(100_000_000)).toBe('10');
  });

  it('accepts string input', () => {
    expect(stroopsToDecimal('10000000')).toBe('1');
    expect(stroopsToDecimal('100000000')).toBe('10');
  });

  it('throws on negative stroops', () => {
    expect(() => stroopsToDecimal(-1n)).toThrow(InvalidAmountError);
    expect(() => stroopsToDecimal(-100_000_000n)).toThrow(InvalidAmountError);
    expect(() => stroopsToDecimal(-1)).toThrow(InvalidAmountError);
    expect(() => stroopsToDecimal('-1000000')).toThrow(InvalidAmountError);
  });

  it('throws on invalid input', () => {
    expect(() => stroopsToDecimal('not-a-number' as unknown as string)).toThrow(InvalidAmountError);
    expect(() => stroopsToDecimal('12.34')).toThrow(InvalidAmountError);
    expect(() => stroopsToDecimal(NaN as unknown as number)).toThrow(InvalidAmountError);
  });

  it('round-trips with decimalToStroops', () => {
    const amounts = ['1.0', '10.00', '0.0000001', '1.2345678', '100.50'];
    for (const amount of amounts) {
      const stroops = decimalToStroops(amount);
      const back = stroopsToDecimal(stroops);
      expect(back).toBe(amount);
    }
  });
});

describe('parseCurrencyAmount', () => {
  it('parses plain numeric strings', () => {
    expect(parseCurrencyAmount('10')).toBe('10');
    expect(parseCurrencyAmount('10.50')).toBe('10.50');
    expect(parseCurrencyAmount('0.0000001')).toBe('0.0000001');
    expect(parseCurrencyAmount('100.50')).toBe('100.50');
  });

  it('parses currency symbols', () => {
    expect(parseCurrencyAmount('$10.50')).toBe('10.50');
    expect(parseCurrencyAmount('$100')).toBe('100');
    expect(parseCurrencyAmount('€50.25')).toBe('50.25');
    expect(parseCurrencyAmount('£100.00')).toBe('100.00');
    expect(parseCurrencyAmount('¥5000')).toBe('5000');
  });

  it('parses asset codes (XLM, USDC)', () => {
    expect(parseCurrencyAmount('10 XLM')).toBe('10');
    expect(parseCurrencyAmount('50.5 USDC')).toBe('50.5');
    expect(parseCurrencyAmount('100 xlm')).toBe('100');
    expect(parseCurrencyAmount('25 usdc')).toBe('25');
  });

  it('parses currency symbol with asset code', () => {
    expect(parseCurrencyAmount('$10 USDC')).toBe('10');
    expect(parseCurrencyAmount('$50.50 USD')).toBe('50.50');
  });

  it('handles whitespace', () => {
    expect(parseCurrencyAmount('  10  ')).toBe('10');
    expect(parseCurrencyAmount('  10.50  ')).toBe('10.50');
    expect(parseCurrencyAmount('$  10.50  ')).toBe('10.50');
    expect(parseCurrencyAmount('10   XLM')).toBe('10');
  });

  it('uses default asset when specified', () => {
    expect(parseCurrencyAmount('42.5', 'XLM')).toBe('42.5');
    expect(parseCurrencyAmount('100', 'USDC')).toBe('100');
  });

  it('throws on empty input', () => {
    expect(() => parseCurrencyAmount('')).toThrow(InvalidAmountError);
    expect(() => parseCurrencyAmount('   ')).toThrow(InvalidAmountError);
  });

  it('throws on non-string input', () => {
    expect(() => parseCurrencyAmount(123 as unknown as string)).toThrow(InvalidAmountError);
    expect(() => parseCurrencyAmount(null as unknown as string)).toThrow(InvalidAmountError);
  });

  it('throws on invalid numeric format', () => {
    expect(() => parseCurrencyAmount('not-a-number')).toThrow(InvalidAmountError);
    expect(() => parseCurrencyAmount('10.50.25')).toThrow(InvalidAmountError);
    expect(() => parseCurrencyAmount('10,000')).toThrow(InvalidAmountError);
  });

  it('throws on negative amounts', () => {
    expect(() => parseCurrencyAmount('-10')).toThrow(InvalidAmountError);
    expect(() => parseCurrencyAmount('-$10.50')).toThrow(InvalidAmountError);
  });

  it('throws on zero amount', () => {
    expect(() => parseCurrencyAmount('0')).toThrow(InvalidAmountError);
    expect(() => parseCurrencyAmount('$0')).toThrow(InvalidAmountError);
    expect(() => parseCurrencyAmount('0.00')).toThrow(InvalidAmountError);
  });

  it('handles multiple currency symbols', () => {
    expect(parseCurrencyAmount('₹500')).toBe('500');
    expect(parseCurrencyAmount('₽100')).toBe('100');
    expect(parseCurrencyAmount('₩5000')).toBe('5000');
    expect(parseCurrencyAmount('₪100')).toBe('100');
    expect(parseCurrencyAmount('₦1000')).toBe('1000');
  });

  it('parses large amounts', () => {
    expect(parseCurrencyAmount('999999.9999999')).toBe('999999.9999999');
    expect(parseCurrencyAmount('$1000000.00')).toBe('1000000.00');
    expect(parseCurrencyAmount('1000000 XLM')).toBe('1000000');
  });

  it('parses amounts with many decimal places', () => {
    expect(parseCurrencyAmount('10.1234567890')).toBe('10.1234567890');
  });
});

describe('decimalToStroops and stroopsToDecimal integration', () => {
  it('round-trips various amounts', () => {
    const testAmounts = [
      '0.0000001', // minimum
      '0.0000010',
      '0.0001',
      '0.001',
      '0.01',
      '0.1',
      '1',
      '1.00',
      '1.0000001',
      '10.50',
      '100.00',
      '1000.1234567',
      '10000.0000001',
    ];

    for (const amount of testAmounts) {
      const stroops = decimalToStroops(amount);
      const back = stroopsToDecimal(stroops);
      expect(back).toBe(amount);
    }
  });

  it('converts between decimal and stroops consistently', () => {
    // XLM amounts
    expect(decimalToStroops('1')).toBe(10_000_000n);
    expect(stroopsToDecimal(decimalToStroops('1'))).toBe('1');

    // USDC amounts
    expect(decimalToStroops('10.50')).toBe(105_000_000n);
    expect(stroopsToDecimal(decimalToStroops('10.50'))).toBe('10.50');

    // Large amounts
    expect(decimalToStroops('1000.50')).toBe(10_005_000_000n);
    expect(stroopsToDecimal(decimalToStroops('1000.50'))).toBe('1000.50');
  });
});
