// Função serverless (Vercel) — cria uma preferência de pagamento no Mercado Pago.
// O token de acesso (MP_ACCESS_TOKEN) fica só aqui no servidor, nunca no código do site.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  if (!process.env.MP_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado no servidor.' });
  }

  try {
    const { items } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Carrinho vazio.' });
    }

    const mpItems = items.map((item) => ({
      title: String(item.name || 'Produto NØK').slice(0, 250),
      quantity: Math.max(1, parseInt(item.qty, 10) || 1),
      unit_price: Number(item.price),
      currency_id: 'BRL',
    }));

    if (mpItems.some((i) => !i.unit_price || i.unit_price <= 0)) {
      return res.status(400).json({ error: 'Item com preço inválido.' });
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;

    const preferenceBody = {
      items: mpItems,
      back_urls: {
        success: `${origin}/?pagamento=sucesso`,
        failure: `${origin}/?pagamento=falhou`,
        pending: `${origin}/?pagamento=pendente`,
      },
      auto_return: 'approved',
      statement_descriptor: 'NOK STREETWEAR',
    };

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(preferenceBody),
    });

    const data = await mpRes.json();

    if (!mpRes.ok) {
      console.error('Erro Mercado Pago:', data);
      return res.status(502).json({ error: 'Não foi possível criar o pagamento agora.' });
    }

    return res.status(200).json({ init_point: data.init_point });
  } catch (err) {
    console.error('Erro inesperado:', err);
    return res.status(500).json({ error: 'Erro interno ao processar o pagamento.' });
  }
}
