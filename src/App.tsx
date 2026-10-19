import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Search, ShoppingBag, Zap, Plus, Minus, Trash2, X, ShieldCheck, PackageSearch } from 'lucide-react';
import { supabase } from './lib/supabase';
import { formatMoney, unitPrice } from './lib/money';
import type { CartLine, Currency, PaymentMethod, Product } from './lib/types';

const paymentLabels: Record<PaymentMethod, string> = {
  kuraimi_haseb: 'تواصل واتساب',
  kuraimi_transfer: 'تواصل واتساب',
  other_transfer: 'تواصل واتساب',
  whatsapp: 'تواصل واتساب',
};

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLine[]>(() => {
    try { return JSON.parse(localStorage.getItem('albarq-cart') || '[]') as CartLine[]; } catch { return []; }
  });
  const [currency, setCurrency] = useState<Currency>('YER');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('الكل');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const [notice, setNotice] = useState('');
  const [myOrders, setMyOrders] = useState<
    { order_id: string; tracking_token: string }[]
  >(() => {
    try {
      return JSON.parse(
        localStorage.getItem('albarq-my-orders') || '[]'
      );
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem('albarq-my-orders', JSON.stringify(myOrders));
  }, [myOrders]);
  const [orderStatuses, setOrderStatuses] = useState<
    Record<string, {
      status: string;
      payment_status: string;
      created_at: string;
      updated_at: string;
    } | null>
  >({});

  useEffect(() => {
    if (!supabase || myOrders.length === 0) return;

    let alive = true;

    async function loadOrderStatuses() {
      const results = await Promise.all(
        myOrders.map(async order => {
          const { data, error } = await supabase!.functions.invoke(
            'track-order',
            {
              body: {
                order_id: order.order_id,
                tracking_token: order.tracking_token,
              },
            }
          );

          if (error || !data?.order) {
            return [order.order_id, null] as const;
          }

          return [order.order_id, data.order] as const;
        })
      );

      if (alive) {
        setOrderStatuses(Object.fromEntries(results));
      }
    }

    void loadOrderStatuses();

    return () => {
      alive = false;
    };
  }, [myOrders]);
  async function refreshOrderStatuses() {
    if (!supabase || myOrders.length === 0) return;

    const results = await Promise.all(
      myOrders.map(async order => {
        const { data, error } = await supabase!.functions.invoke(
          'track-order',
          {
            body: {
              order_id: order.order_id,
              tracking_token: order.tracking_token,
            },
          }
        );

        if (error || !data?.order) {
          return [order.order_id, null] as const;
        }

        return [order.order_id, data.order] as const;
      })
    );

    setOrderStatuses(Object.fromEntries(results));
  }

  const [form, setForm] = useState({ customer_name: '', phone: '', address: '', notes: '', payment_method: 'whatsapp' as PaymentMethod });

  useEffect(() => { localStorage.setItem('albarq-cart', JSON.stringify(cart)); }, [cart]);
  useEffect(() => { idempotencyKey.current = sessionStorage.getItem('albarq-pending-order-key'); }, []);
  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true); setError('');
      if (!supabase) { setError('اربط المشروع بقاعدة Supabase من خلال ملف .env.local ثم أعد تشغيل الموقع.'); setLoading(false); return; }
      const { data, error: fetchError } = await supabase.from('products').select('id,name,category,description,price_sar,price_yer,image_url,emoji,active,stock,created_at').eq('active', true).order('created_at', { ascending: false });
      if (!alive) return;
      if (fetchError) setError('تعذر تحميل المنتجات. تحقق من الاتصال وإعدادات قاعدة البيانات ثم أعد المحاولة.');
      else setProducts((data ?? []) as Product[]);
      setLoading(false);
    }
    void load(); return () => { alive = false; };
  }, []);

  const categories = useMemo(() => ['الكل', ...Array.from(new Set(products.map(p => p.category).filter(Boolean)))], [products]);
  const visibleProducts = useMemo(() => products.filter(p => (category === 'الكل' || p.category === category) && `${p.name} ${p.description ?? ''} ${p.category}`.toLowerCase().includes(search.toLowerCase())), [products, category, search]);
  const count = cart.reduce((sum, line) => sum + line.quantity, 0);
  const total = cart.reduce((sum, line) => sum + unitPrice(line.product, currency) * line.quantity, 0);

  function add(product: Product) {
    if (product.stock < 1) { setNotice('هذا المنتج غير متوفر حاليًا.'); return; }
    setCart(old => {
      const existing = old.find(line => line.product.id === product.id);
      if (existing) return old.map(line => line.product.id === product.id ? { ...line, quantity: Math.min(product.stock, line.quantity + 1) } : line);
      return [...old, { product, quantity: 1 }];
    }); setNotice('أُضيف المنتج إلى السلة.');
  }
  function changeQty(id: string, delta: number) {
    setCart(old => old.map(line => line.product.id !== id ? line : { ...line, quantity: Math.max(1, Math.min(line.product.stock, line.quantity + delta)) }));
  }
  function remove(id: string) { setCart(old => old.filter(line => line.product.id !== id)); }
  function updateForm(key: keyof typeof form, value: string) { setForm(old => ({ ...old, [key]: value })); }

    async function submitOrder(e: FormEvent) {
    e.preventDefault();
    setNotice('');

    if (!supabase) {
      setNotice('قاعدة البيانات غير مهيأة بعد.');
      return;
    }
    if (!cart.length) {
      setNotice('السلة فارغة. أضف منتجًا قبل إرسال الطلب.');
      return;
    }
    if (
      form.customer_name.trim().length < 2 ||
      form.phone.trim().length < 7 ||
      form.address.trim().length < 5
    ) {
      setNotice('يرجى إدخال الاسم ورقم الهاتف والعنوان بشكل صحيح.');
      return;
    }

    const whatsappWindow = window.open('about:blank', '_blank');
    setSending(true);

    try {
      const items = cart.map(line => ({
        product_id: line.product.id,
        quantity: line.quantity,
      }));

      const requestSignature = JSON.stringify({
        customer_name: form.customer_name.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        notes: form.notes.trim(),
        currency,
        payment_method: form.payment_method,
        items,
      });

      const savedSignature = sessionStorage.getItem(
        'albarq-pending-order-signature'
      );

      if (
        !idempotencyKey.current ||
        savedSignature !== requestSignature
      ) {
        idempotencyKey.current = crypto.randomUUID();
        sessionStorage.setItem(
          'albarq-pending-order-signature',
          requestSignature
        );
        sessionStorage.setItem(
          'albarq-pending-order-key',
          idempotencyKey.current
        );
      }

      const { data, error: invokeError } =
        await supabase.functions.invoke('create-order', {
          body: {
            customer_name: form.customer_name.trim(),
            phone: form.phone.trim(),
            address: form.address.trim(),
            notes: form.notes.trim(),
            currency,
            payment_method: form.payment_method,
            idempotency_key: idempotencyKey.current,
            items,
          },
        });

      if (invokeError || !data?.order_id) {
        throw new Error('ORDER_NOT_CONFIRMED');
      }

      if (typeof data.tracking_token !== 'string') {
        throw new Error('TRACKING_TOKEN_MISSING');
      }

      setMyOrders(old => [
        ...old.filter(order => order.order_id !== data.order_id),
        {
          order_id: data.order_id,
          tracking_token: data.tracking_token,
        },
      ]);

      const itemsText = cart.map((line, index) => {
        const price = unitPrice(line.product, currency);
        const subtotal = price * line.quantity;

        return `${index + 1}. ${line.product.name}
الكمية: ${line.quantity}
سعر القطعة: ${formatMoney(price, currency)}
الإجمالي: ${formatMoney(subtotal, currency)}`;
      }).join('\n\n');

      const message = `طلب جديد من متجر AL-BARQ

رقم الطلب: ${data.order_id}
اسم الزبون: ${form.customer_name.trim()}
هاتف الزبون: ${form.phone.trim()}
عنوان التوصيل: ${form.address.trim()}

تفاصيل المنتجات:
${itemsText}

الإجمالي الكلي: ${formatMoney(total, currency)}
طريقة الدفع: ${paymentLabels[form.payment_method]}
ملاحظات: ${form.notes.trim() || 'لا توجد'}

يرجى التواصل لتأكيد الطلب والاتفاق على الدفع والتوصيل.`;

      const whatsappUrl =
        `https://wa.me/967777924764?text=${encodeURIComponent(message)}`;

      if (whatsappWindow && !whatsappWindow.closed) {
        whatsappWindow.location.href = whatsappUrl;
      } else {
        window.location.href = whatsappUrl;
      }

      setNotice(`تم حفظ طلبك بنجاح. رقم الطلب: ${data.order_id}`);
      setCart([]);
      idempotencyKey.current = null;
      sessionStorage.removeItem('albarq-pending-order-signature');
      sessionStorage.removeItem('albarq-pending-order-key');
      setCheckoutOpen(false);
      setCartOpen(false);
      setForm({
        customer_name: '',
        phone: '',
        address: '',
        notes: '',
        payment_method: 'whatsapp',
      });
    } catch {
      if (whatsappWindow && !whatsappWindow.closed) {
        whatsappWindow.close();
      }
      setNotice(
        'لم نتمكن من تأكيد حفظ الطلب. بقيت السلة كما هي؛ تحقق من الاتصال وحاول مجددًا.'
      );
    } finally {
      setSending(false);
    }
  }
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#home" aria-label="AL-BARQ الصفحة الرئيسية"><span className="brand-mark"><Zap size={24} fill="currentColor" /></span><span><b>AL-BARQ</b><small>متجر البرق</small></span></a>
      <nav className="desktop-nav"><a href="#home">الرئيسية</a><a href="#products">المنتجات</a><a href="#about">من نحن</a></nav>
      <div className="header-actions"><label className="currency-select"><span className="sr-only">العملة</span><select value={currency} onChange={e => setCurrency(e.target.value as Currency)}><option value="YER">ر.ي</option><option value="SAR">ر.س</option></select></label><button className="cart-button" onClick={() => setCartOpen(true)} aria-label={`السلة ${count} منتجات`}><ShoppingBag size={20} /><span>السلة</span><b>{count}</b></button></div>
    </header>
    <main>
      <section className="hero" id="home"><div className="hero-copy"><span className="eyebrow"><span className="pulse-dot" /> تجربة تسوق أسهل</span><h1>كل ما تحتاجه،<br /><em>في مكان واحد.</em></h1><p>اكتشف منتجاتنا المختارة بعناية، وتسوق بثقة مع تجربة سهلة وواضحة من البداية حتى تأكيد الطلب.</p><a className="primary-button" href="#products">اكتشف المنتجات <span>←</span></a><div className="hero-trust"><ShieldCheck size={17} /><span>طلبك يُعالج بأمان</span><span className="trust-divider" /> <span>خدمة عملاء مباشرة</span></div></div><div className="hero-art" aria-hidden="true"><div className="art-glow" /><div className="art-ring ring-one" /><div className="art-ring ring-two" /><div className="art-card card-back"><span>AL-BARQ</span><Zap size={32} /></div><div className="art-card card-front"><div className="art-spark">✳</div><span>تسوّق بذكاء</span><b>اختيارات<br />تستحقها</b><small>QUALITY · TRUST · VALUE</small></div><div className="floating-chip chip-top">✦ جودة مختارة</div><div className="floating-chip chip-bottom"><ShoppingBag size={16} /> ابدأ التسوق</div></div></section>
      <section className="benefits"><div><span className="benefit-icon">✦</span><span><b>منتجات مختارة</b><small>جودة نهتم بها</small></span></div><div><span className="benefit-icon">↗</span><span><b>طلب سهل وسريع</b><small>خطوات واضحة</small></span></div><div><span className="benefit-icon">♡</span><span><b>خدمة تهتم بك</b><small>نحن هنا لمساعدتك</small></span></div></section>

      <section className="products-section" id="my-orders">
        <div className="section-heading">
          <div>
            <span className="eyebrow">تابع مشترياتك</span>
            <h2>طلباتي <em>السابقة</em></h2>
            <p>يمكنك متابعة حالة طلباتك من هذا الجهاز دون إنشاء حساب.</p>
          </div>
        </div>

        {myOrders.length === 0 ? (
          <div className="state-panel">
            <PackageSearch size={34} />
            <b>لا توجد طلبات محفوظة هنا بعد</b>
            <p>بعد تأكيد طلبك، ستجده في هذا القسم.</p>
          </div>
        ) : (
          <div className="product-grid">
            {myOrders.map(order => {
              const details = orderStatuses[order.order_id];

              const statusLabels: Record<string, string> = {
                new: 'طلب جديد',
                reviewing: 'قيد المراجعة',
                approved: 'تمت الموافقة',
                preparing: 'قيد التجهيز',
                shipped: 'تم الشحن',
                delivered: 'تم التسليم',
                rejected: 'مرفوض',
              };

              const paymentLabelsAr: Record<string, string> = {
                pending: 'بانتظار التحقق من الدفع',
                paid: 'تم تأكيد الدفع',
                failed: 'تعذّر تأكيد الدفع',
                refunded: 'تم رد المبلغ',
              };

              return (
                <article className="product-card" key={order.order_id}>
                  <div className="product-info">
                    <small className="product-category">رقم الطلب</small>
                    <h3>{order.order_id}</h3>

                    {details ? (
                      <>
                        <p>
                          حالة الطلب:{' '}
                          {statusLabels[details.status] ?? details.status}
                        </p>
                        <p>
                          حالة الدفع:{' '}
                          {paymentLabelsAr[details.payment_status]
                            ?? details.payment_status}
                        </p>
                        <p>
                          تاريخ الطلب:{' '}
                          {new Date(details.created_at).toLocaleString('ar')}
                        </p>
                      </>
                    ) : (
                      <p>
                        جارٍ تحميل حالة الطلب، أو تعذّر الاتصال بخدمة التتبّع.
                      </p>
                    )}

                    <button
                      className="secondary-button"
                      onClick={() => void refreshOrderStatuses()}
                    >
                      تحديث الحالة
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      <section className="products-section" id="products"><div className="section-heading"><div><span className="eyebrow">تسوّق واكتشف</span><h2>منتجاتنا <em>المميزة</em></h2><p>تصفح المنتجات المتاحة واختر ما يناسبك.</p></div><div className="search-box"><Search size={18} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="ابحث عن منتج..." aria-label="ابحث عن منتج" /></div></div>
        <div className="category-row">{categories.map(c => <button key={c} className={category === c ? 'category active' : 'category'} onClick={() => setCategory(c)}>{c}</button>)}</div>
        {loading ? <div className="state-panel"><span className="loader" /><b>نحمّل المنتجات</b><p>لحظات من فضلك...</p></div> : error ? <div className="state-panel error-panel"><PackageSearch size={34} /><b>لم نتمكن من عرض المنتجات</b><p>{error}</p><button className="secondary-button" onClick={() => location.reload()}>إعادة المحاولة</button></div> : visibleProducts.length === 0 ? <div className="state-panel"><PackageSearch size={34} /><b>{products.length ? 'لا توجد نتائج مطابقة' : 'لا توجد منتجات منشورة بعد'}</b><p>{products.length ? 'جرّب كلمة بحث أو قسمًا آخر.' : 'ستظهر المنتجات هنا بعد إضافتها من لوحة الإدارة.'}</p></div> : <div className="product-grid">{visibleProducts.map(product => <article className="product-card" key={product.id}><div className="product-image">{product.image_url ? <img src={product.image_url} alt={product.name} loading="lazy" /> : <span className="product-emoji">{product.emoji || '🛍️'}</span>}<span className={product.stock > 0 ? 'stock-badge' : 'stock-badge unavailable'}>{product.stock > 0 ? 'متوفر' : 'نفد المخزون'}</span></div><div className="product-info"><small className="product-category">{product.category}</small><h3>{product.name}</h3><p>{product.description || 'منتج من متجر AL-BARQ'}</p><div className="product-bottom"><b>{formatMoney(unitPrice(product, currency), currency)}</b><button onClick={() => add(product)} disabled={product.stock < 1} aria-label={`أضف ${product.name} إلى السلة`}><Plus size={19} /></button></div></div></article>)}</div>}
      </section>
      <section className="about-strip" id="about"><div className="about-symbol"><Zap size={28} fill="currentColor" /></div><div><span className="eyebrow">AL-BARQ</span><h2>تجربة تسوق، <em>على قدر ثقتك.</em></h2><p>نعمل على جعل اختيار المنتجات وإتمام الطلب تجربة بسيطة وواضحة.</p></div></section>
    </main>
    <footer><a className="brand footer-brand" href="#home"><span className="brand-mark"><Zap size={20} fill="currentColor" /></span><span><b>AL-BARQ</b><small>متجر البرق</small></span></a><span>© {new Date().getFullYear()} AL-BARQ. جميع الحقوق محفوظة.</span><a href="#about">تواصل معنا</a></footer>
    {notice && <div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="إغلاق الرسالة"><X size={16} /></button></div>}
    {cartOpen && <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setCartOpen(false); }}><aside className="drawer"><div className="drawer-head"><div><span className="eyebrow">قائمة مشترياتك</span><h2>سلة التسوق <span>({count})</span></h2></div><button className="icon-button" onClick={() => setCartOpen(false)} aria-label="إغلاق"><X /></button></div>{cart.length ? <><div className="cart-lines">{cart.map(line => <div className="cart-line" key={line.product.id}><div className="mini-product">{line.product.image_url ? <img src={line.product.image_url} alt="" /> : line.product.emoji || '🛍️'}</div><div className="line-details"><b>{line.product.name}</b><strong>{formatMoney(unitPrice(line.product, currency) * line.quantity, currency)}</strong><div className="qty-control"><button onClick={() => changeQty(line.product.id, -1)} aria-label="تقليل الكمية"><Minus size={14} /></button><span>{line.quantity}</span><button onClick={() => changeQty(line.product.id, 1)} disabled={line.quantity >= line.product.stock} aria-label="زيادة الكمية"><Plus size={14} /></button><button className="remove-button" onClick={() => remove(line.product.id)} aria-label="حذف المنتج"><Trash2 size={14} /></button></div></div></div>)}</div><div className="drawer-total"><span>الإجمالي التقديري</span><b>{formatMoney(total, currency)}</b><small>سيُعاد التحقق من الأسعار والتوفر عند إرسال الطلب.</small><button className="primary-button full-button" onClick={() => { setCartOpen(false); setCheckoutOpen(true); }}>إتمام الطلب <span>←</span></button></div></> : <div className="empty-cart"><ShoppingBag size={40} /><b>سلتك فارغة</b><p>أضف بعض المنتجات لتبدأ.</p><button className="primary-button" onClick={() => setCartOpen(false)}>متابعة التسوق</button></div>}</aside></div>}
    {checkoutOpen && <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !sending) setCheckoutOpen(false); }}><section className="checkout-modal"><div className="drawer-head"><div><span className="eyebrow">خطوة أخيرة</span><h2>إتمام الطلب</h2></div><button className="icon-button" onClick={() => setCheckoutOpen(false)} disabled={sending} aria-label="إغلاق"><X /></button></div><div className="checkout-summary"><span>{count} قطعة</span><b>{formatMoney(total, currency)}</b></div><form onSubmit={submitOrder} className="checkout-form"><label>الاسم الكامل<input required minLength={2} autoComplete="name" value={form.customer_name} onChange={e => updateForm('customer_name', e.target.value)} placeholder="أدخل اسمك الكامل" /></label><label>رقم الهاتف<input required minLength={7} maxLength={20} inputMode="tel" autoComplete="tel" value={form.phone} onChange={e => updateForm('phone', e.target.value)} placeholder="رقم يمكن التواصل معك عبره" /></label><label>عنوان التوصيل<textarea required minLength={5} autoComplete="street-address" value={form.address} onChange={e => updateForm('address', e.target.value)} placeholder="المدينة، المنطقة، وأقرب معلم" rows={2} /></label><label>
  طريقة الدفع
  <div className="payment-note">تواصل واتساب</div>
</label><label>ملاحظات (اختياري)<textarea value={form.notes} onChange={e => updateForm('notes', e.target.value)} rows={2} placeholder="أي تفاصيل إضافية" /></label><p className="payment-note">لن يُعتبر الدفع مؤكدًا حتى يتحقق منه مسؤول المتجر. لا ترسل بيانات بطاقتك عبر هذا النموذج.</p><button className="primary-button full-button" type="submit" disabled={sending || !cart.length}>{sending ? 'جارٍ إرسال الطلب...' : 'تأكيد الطلب'} <span>←</span></button></form></section></div>}
  </div>;
}
