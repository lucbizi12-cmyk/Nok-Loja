// Webhook do Mercado Pago — recebe o aviso de mudança de status do pagamento,
// atualiza o pedido e, quando o pagamento é aprovado, baixa o estoque (uma única vez).
//
// Variáveis de ambiente: MP_ACCESS_TOKEN, SUPABASE_SERVICE_ROLE_KEY

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

async function sbPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase PATCH ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function decrementStock(productId, size, qty) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/decrement_stock`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({ p_id: productId, p_size: size, p_qty: qty }),
  });
  if (!r.ok) console.error('Falha ao baixar estoque', productId, size, r.status, await r.text());
}

const STATUS_MAP = {
  approved: 'paid',
  authorized: 'pending',
  in_process: 'pending',
  pending: 'pending',
  in_mediation: 'pending',
  rejected: 'rejected',
  cancelled: 'cancelled',
  refunded: 'refunded',
  charged_back: 'refunded',
};

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const type = q.type || q.topic || body.type || body.topic;
    const paymentId = q['data.id'] || (body.data && body.data.id) || (type === 'payment' ? q.id || body.id : null);

    if (type !== 'payment' || !paymentId) return res.status(200).json({ ignored: true });
    if (!process.env.MP_ACCESS_TOKEN || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Servidor sem credenciais configuradas.' });
    }

    // Fonte da verdade: consulta o pagamento direto na API do Mercado Pago
    const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });
    if (payRes.status === 404) return res.status(200).json({ ignored: 'pagamento não encontrado' });
    if (!payRes.ok) return res.status(502).json({ error: 'Falha ao consultar o Mercado Pago.' });
    const pay = await payRes.json();

    const orderId = String(pay.external_reference || '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) return res.status(200).json({ ignored: 'sem pedido associado' });

    const rows = await sbGet(`orders?id=eq.${orderId}&select=id,status,items,stock_applied`);
    if (!rows.length) return res.status(200).json({ ignored: 'pedido não encontrado' });
    const order = rows[0];

    const newStatus = STATUS_MAP[pay.status] || 'pending';
    const common = {
      mp_payment_id: String(pay.id),
      mp_payment_status: String(pay.status || ''),
      mp_payment_method: pay.payment_method_id || null,
      updated_at: new Date().toISOString(),
    };

    if (newStatus === 'paid') {
      // "Reivindica" a baixa de estoque de forma atômica: só quem conseguir virar stock_applied=true baixa.
      const claimed = await sbPatch(`orders?id=eq.${orderId}&stock_applied=eq.false`, {
        ...common, status: 'paid', stock_applied: true,
      });
      if (claimed.length) {
        const totals = new Map();
        for (const it of order.items || []) {
          const key = `${it.product_id}|${it.size}`;
          totals.set(key, (totals.get(key) || 0) + Number(it.qty || 0));
        }
        for (const [key, qty] of totals) {
          const [pid, size] = key.split('|');
          await decrementStock(pid, size, qty);
        }
      } else {
        await sbPatch(`orders?id=eq.${orderId}`, { ...common, status: 'paid' });
      }
    } else if (order.status === 'paid' && newStatus !== 'refunded') {
      // notificação atrasada/fora de ordem: não rebaixa um pedido já pago
    } else {
      await sbPatch(`orders?id=eq.${orderId}`, { ...common, status: newStatus });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro no webhook:', err);
    return res.status(500).json({ error: 'Erro interno.' }); // o Mercado Pago tenta de novo
  }
}
