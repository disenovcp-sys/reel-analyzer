export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { url, account, caption, context } = req.body || {};
  if (!caption && !context) {
    return res.status(400).json({ error: 'Se necesita al menos la caption para analizar.' });
  }

  const prompt = `Analizá este reel de referencia para benchmarking de contenido de una marca de ropa urbana argentina llamada Van Como Pina (VCP).

Cuenta: ${account || 'no especificada'}
${url ? `URL: ${url}` : ''}
Caption / texto del reel: ${caption || 'no especificada'}
${context ? `Contexto adicional: ${context}` : ''}

Respondé ÚNICAMENTE con un objeto JSON válido (sin texto antes ni después, sin bloques de código markdown), con esta estructura exacta:
{
  "hook_type": "uno de exactamente estos valores: curiosity_gap | dato_contraintuitivo | promesa_revelacion | conflicto | identificacion | otro",
  "hook_breakdown": "explicación concreta de cómo funciona el hook en 2-3 oraciones",
  "narrative_structure": {
    "hook": "qué hace en los primeros segundos para captar atención",
    "contexto": "cómo establece el contexto o la situación",
    "tension": "qué tensión o conflicto genera para mantener la atención",
    "resolucion": "cómo resuelve o desenlaza",
    "cta": "cierre y llamado a la acción"
  },
  "why_it_worked": "hipótesis de por qué generó engagement, cruzando el tipo de hook con la respuesta emocional esperada en la audiencia",
  "vcp_adaptation": "sugerencia concreta y accionable de cómo adaptar exactamente este mecanismo de hook a un reel de VCP (marca de ropa urbana argentina, target 18-35 años)"
}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(500).json({ error: err?.error?.message || `Claude API error ${r.status}` });
    }

    const data = await r.json();
    const text = data.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Respuesta inesperada de Claude.' });

    return res.json(JSON.parse(jsonMatch[0]));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
