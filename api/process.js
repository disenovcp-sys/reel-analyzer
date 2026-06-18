const GEMINI_KEY = process.env.GEMINI_API_KEY;

function shortcode(url) {
  const m = url.match(/\/(reel|p|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[2] : null;
}

function cleanVideoUrl(raw) {
  return raw
    .replace(/\\u0026/g, '&')
    .replace(/\\u003C/g, '<')
    .replace(/\\u003E/g, '>')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '');
}

function extractVideoUrl(html) {
  const patterns = [
    /"video_url":"(https:[^"]{10,})"/,
    /"playback_url":"(https:[^"]{10,})"/,
    /property="og:video"\s+content="([^"]+)"/,
    /content="([^"]+\.mp4[^"]*)"\s+property="og:video"/,
    /<video[^>]+src="(https:[^"]+)"/,
    /"src":"(https:[^"]+\.mp4[^"]*)"/,
    /videoUrl\s*[:=]\s*"(https:[^"]+)"/,
    /"dash_manifest_url":"(https:[^"]+)"/,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) return cleanVideoUrl(m[1]);
  }
  return null;
}

function extractImageUrl(html) {
  const m = html.match(/property="og:image"\s+content="([^"]+)"/) ||
            html.match(/content="([^"]+)"\s+property="og:image"/);
  return m ? cleanVideoUrl(m[1]) : null;
}

async function fetchVideoBytes(videoUrl) {
  try {
    const r = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Referer': 'https://www.instagram.com/',
      },
    });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || 'video/mp4';
    const buf = Buffer.from(await r.arrayBuffer());
    return { buf, contentType: ct };
  } catch (_) { return null; }
}

// Strategy 1: Cobalt — handles the picker response too
async function viaCobalt(igUrl) {
  try {
    const r = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; ReelAnalyzer/1.0)',
      },
      body: JSON.stringify({ url: igUrl }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.status === 'error') return null;
    // redirect or tunnel → direct URL
    if (data.url) return fetchVideoBytes(data.url);
    // picker → take first video item
    if (data.status === 'picker' && data.picker) {
      const item = data.picker.find(p => p.type === 'video') || data.picker[0];
      if (item?.url) return fetchVideoBytes(item.url);
    }
    return null;
  } catch (_) { return null; }
}

// Strategy 2: Route through a CORS/web proxy to bypass Vercel IP block
async function viaProxy(code) {
  const igEmbedUrl = `https://www.instagram.com/reel/${code}/embed/captioned/`;
  const proxies = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(igEmbedUrl)}`,
    `https://corsproxy.io/?${encodeURIComponent(igEmbedUrl)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(igEmbedUrl)}`,
  ];
  for (const proxyUrl of proxies) {
    try {
      const r = await fetch(proxyUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReelAnalyzer/1.0)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;
      const html = await r.text();
      const videoUrl = extractVideoUrl(html);
      if (videoUrl) {
        const result = await fetchVideoBytes(videoUrl);
        if (result) return result;
      }
      // Image fallback from proxy
      const imgUrl = extractImageUrl(html);
      if (imgUrl) {
        const ir = await fetch(imgUrl);
        if (ir.ok) {
          const buf = Buffer.from(await ir.arrayBuffer());
          return { buf, contentType: 'image/jpeg', isImage: true };
        }
      }
    } catch (_) {}
  }
  return null;
}

// Strategy 3: Direct embed (works when Vercel IPs aren't fully blocked)
async function viaEmbed(code) {
  const endpoints = [
    `https://www.instagram.com/reel/${code}/embed/captioned/`,
    `https://www.instagram.com/reel/${code}/embed/`,
    `https://www.instagram.com/p/${code}/embed/`,
  ];
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!r.ok) continue;
      const html = await r.text();
      const videoUrl = extractVideoUrl(html);
      if (videoUrl) {
        const result = await fetchVideoBytes(videoUrl);
        if (result) return result;
      }
      const imgUrl = extractImageUrl(html);
      if (imgUrl) {
        const ir = await fetch(imgUrl);
        if (ir.ok) {
          const buf = Buffer.from(await ir.arrayBuffer());
          return { buf, contentType: 'image/jpeg', isImage: true };
        }
      }
    } catch (_) {}
  }
  return null;
}

async function downloadVideo(igUrl, code) {
  return (await viaCobalt(igUrl)) ||
         (await viaProxy(code)) ||
         (await viaEmbed(code));
}

async function uploadToGemini(buf, contentType) {
  // Step 1: initiate resumable upload
  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_KEY}&uploadType=resumable`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': buf.length,
        'X-Goog-Upload-Header-Content-Type': contentType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { displayName: 'reel' } }),
    }
  );
  if (!initRes.ok) throw new Error(`Gemini upload init failed: ${initRes.status}`);
  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('No upload URL from Gemini');

  // Step 2: upload the bytes
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': buf.length,
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buf,
  });
  if (!uploadRes.ok) throw new Error(`Gemini upload failed: ${uploadRes.status}`);
  const file = await uploadRes.json();
  return file.file || file;
}

async function waitActive(fileUri) {
  for (let i = 0; i < 20; i++) {
    const name = fileUri.split('/files/')[1];
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/files/${name}?key=${GEMINI_KEY}`
    );
    if (!r.ok) throw new Error(`File status check failed: ${r.status}`);
    const f = await r.json();
    if (f.state === 'ACTIVE') return;
    if (f.state === 'FAILED') throw new Error('Gemini file processing failed');
    await new Promise(res => setTimeout(res, 2000));
  }
  throw new Error('Timed out waiting for Gemini file');
}

async function analyzeWithGemini(fileUri, mimeType, isImage) {
  const mediaType = isImage ? 'imagen' : 'video';
  const prompt = `Analizá este ${mediaType} de referencia para benchmarking de contenido de una marca de ropa urbana argentina llamada Van Como Pina (VCP).

Observá el ${mediaType} completo y analizá:
- El hook visual y auditivo de los primeros segundos
- La estructura narrativa completa
- Por qué generó engagement (hipótesis basada en lo que VES en el ${mediaType})
- Qué elementos específicos del ${mediaType} son adaptables a VCP

Respondé ÚNICAMENTE con un objeto JSON válido (sin texto antes ni después, sin bloques de código markdown), con esta estructura exacta:
{
  "hook_type": "uno de exactamente estos valores: curiosity_gap | dato_contraintuitivo | promesa_revelacion | conflicto | identificacion | otro",
  "hook_breakdown": "descripción concreta del hook visual/auditivo en 2-3 oraciones, referenciando lo que se ve en el ${mediaType}",
  "narrative_structure": {
    "hook": "qué pasa en los primeros 1-3 segundos para captar atención (visual, audio, texto en pantalla)",
    "contexto": "cómo establece el contexto o la situación en el ${mediaType}",
    "tension": "qué tensión o conflicto genera visualmente para mantener la atención",
    "resolucion": "cómo resuelve o desenlaza (incluyendo elementos visuales finales)",
    "cta": "cierre y llamado a la acción si existe"
  },
  "visual_elements": "descripción de los elementos visuales clave: estética, colores, montaje, texto en pantalla, música/audio que contribuyen al engagement",
  "why_it_worked": "hipótesis de por qué generó engagement, basada en los elementos específicos del ${mediaType} observado y la respuesta emocional esperada",
  "vcp_adaptation": "sugerencia concreta y accionable de cómo adaptar exactamente este mecanismo visual y narrativo a un reel de VCP (marca de ropa urbana argentina, target 18-35 años)"
}`;

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { file_data: { mime_type: mimeType, file_uri: fileUri } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: { temperature: 0.4, maxOutputTokens: 1500 },
      }),
    }
  );

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini API error ${r.status}`);
  }

  const data = await r.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Respuesta inesperada de Gemini');
  return JSON.parse(m[0]);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL requerida.' });
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY no configurada.' });

  const code = shortcode(url);
  if (!code) return res.status(400).json({ error: 'URL de Instagram no válida.' });

  try {
    // 1. Download media from Instagram
    const media = await downloadVideo(url, code);
    if (!media) return res.status(422).json({ error: 'No se pudo descargar el video. Instagram puede haber bloqueado la descarga — intentá con un reel público.' });

    // 2. Upload to Gemini File API
    const file = await uploadToGemini(media.buf, media.contentType);
    const fileUri = file.uri;
    const mimeType = file.mimeType || media.contentType;

    // 3. Wait for processing
    if (!media.isImage) await waitActive(fileUri);

    // 4. Analyze
    const analysis = await analyzeWithGemini(fileUri, mimeType, media.isImage);
    return res.json({ ...analysis, shortcode: code, isImage: !!media.isImage });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
