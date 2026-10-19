export type Currency = 'SAR' | 'YER';
export type PaymentMethod = 'kuraimi_haseb' | 'kuraimi_transfer' | 'other_transfer' | 'whatsapp';
export type Product = {
  id: string; name: string; category: string; description: string | null;
  price_sar: number; price_yer: number; image_url: string | null; emoji: string | null;
  active: boolean; stock: number; created_at: string;
};
export type CartLine = { product: Product; quantity: number };
