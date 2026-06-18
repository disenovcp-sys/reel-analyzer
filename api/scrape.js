export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL requerida' });

  const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (!match) return res.status(400).json({ error: 'URL de Instagram inválida' });
  const shortcode = match[1];

  const result = { shortcode, url, account: '', caption: '', thumbnail: '' };

  // Fetch embed page — most reliable free approach
  try {
    const r = await fetch(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });

    if (r.ok) {
      const html = await r.text();

      // Caption from JSON in HTML
      const captionM = html.match(/"caption_text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (captionM) {
        result.caption = captionM[1]
          .replace(/\\n/g, '\n')
          .replace(/\\u([\dA-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }

      // Account
      const accountM = html.match(/"username"\s*:\s*"([^"]+)"/);
      if (accountM) result.account = '@' + accountM[1];

      // Thumbnail from og:image
      const thumbM = html.match(/property="og:image"\s+content="([^"]+)"/);
      if (thumbM) result.thumbnail = thumbM[1];
    }
  } catch (e) {
    console.error('scrape error:', e.message);
  }

  return res.json(result);
}
