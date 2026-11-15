// Valida um cupom para mostrar o desconto na sacola. O cálculo final é refeito em create-preference.js.
// Variável de ambiente: SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qlufamiyzktcbydarnwx.supabase.co';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Servidor sem credenciais configuradas.' });

  try {
    const code = String((req.body && req.body.code) || '').trim().toUpperCase().slice(0, 32);
    if (!/^[A-Z0-9_-]{2,32}$/.test(code)) return res.status(400).json({ error: 'Cupom inválido.' });

    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/coupons?code=eq.${encodeURIComponent(code)}&select=code,percent,starts_at,ends_at,active`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!r.ok) return res.status(502).json({ error: 'Não foi possível validar o cupom agora.' });
    const c = (await r.json())[0];

    if (!c || !c.active) return res.status(400).json({ error: 'Cupom inválido.' });
    const now = Date.now();
    if (now < new Date(c.starts_at).getTime()) return res.status(400).json({ error: 'Esse cupom ainda não está valendo.' });
    if (now > new Date(c.ends_at).getTime()) return res.status(400).json({ error: 'Esse cupom expirou.' });

    return res.status(200).json({ code: c.code, percent: Number(c.percent) });
  } catch (err) {
    console.error('Erro ao validar cupom:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
}
