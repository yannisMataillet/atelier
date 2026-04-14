export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const {
    image, mimeType,           // ancien format (1 image) — rétrocompat
    images,                    // nouveau format : [{base64, mimeType}, ...]
    systemPrompt,
    history,                   // nouveau : [{role, content, name?}, ...]
    userMessage,               // nouveau : texte du dernier message de l'étudiant (optionnel)
  } = req.body;

  if (!systemPrompt) {
    return res.status(400).json({ error: 'Missing required field: systemPrompt' });
  }

  // Normaliser les images
  let imageList = [];
  if (Array.isArray(images) && images.length > 0) {
    imageList = images;
  } else if (image && mimeType) {
    imageList = [{ base64: image, mimeType }];
  }
  if (imageList.length === 0) {
    return res.status(400).json({ error: 'Missing images' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });
  }

  // Construction du tableau messages
  const messages = [];

  const firstUserContent = imageList.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
  }));
  firstUserContent.push({
    type: 'text',
    text: "Voici les documents du projet soumis par l'étudiant. Analyse selon les consignes du système.",
  });
  messages.push({ role: 'user', content: firstUserContent });

  // Historique
  if (Array.isArray(history)) {
    for (const turn of history) {
      if (!turn || !turn.content) continue;
      if (turn.role === 'assistant') {
        const prefix = turn.name ? `[${turn.name}] ` : '';
        messages.push({ role: 'assistant', content: prefix + turn.content });
      } else if (turn.role === 'user') {
        messages.push({ role: 'user', content: turn.content });
      }
    }
  }

  // Dernier message de l'étudiant
  if (userMessage && typeof userMessage === 'string' && userMessage.trim()) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      if (typeof last.content === 'string') {
        last.content = last.content + '\n\n' + userMessage;
      } else {
        last.content.push({ type: 'text', text: userMessage });
      }
    } else {
      messages.push({ role: 'user', content: userMessage });
    }
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        system: systemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error('[Atelier] Anthropic API error:', response.status, JSON.stringify(error));
      return res.status(response.status).json({ error: error.error?.message || 'Anthropic API error' });
    }

    const data = await response.json();

    // === DIAGNOSTIC LOGGING ===
    // Logs what Anthropic actually returned so we can understand empty responses
    const stopReason = data.stop_reason;
    const contentBlocks = data.content || [];
    const firstBlock = contentBlocks[0];
    const critique = firstBlock?.text ?? '';

    if (!critique || !critique.trim()) {
      console.warn('[Atelier] Empty critique returned. Diagnostic:', JSON.stringify({
        stop_reason: stopReason,
        content_blocks_count: contentBlocks.length,
        first_block_type: firstBlock?.type,
        first_block_keys: firstBlock ? Object.keys(firstBlock) : [],
        usage: data.usage,
      }));
    } else {
      console.log('[Atelier] Critique returned:', critique.length, 'chars, stop_reason:', stopReason);
    }

    return res.status(200).json({
      critique,
      // Diagnostic info for frontend (optional)
      _diag: !critique ? { stop_reason: stopReason, block_type: firstBlock?.type } : undefined
    });
  } catch (err) {
    console.error('[Atelier] Fetch error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
