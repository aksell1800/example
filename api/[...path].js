// Fungsi serverless Vercel: semua /api/* ditangani di sini.
const { api } = require('../lib/core');

module.exports = async (req, res) => {
  const send = (code, type, body, cache) => {
    res.statusCode = code;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', cache);
    res.end(body);
  };
  try {
    const d = await api(new URL(req.url, 'http://localhost'));
    if (d && d.png) {
      res.setHeader('X-Slim', d.slim ? '1' : '0');
      res.setHeader('Access-Control-Expose-Headers', 'X-Slim');
      return send(200, 'image/png', d.png, 'public, s-maxage=600, stale-while-revalidate=1200');
    }
    // Cache di edge Vercel supaya batas 100 request/menit MineID per IP aman.
    send(200, 'application/json', JSON.stringify(d), 'public, s-maxage=30, stale-while-revalidate=60');
  } catch (e) {
    if (Array.isArray(e)) send(e[0], 'application/json', JSON.stringify({ error: e[1] }), 'no-store');
    else send(502, 'application/json', JSON.stringify({ error: 'The upstream service did not respond.' }), 'no-store');
  }
};
