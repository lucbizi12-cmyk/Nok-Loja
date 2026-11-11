// Mantém o projeto do Supabase (plano gratuito) ativo, fazendo algumas leituras por dia.
// Só lê dados públicos, com a chave "anon" que já é pública no site.
// É chamado todo dia pela Vercel (veja vercel.json) e pode ser usado também por um monitor de uptime.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qlufamiyzktcbydarnwx.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFsdWZhbWl5emt0Y2J5ZGFybnd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5Mzk4NDYsImV4cCI6MjEwNTUxNTg0Nn0.qIpXNwpleUP7NiGi8Aocu8vDjo3GTUAUlJlf6QEaDXA';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const headers = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` };
  const paths = [
    'products?select=id&limit=1',
    'products?select=id,price&limit=5',
    'products?select=id,name&order=created_at.desc&limit=3',
    'settings?select=id&limit=1',
    'settings?select=free_shipping&limit=1',
    'products?select=id&limit=2',
  ];
  try {
    const results = await Promise.all(paths.map((p) => fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers })));
    const ok = results.every((r) => r.ok);
    return res.status(ok ? 200 : 503).json({ ok, statuses: results.map((r) => r.status) });
  } catch (err) {
    return res.status(503).json({ ok: false, error: 'banco indisponível' });
  }
}
