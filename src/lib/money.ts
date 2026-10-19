import type { Currency } from './types';
export function formatMoney(amount: number, currency: Currency): string {
  return new Intl.NumberFormat('ar', { maximumFractionDigits: 2 }).format(amount) + (currency === 'SAR' ? ' ر.س' : ' ر.ي');
}
export function unitPrice(product: { price_sar: number; price_yer: number }, currency: Currency): number {
  return currency === 'SAR' ? Number(product.price_sar) : Number(product.price_yer);
}
