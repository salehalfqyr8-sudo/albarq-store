-- AL-BARQ initial schema. Apply only to a NEW Supabase project.
-- Keep secrets out of browser code. Run this migration once in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 160),
  category text not null check (char_length(trim(category)) between 1 and 100),
  description text not null default '' check (char_length(description) <= 5000),
  price_sar numeric(12,2) not null check (price_sar >= 0),
  price_yer numeric(14,2) not null check (price_yer >= 0),
  image_url text,
  emoji text not null default '🛍️',
  active boolean not null default true,
  stock integer not null default 0 check (stock >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_store_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admin_users a where a.user_id = (select auth.uid()));
$$;
revoke all on function public.is_store_admin() from public;
grant execute on function public.is_store_admin() to authenticated;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  customer_name text not null check (char_length(trim(customer_name)) between 2 and 120),
  phone text not null check (char_length(trim(phone)) between 7 and 30),
  address text not null check (char_length(trim(address)) between 5 and 1000),
  notes text not null default '' check (char_length(notes) <= 2000),
  currency text not null check (currency in ('SAR','YER')),
  payment_method text not null check (payment_method in ('kuraimi_haseb','kuraimi_transfer','other_transfer','whatsapp')),
  total numeric(14,2) not null check (total >= 0),
  status text not null default 'new' check (status in ('new','reviewing','approved','preparing','shipped','delivered','rejected')),
  payment_status text not null default 'unverified' check (payment_status in ('unverified','awaiting_transfer','proof_received','paid','failed')),
  payment_proof_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  quantity integer not null check (quantity between 1 and 99),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  line_total numeric(14,2) not null check (line_total >= 0),
  created_at timestamptz not null default now()
);

-- Fixed-window rate limit bucket, keyed by a SHA-256 hash of the caller IP.
create table if not exists public.order_rate_limits (
  ip_hash text not null,
  bucket_start timestamptz not null,
  request_count integer not null default 0,
  primary key (ip_hash, bucket_start)
);

create index if not exists products_active_created_idx on public.products(active, created_at desc);
create index if not exists products_category_idx on public.products(category);
create index if not exists orders_created_idx on public.orders(created_at desc);
create index if not exists orders_status_created_idx on public.orders(status, created_at desc);
create index if not exists order_items_order_id_idx on public.order_items(order_id);

alter table public.products enable row level security;
alter table public.admin_users enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_rate_limits enable row level security;

-- Public can only read active products. Only listed admins can manage products.
drop policy if exists "Public reads active products" on public.products;
create policy "Public reads active products" on public.products for select to anon, authenticated using (active = true or (select public.is_store_admin()));
drop policy if exists "Admins manage products" on public.products;
create policy "Admins manage products" on public.products for all to authenticated using ((select public.is_store_admin())) with check ((select public.is_store_admin()));

-- Admin can see their own admin membership, but clients cannot add themselves as admins.
drop policy if exists "Admins read own membership" on public.admin_users;
create policy "Admins read own membership" on public.admin_users for select to authenticated using (user_id = (select auth.uid()));

-- Customer PII is admin-only. Creation goes through the server-side Edge Function + RPC.
drop policy if exists "Admins read orders" on public.orders;
create policy "Admins read orders" on public.orders for select to authenticated using ((select public.is_store_admin()));
drop policy if exists "Admins update orders" on public.orders;
create policy "Admins update orders" on public.orders for update to authenticated using ((select public.is_store_admin())) with check ((select public.is_store_admin()));
drop policy if exists "Admins read order items" on public.order_items;
create policy "Admins read order items" on public.order_items for select to authenticated using ((select public.is_store_admin()));
-- No client-facing policies on order_rate_limits, and no public write policies on orders/order_items.

create or replace function public.consume_order_rate_limit(p_ip_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_bucket timestamptz := date_trunc('minute', now()) - make_interval(mins => (extract(minute from now())::int % 10));
  v_count integer;
begin
  if p_ip_hash is null or length(p_ip_hash) <> 64 then return false; end if;
  insert into public.order_rate_limits(ip_hash, bucket_start, request_count)
  values (p_ip_hash, v_bucket, 1)
  on conflict (ip_hash, bucket_start) do update
    set request_count = public.order_rate_limits.request_count + 1
  returning request_count into v_count;
  return v_count <= 8;
end;
$$;
revoke all on function public.consume_order_rate_limit(text) from public, anon, authenticated;
grant execute on function public.consume_order_rate_limit(text) to service_role;

-- Atomic order creation: server passes only product IDs and quantities. Prices are read here.
create or replace function public.create_order_transaction(
  p_customer_name text,
  p_phone text,
  p_address text,
  p_notes text,
  p_currency text,
  p_payment_method text,
  p_idempotency_key uuid,
  p_items jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order_id uuid;
  v_existing uuid;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_price numeric(14,2);
  v_total numeric(14,2) := 0;
  v_line_total numeric(14,2);
  v_count integer := 0;
  v_snapshot jsonb := '[]'::jsonb;
begin
  if p_idempotency_key is null then raise exception 'INVALID_IDEMPOTENCY_KEY'; end if;
  select id into v_existing from public.orders where idempotency_key = p_idempotency_key;
  if v_existing is not null then return jsonb_build_object('order_id', v_existing, 'duplicate', true); end if;
  if p_customer_name is null or char_length(trim(p_customer_name)) not between 2 and 120 then raise exception 'INVALID_CUSTOMER_NAME'; end if;
  if p_phone is null or char_length(trim(p_phone)) not between 7 and 30 then raise exception 'INVALID_PHONE'; end if;
  if p_address is null or char_length(trim(p_address)) not between 5 and 1000 then raise exception 'INVALID_ADDRESS'; end if;
  if char_length(coalesce(p_notes,'')) > 2000 then raise exception 'INVALID_NOTES'; end if;
  if p_currency not in ('SAR','YER') then raise exception 'INVALID_CURRENCY'; end if;
  if p_payment_method not in ('kuraimi_haseb','kuraimi_transfer','other_transfer','whatsapp') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 30 then raise exception 'INVALID_ITEMS'; end if;
  if (select count(distinct value->>'product_id') from jsonb_array_elements(p_items)) <> jsonb_array_length(p_items) then raise exception 'DUPLICATE_PRODUCTS'; end if;

  -- Lock products in stable UUID order to reduce deadlock risk.
  for v_item in select value from jsonb_array_elements(p_items) order by (value->>'product_id') loop
    if coalesce(v_item->>'product_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_PRODUCT_ID'; end if;
    if coalesce(v_item->>'quantity','') !~ '^[0-9]{1,2}$' then raise exception 'INVALID_QUANTITY'; end if;
    v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 or v_qty > 99 then raise exception 'INVALID_QUANTITY'; end if;
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid and active = true for update;
    if not found then raise exception 'PRODUCT_UNAVAILABLE'; end if;
    if v_product.stock < v_qty then raise exception 'INSUFFICIENT_STOCK'; end if;
    if p_currency = 'SAR' then v_price := v_product.price_sar; else v_price := v_product.price_yer; end if;
    v_line_total := round(v_price * v_qty, 2);
    v_total := v_total + v_line_total;
    v_count := v_count + 1;
    if v_count > 30 then raise exception 'TOO_MANY_ITEMS'; end if;
    v_snapshot := v_snapshot || jsonb_build_array(jsonb_build_object('product_id',v_product.id,'product_name',v_product.name,'quantity',v_qty,'unit_price',v_price,'line_total',v_line_total));
  end loop;

  insert into public.orders(idempotency_key, customer_name, phone, address, notes, currency, payment_method, total, payment_status)
  values (p_idempotency_key, trim(p_customer_name), trim(p_phone), trim(p_address), coalesce(trim(p_notes),''), p_currency, p_payment_method, v_total,
    case when p_payment_method = 'whatsapp' then 'unverified' else 'awaiting_transfer' end)
  returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(v_snapshot) loop
    insert into public.order_items(order_id, product_id, product_name, quantity, unit_price, line_total)
    values (v_order_id, (v_item->>'product_id')::uuid, v_item->>'product_name', (v_item->>'quantity')::integer, (v_item->>'unit_price')::numeric, (v_item->>'line_total')::numeric);
    update public.products set stock = stock - (v_item->>'quantity')::integer, updated_at = now() where id = (v_item->>'product_id')::uuid;
  end loop;
  return jsonb_build_object('order_id', v_order_id, 'duplicate', false);
end;
$$;
revoke all on function public.create_order_transaction(text,text,text,text,text,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.create_order_transaction(text,text,text,text,text,text,uuid,jsonb) to service_role;

-- Updated-at maintenance.
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at before update on public.products for each row execute function public.set_updated_at();
drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at before update on public.orders for each row execute function public.set_updated_at();

-- After creating the first admin account in Supabase Auth, add its UUID manually:
-- insert into public.admin_users(user_id) values ('AUTH_USER_UUID_HERE');
