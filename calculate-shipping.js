// Função serverless (Vercel) — calcula opções de frete via Melhor Envio.
// O token (MELHOR_ENVIO_TOKEN) fica só aqui no servidor.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  if (!process.env.MELHOR_ENVIO_TOKEN) {
    return res.status(500).json({ error: 'MELHOR_ENVIO_TOKEN não configurado no servidor.' });
  }

  try {
    const { originCep, destCep, items } = req.body || {};

    const cleanOrigin = String(originCep || '').replace(/\D/g, '');
    const cleanDest = String(destCep || '').replace(/\D/g, '');

    if (cleanOrigin.length !== 8) {
      return res.status(400).json({ error: 'CEP de origem da loja não está configurado corretamente.' });
    }
    if (cleanDest.length !== 8) {
      return res.status(400).json({ error: 'CEP de destino inválido.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Carrinho vazio.' });
    }

    // Perfil de pacote padrão por unidade (peça de roupa dobrada em embalagem).
    // Simplificação para o MVP: mesma dimensão/peso pra qualquer peça do catálogo.
    const products = items.map((item) => ({
      id: String(item.id),
      width: 20,
      height: 5,
      length: 27,
      weight: 0.3,
      insurance_value: Number(item.price) || 0,
      quantity: Math.max(1, parseInt(item.qty, 10) || 1),
    }));

    const meRes = await fetch('https://melhorenvio.com.br/api/v2/me/shipment/calculate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'NOK Streetwear (contato@nok.com.br)',
        Authorization: `Bearer ${process.env.MELHOR_ENVIO_TOKEN}`,
      },
      body: JSON.stringify({
        from: { postal_code: cleanOrigin },
        to: { postal_code: cleanDest },
        products,
        options: { receipt: false, own_hand: false },
      }),
    });

    const data = await meRes.json();

    if (!meRes.ok) {
      console.error('Erro Melhor Envio:', data);
      return res.status(502).json({ error: 'Não foi possível calcular o frete agora.' });
    }

    const options = (Array.isArray(data) ? data : [])
      .filter((opt) => !opt.error && opt.price)
      .map((opt) => ({
        id: opt.id,
        label: `${opt.company?.name || ''} · ${opt.name || ''}`.trim(),
        price: Number(opt.custom_price ?? opt.price),
        days: opt.custom_delivery_time ?? opt.delivery_time ?? null,
      }))
      .sort((a, b) => a.price - b.price);

    if (!options.length) {
      return res.status(200).json({ options: [], message: 'Nenhuma transportadora disponível para esse CEP no momento.' });
    }

    return res.status(200).json({ options });
  } catch (err) {
    console.error('Erro inesperado:', err);
    return res.status(500).json({ error: 'Erro interno ao calcular o frete.' });
  }
}
