// MineKit server lokal/Pterodactyl: node local-server.js. Node 18+. Tanpa paket npm.
// Jalankan: node local-server.js   (tambah --tunnel untuk Cloudflare quick tunnel)
// Di Vercel, file ini tidak dipakai (sengaja bukan server.js agar tidak dikira app Express): lihat api/[...path].js
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const { api } = require('./lib/core');

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname.startsWith('/api/')) {
      const d = await api(u);
      if (d && d.png) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'X-Slim': d.slim ? '1' : '0', 'Access-Control-Expose-Headers': 'X-Slim' });
        return res.end(d.png);
      }
      return json(res, 200, d);
    }
    // Look in public/ first, then next to server.js.
    const file = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(f => fs.existsSync(f));
    if (!file) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('index.html not found. Upload it to the public/ folder (or next to server.js).');
    }
    const html = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    if (res.headersSent) return res.end();
    Array.isArray(e) ? json(res, e[0], { error: e[1] }) : json(res, 502, { error: 'The upstream service did not respond.' });
  }
});

function tunnel(port) {
  const p = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:' + port]);
  p.stderr.on('data', d => { const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) console.log('Public URL: ' + m[0]); });
  p.on('error', () => console.log('cloudflared is not installed, so no tunnel was started.'));
}

// Pterodactyl sets SERVER_PORT. If the port is taken, try the next one.
function listen(port) {
  server.once('error', e => { if (e.code === 'EADDRINUSE') listen(port + 1); else throw e; });
  server.listen(port, '0.0.0.0', () => {
    server.removeAllListeners('error');
    console.log('MineKit is running on port ' + port);
    if (process.argv.includes('--tunnel')) tunnel(port);
  });
}
listen(parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10));
