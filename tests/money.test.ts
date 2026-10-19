import { describe, expect, it } from 'vitest';
import { formatMoney, unitPrice } from '../src/lib/money';

describe('money helpers', () => {
  it('selects the correct currency price', () => {
    expect(unitPrice({ price_sar: 12.5, price_yer: 3000 }, 'SAR')).toBe(12.5);
    expect(unitPrice({ price_sar: 12.5, price_yer: 3000 }, 'YER')).toBe(3000);
  });
  it('formats a price with a currency label', () => {
    expect(formatMoney(10, 'SAR')).toContain('ر.س');
    expect(formatMoney(10, 'YER')).toContain('ر.ي');
  });
});
