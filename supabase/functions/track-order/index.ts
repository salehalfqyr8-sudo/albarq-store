
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json(405, { error: 'METHOD_NOT_ALLOWED' });
  }

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!url || !serviceKey) {
    return json(500, { error: 'SERVER_CONFIGURATION' });
  }

  let body: Record<string, unknown>;

  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'INVALID_REQUEST' });
  }

  const orderId = typeof body.order_id === 'string'
    ? body.order_id.trim()
    : '';

  const token = typeof body.tracking_token === 'string'
    ? body.tracking_token.trim()
    : '';

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId) ||
    !/^[0-9a-f]{64}$/i.test(token)
  ) {
    return json(400, { error: 'INVALID_TRACKING_DETAILS' });
  }

  try {
    const client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const tokenHash = await sha256(token);

    const { data, error } = await client
      .from('orders')
      .select('id, status, payment_status, created_at, updated_at')
      .eq('id', orderId)
      .eq('tracking_token_hash', tokenHash)
      .maybeSingle();

    if (error) {
      console.error('Order tracking lookup failed:', error.code);
      return json(500, { error: 'TRACKING_UNAVAILABLE' });
    }

    if (!data) {
      return json(404, {
        error: 'ORDER_NOT_FOUND',
        message: 'رقم الطلب أو رمز التتبّع غير صحيح.',
      });
    }

    return json(200, {
      order: {
        id: data.id,
        status: data.status,
        payment_status: data.payment_status,
        created_at: data.created_at,
        updated_at: data.updated_at,
      },
    });
  } catch {
    return json(500, { error: 'TRACKING_UNAVAILABLE' });
  }
});
