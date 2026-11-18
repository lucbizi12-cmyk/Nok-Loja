// Confere se o código do link privado de acesso antecipado é válido.
// O horário em que a loja abre pra quem tem o link é conferido de novo no pagamento (create-preference.js).
// Variável de ambiente: SUPABASE_SERVICE_ROLE_KEY

import { timingSafeEqual } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qlufamiyzktcbydarnwx.supabase.co';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Servidor sem credenciais configuradas.' });

  try {
    const given = String((req.body && req.body.code) || '').trim();
    if (!given || given.length > 64) return res.status(200).json({ valid: false });

    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/early_access?id=eq.1&select=code`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return res.status(200).json({ valid: false });
    const rows = await r.json();
    const real = rows[0] && rows[0].code;
    if (!real) return res.status(200).json({ valid: false });

    const a = Buffer.from(given);
    const b = Buffer.from(String(real));
    return res.status(200).json({ valid: a.length === b.length && timingSafeEqual(a, b) });
  } catch (err) {
    console.error('Erro no acesso antecipado:', err);
    return res.status(200).json({ valid: false });
  }
}
