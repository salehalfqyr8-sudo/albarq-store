import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};
const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
const allowedCurrencies = new Set(['SAR', 'YER']);
const allowedPayments = new Set(['kuraimi_haseb', 'kuraimi_transfer', 'other_transfer', 'whatsapp']);

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED', message: 'طريقة الطلب غير مدعومة.' });

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    console.error('Missing required server environment configuration');
    return json(500, { error: 'SERVER_CONFIGURATION', message: 'الخدمة غير جاهزة حاليًا. يرجى المحاولة لاحقًا.' });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'INVALID_JSON', message: 'بيانات الطلب غير صالحة.' }); }

  const customerName = typeof body.customer_name === 'string' ? body.customer_name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
  const currency = body.currency;
  const paymentMethod = body.payment_method;
  const key = body.idempotency_key;
  const items = body.items;
  if (customerName.length < 2 || customerName.length > 120 || phone.length < 7 || phone.length > 30 || address.length < 5 || address.length > 1000 || notes.length > 2000) {
    return json(400, { error: 'INVALID_CUSTOMER_DATA', message: 'تحقق من الاسم ورقم الهاتف والعنوان.' });
  }
  if (!allowedCurrencies.has(String(currency)) || !allowedPayments.has(String(paymentMethod))) return json(400, { error: 'INVALID_OPTIONS', message: 'العملة أو طريقة الدفع غير مدعومة.' });
  if (typeof key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) return json(400, { error: 'INVALID_REQUEST_KEY', message: 'تعذر التحقق من الطلب. حدّث الصفحة وحاول مجددًا.' });
  if (!Array.isArray(items) || items.length < 1 || items.length > 30 || items.some((x) => !x || typeof x !== 'object' || typeof x.product_id !== 'string' || !Number.isInteger(x.quantity) || x.quantity < 1 || x.quantity > 99)) {
    return json(400, { error: 'INVALID_ITEMS', message: 'قائمة المنتجات أو الكميات غير صالحة.' });
  }
  const productIds = items.map((item: { product_id: string }) => item.product_id);
  if (new Set(productIds).size !== productIds.length) return json(400, { error: 'DUPLICATE_PRODUCTS', message: 'يوجد منتج مكرر في الطلب. حدّث السلة وحاول مجددًا.' });

  // Never trust browser prices, totals, names, or stock. The SQL transaction reads and locks current products.
  const forwarded = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { data: allowed, error: rateError } = await client.rpc('consume_order_rate_limit', { p_ip_hash: await sha256(forwarded) });
    if (rateError) { console.error('Rate limit check failed:', rateError.code); return json(503, { error: 'TEMPORARY_UNAVAILABLE', message: 'الخدمة مشغولة مؤقتًا. حاول بعد قليل.' }); }
    if (allowed !== true) return json(429, { error: 'RATE_LIMITED', message: 'تم إرسال طلبات كثيرة خلال وقت قصير. انتظر قليلًا ثم حاول.' });

    const { data, error } = await client.rpc('create_order_transaction', {
      p_customer_name: customerName, p_phone: phone, p_address: address, p_notes: notes,
      p_currency: currency, p_payment_method: paymentMethod, p_idempotency_key: key,
      p_items: items.map((item: { product_id: string; quantity: number }) => ({ product_id: item.product_id, quantity: item.quantity })),
    });
    if (error) {
      console.error('Order transaction rejected:', { code: error.code, message: error.message });
      const known: Record<string, [number, string]> = {
        PRODUCT_UNAVAILABLE: [409, 'أحد المنتجات لم يعد متوفرًا. حدّث الصفحة وتحقق من السلة.'],
        INSUFFICIENT_STOCK: [409, 'الكمية المطلوبة غير متوفرة حاليًا. حدّث السلة وحاول مجددًا.'],
        INVALID_QUANTITY: [400, 'إحدى الكميات غير صالحة.'],
        INVALID_ITEMS: [400, 'قائمة المنتجات غير صالحة.'],
      };
      const match = Object.entries(known).find(([code]) => error.message.includes(code));
      if (match) return json(match[1][0], { error: match[0], message: match[1][1] });
      return json(400, { error: 'ORDER_NOT_CREATED', message: 'لم يتم حفظ الطلب. لم تُمسح السلة؛ تحقق من البيانات وحاول مجددًا.' });
    }
    if (!data?.order_id) {
  console.error('RPC returned no order id');
  return json(500, {
    error: 'ORDER_NOT_CONFIRMED',
    message: 'لم نستطع تأكيد حفظ الطلب.'
  });
}

const trackingToken = Array.from(
  crypto.getRandomValues(new Uint8Array(32)),
  (b) => b.toString(16).padStart(2, '0')
).join('');

const trackingHash = await sha256(trackingToken);

const { data: trackedOrder, error: trackingError } = await client
  .from('orders')
  .update({ tracking_token_hash: trackingHash })
  .eq('id', data.order_id)
  .eq('idempotency_key', key)
  .select('id')
  .maybeSingle();

if (trackingError || !trackedOrder) {
  console.error('Tracking token save failed:', trackingError?.code);
  return json(500, {
    error: 'TRACKING_SETUP_FAILED',
    message: 'تمت معالجة الطلب، لكن تعذّر تجهيز التتبع. حاول مجددًا.'
  });
}

return json(200, {
  order_id: data.order_id,
  tracking_token: trackingToken,
  duplicate: data.duplicate === true
});
  } catch (error) {
    console.error('Unexpected create-order failure:', error instanceof Error ? error.name : 'unknown');
    return json(500, { error: 'UNEXPECTED_ERROR', message: 'حدث خطأ غير متوقع. بقيت السلة محفوظة؛ حاول مجددًا.' });
  }
});
