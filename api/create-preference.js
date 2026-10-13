// Função serverless (Vercel) — valida o carrinho NO SERVIDOR, registra o pedido e cria o pagamento no Mercado Pago.
// Preços, estoque e frete são sempre recalculados aqui (nunca confiamos nos valores enviados pelo navegador).
//
// Variáveis de ambiente necessárias na Vercel:
//   MP_ACCESS_TOKEN             — Access Token de produção do Mercado Pago
//   SUPABASE_SERVICE_ROLE_KEY   — chave "service_role" do Supabase (SECRETA — só no servidor)
//   MELHOR_ENVIO_TOKEN          — token do Melhor Envio (só necessário se o frete grátis estiver desligado)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qlufamiyzktcbydarnwx.supabase.co';

function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Supabase INSERT ${table} -> ${r.status} ${await r.text()}`);
  return (await r.json())[0];
}

async function sbPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase PATCH ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const digits = (s) => String(s || '').replace(/\D/g, '');
const clean = (s, max = 120) => String(s || '').trim().slice(0, max);

function validateCustomer(c) {
  const missing = [];
  if (clean(c && c.name).length < 3) missing.push('nome');
  if (!/^\S+@\S+\.\S+$/.test(clean(c && c.email))) missing.push('e-mail');
  if (digits(c && c.phone).length < 10) missing.push('telefone');
  if (digits(c && c.cep).length !== 8) missing.push('CEP');
  if (!clean(c && c.street)) missing.push('rua');
  if (!clean(c && c.number, 20)) missing.push('número');
  if (!clean(c && c.district)) missing.push('bairro');
  if (!clean(c && c.city)) missing.push('cidade');
  if (!/^[A-Za-z]{2}$/.test(clean(c && c.uf, 2))) missing.push('UF');
  return missing;
}

async function quoteShipping({ originCep, destCep, lines }) {
  if (!process.env.MELHOR_ENVIO_TOKEN) throw new HttpError(500, 'Frete indisponível no momento (token não configurado).');
  const products = lines.map((l) => ({
    id: String(l.id), width: 20, height: 5, length: 27, weight: 0.3,
    insurance_value: l.price, quantity: l.qty,
  }));
  const r = await fetch('https://melhorenvio.com.br/api/v2/me/shipment/calculate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'NOK Streetwear (contato@nok.com.br)',
      Authorization: `Bearer ${process.env.MELHOR_ENVIO_TOKEN}`,
    },
    body: JSON.stringify({
      from: { postal_code: originCep }, to: { postal_code: destCep }, products,
      options: { receipt: false, own_hand: false },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new HttpError(502, 'Não foi possível confirmar o frete agora. Tenta de novo.');
  return (Array.isArray(data) ? data : [])
    .filter((o) => !o.error && o.price)
    .map((o) => ({
      id: o.id,
      label: `${(o.company && o.company.name) || ''} · ${o.name || ''}`.trim(),
      price: Number(o.custom_price ?? o.price),
    }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  if (!process.env.MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado no servidor.' });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY não configurado no servidor.' });

  let order = null;

  try {
    const { items, customer, shippingOptionId } = req.body || {};

    if (!Array.isArray(items) || items.length === 0 || items.length > 30) throw new HttpError(400, 'Carrinho vazio ou inválido.');

    const missing = validateCustomer(customer);
    if (missing.length) throw new HttpError(400, `Confere os dados de entrega: ${missing.join(', ')}.`);

    // 1) Produtos reais do banco (preço, tamanhos, estoque)
    const ids = [...new Set(items.map((i) => String(i.id)))];
    if (ids.some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))) throw new HttpError(400, 'Item inválido.');
    const products = await sbGet(`products?id=in.(${ids.join(',')})&select=id,name,price,sizes,stock`);
    const byId = new Map(products.map((p) => [p.id, p]));

    // 2) Linhas do pedido com valores do servidor + checagem de estoque
    const lines = [];
    const wanted = new Map(); // `${id}|${size}` -> qty total
    for (const it of items) {
      const p = byId.get(String(it.id));
      const size = String(it.size || '');
      const qty = parseInt(it.qty, 10);
      if (!p) throw new HttpError(400, 'Uma das peças do carrinho não existe mais.');
      if (!Array.isArray(p.sizes) || !p.sizes.includes(size)) throw new HttpError(400, `Tamanho inválido para ${p.name}.`);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new HttpError(400, 'Quantidade inválida.');
      const key = `${p.id}|${size}`;
      wanted.set(key, (wanted.get(key) || 0) + qty);
      lines.push({ id: p.id, name: p.name, size, qty, price: Number(p.price) });
    }
    for (const [key, qty] of wanted) {
      const [pid, size] = key.split('|');
      const p = byId.get(pid);
      const available = p.stock ? p.stock[size] : undefined;
      if (available !== undefined && qty > Number(available)) {
        throw new HttpError(409, Number(available) <= 0
          ? `${p.name} (tam ${size}) esgotou. Remove da sacola pra continuar.`
          : `${p.name} (tam ${size}): só ${available} em estoque.`);
      }
    }
    const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0);

    // 3) Frete recalculado no servidor
    const settingsRows = await sbGet('settings?id=eq.1&select=free_shipping,origin_cep');
    const settings = settingsRows[0] || {};
    let shippingLabel = 'Frete grátis';
    let shippingPrice = 0;
    if (!settings.free_shipping) {
      if (shippingOptionId === null || shippingOptionId === undefined) throw new HttpError(400, 'Escolhe uma opção de frete.');
      const originCep = digits(settings.origin_cep);
      if (originCep.length !== 8) throw new HttpError(500, 'Loja sem CEP de origem configurado.');
      const quotes = await quoteShipping({ originCep, destCep: digits(customer.cep), lines });
      const chosen = quotes.find((q) => String(q.id) === String(shippingOptionId));
      if (!chosen) throw new HttpError(400, 'Essa opção de frete não está mais disponível. Calcula o frete de novo.');
      shippingLabel = chosen.label;
      shippingPrice = chosen.price;
    }
    const total = Math.round((subtotal + shippingPrice) * 100) / 100;

    // 4) Registra o pedido (pendente)
    order = await sbInsert('orders', {
      status: 'pending',
      customer: {
        name: clean(customer.name), email: clean(customer.email), phone: digits(customer.phone),
      },
      address: {
        cep: digits(customer.cep), street: clean(customer.street), number: clean(customer.number, 20),
        complement: clean(customer.complement, 60), district: clean(customer.district),
        city: clean(customer.city), uf: clean(customer.uf, 2).toUpperCase(),
      },
      items: lines.map((l) => ({ product_id: l.id, name: l.name, size: l.size, qty: l.qty, price: l.price })),
      subtotal,
      shipping_label: shippingLabel,
      shipping_price: shippingPrice,
      total,
    });

    // 5) Preferência de pagamento no Mercado Pago
    const baseUrl = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const mpItems = lines.map((l) => ({
      title: `${l.name} — Tam ${l.size}`.slice(0, 250),
      quantity: l.qty,
      unit_price: l.price,
      currency_id: 'BRL',
    }));
    if (shippingPrice > 0) {
      mpItems.push({ title: `Frete — ${shippingLabel}`.slice(0, 250), quantity: 1, unit_price: shippingPrice, currency_id: 'BRL' });
    }

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
      body: JSON.stringify({
        items: mpItems,
        external_reference: String(order.id),
        notification_url: `${baseUrl}/api/mp-webhook`,
        back_urls: {
          success: `${baseUrl}/?pagamento=sucesso&pedido=${order.order_number}`,
          failure: `${baseUrl}/?pagamento=falhou&pedido=${order.order_number}`,
          pending: `${baseUrl}/?pagamento=pendente&pedido=${order.order_number}`,
        },
        auto_return: 'approved',
        statement_descriptor: 'NOK STREETWEAR',
      }),
    });
    const pref = await mpRes.json();
    if (!mpRes.ok || !pref.init_point) {
      console.error('Erro Mercado Pago:', pref);
      await sbPatch(`orders?id=eq.${order.id}`, { status: 'error' }).catch(() => {});
      throw new HttpError(502, 'Não foi possível criar o pagamento agora.');
    }
    await sbPatch(`orders?id=eq.${order.id}`, { mp_preference_id: String(pref.id) }).catch(() => {});

    return res.status(200).json({
      init_point: pref.init_point,
      order: { id: order.id, number: order.order_number, subtotal, shippingLabel, shippingPrice, total },
    });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error('Erro inesperado:', err);
    if (order) await sbPatch(`orders?id=eq.${order.id}`, { status: 'error' }).catch(() => {});
    return res.status(500).json({ error: 'Erro interno ao processar o pedido.' });
  }
}
