// MineKit server. Node 18+ required (uses built-in fetch). No npm packages.
// Run: node server.js            (add --tunnel to start a Cloudflare quick tunnel)
// Data comes from the public MineID API (https://mineid.my.id/docs/api). No API key is needed.
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');

const MID = (process.env.MINEID_BASE || 'https://mineid.my.id/api').replace(/\/$/, '');
const UA = { 'User-Agent': 'MineKit/1.0 (self-hosted)' };

// MineID limits: 100 requests/min per IP. Everything below is cached to stay well under that.
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

// Calls MineID. `sets` is a list of parameter sets: if the API answers 400 (unknown/invalid
// parameter), the next, smaller set is tried. Throws [httpStatus, message].
async function mid(p, sets = [{}]) {
  let last = [502, 'MineID did not respond.'];
  for (const set of sets) {
    const u = new URL(MID + p);
    for (const [k, v] of Object.entries(set)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    let r, j = null;
    try { r = await fetch(u, { headers: { ...UA, Accept: 'application/json' } }); j = await r.json().catch(() => null); }
    catch (e) { last = [502, 'MineID did not respond.']; break; }
    if (r.ok && j && j.success !== false) return j;
    const detail = j && j.errors ? ' ' + JSON.stringify(j.errors).slice(0, 180) : '';
    last = [[400, 404, 429].includes(r.status) ? r.status : 502, ((j && j.message) || 'MineID answered with status ' + r.status + '.') + detail];
    if (r.status !== 400) break;
  }
  throw last;
}
const list = j => { const d = j.data; return Array.isArray(d) ? d : d && (d.data || d.results || d.items || d.hits || []) || []; };
const pagination = (j, n) => { const p = j.pagination || (j.data && j.data.pagination) || {}; return { total: p.total ?? p.totalCount ?? n, page: p.page ?? 1, pages: p.totalPages ?? null }; };
const okHost = h => /^[a-z0-9.\-:_]{1,255}$/i.test(h || '');
const okId = s => /^[A-Za-z0-9_-]{1,64}$/.test(s || '');

// ---- Java / Bedrock downloader ----
const CLASS = {
  java: { mod: 6, modpack: 4471, resourcepack: 12, datapack: 4546, shader: 6552, world: 17 },
  bedrock: { addon: 4984, map: 6913, texturepack: 6929, script: 6940, skin: 6925 },
};
const CF_LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const MR_TYPES = ['mod', 'modpack', 'resourcepack', 'datapack', 'shader'];
const LOADER_TYPES = ['mod', 'modpack'];
const LIM = 20;

function norm(m, src, type) {
  const authors = m.authors || [];
  const a0 = authors[0];
  const tags = (m.display_categories || m.categories || []).slice(0, 4).map(c => (c && c.name) || c);
  return {
    id: String(m.project_id || m.id),
    title: m.title || m.name,
    author: m.author || (a0 && (a0.name || a0)) || '',
    desc: m.description || m.summary || '',
    icon: m.icon_url || (typeof m.icon === 'string' ? m.icon : '') || (m.logo && (m.logo.thumbnailUrl || m.logo.url)) || '',
    downloads: m.downloads ?? m.downloadCount ?? 0,
    tags,
    page: (m.links && m.links.websiteUrl) || (m.slug && src === 'modrinth' ? 'https://modrinth.com/' + (m.project_type || type) + '/' + m.slug : ''),
  };
}

async function modrinthDirect(type, text, ver, loader, pg) {
  const facets = [['project_type:' + type]];
  if (ver) facets.push(['versions:' + ver]);
  if (loader) facets.push(['categories:' + loader]);
  const r = await fetch('https://api.modrinth.com/v2/search?' + new URLSearchParams({ query: text, facets: JSON.stringify(facets), offset: (pg - 1) * LIM, limit: LIM }), { headers: UA });
  if (!r.ok) throw [502, 'Modrinth answered with status ' + r.status + '.'];
  const j = await r.json();
  return j.hits.map(h => ({ ...h, id: h.project_id }));
}

async function downloader(path_, q) {
  const ed = q.get('edition') === 'bedrock' ? 'bedrock' : 'java';
  const src = q.get('source') === 'modrinth' ? 'modrinth' : 'curseforge';
  const type = q.get('type') || '', loader = q.get('loader') || '', ver = q.get('version') || '';
  if (!/^[\w.\-]*$/.test(ver) || !/^[a-z]*$/.test(loader)) throw [400, 'Invalid filter.'];
  if (src === 'modrinth' ? !(ed === 'java' && MR_TYPES.includes(type)) : !CLASS[ed][type]) throw [400, 'That type is not available for this source.'];
  const useLoader = ed === 'java' && LOADER_TYPES.includes(type) ? loader : '';
  const ml = useLoader && CF_LOADER[useLoader] ? CF_LOADER[useLoader] : '';

  if (path_ === '/api/jd/search') {
    const text = (q.get('q') || '').slice(0, 100), pg = (parseInt(q.get('page') || '0', 10) || 0) + 1;
    return cached(['s', ed, src, type, text, useLoader, ver, pg].join('|'), 60000, async () => {
      let arr;
      if (src === 'curseforge') {
        const base = { edition: ed, classId: CLASS[ed][type], gameVersion: ver, modLoaderType: ml, page: pg, limit: LIM };
        const j = await mid('/tools/curseforge/search', [{ ...base, q: text, query: text, search: text, searchFilter: text }, { ...base, q: text }]);
        arr = list(j);
        const pp = pagination(j, arr.length);
        return { results: arr.map(m => norm(m, src, type)), more: pp.pages ? pp.page < pp.pages : arr.length >= LIM };
      }
      try {
        const base = { page: pg, limit: LIM, gameVersion: ver, version: ver, versions: ver };
        const j = await mid('/tools/modrinth/search', [
          { ...base, q: text, query: text, search: text, type, projectType: type, project_type: type, loader: useLoader, loaders: useLoader },
          { q: text, type, loader: useLoader, gameVersion: ver, page: pg, limit: LIM }]);
        arr = list(j);
      } catch (e) { arr = await modrinthDirect(type, text, ver, useLoader, pg); } // MineID unavailable: ask Modrinth directly
      return { results: arr.map(m => norm(m, src, type)), more: arr.length >= LIM };
    });
  }

  const id = q.get('id') || '';
  if (!okId(id)) throw [400, 'Invalid project id.'];
  return cached(['f', ed, src, type, id, useLoader, ver].join('|'), 60000, async () => {
    if (src === 'modrinth') {
      const p = new URLSearchParams();
      if (useLoader) p.set('loaders', JSON.stringify([useLoader]));
      if (ver) p.set('game_versions', JSON.stringify([ver]));
      const r = await fetch('https://api.modrinth.com/v2/project/' + id + '/version?' + p, { headers: UA });
      if (!r.ok) throw [502, 'Modrinth answered with status ' + r.status + '.'];
      return (await r.json()).slice(0, 8).map(v => {
        const f = v.files.find(x => x.primary) || v.files[0] || {};
        return { name: f.filename || v.name, url: f.url, size: f.size, label: v.version_number + ' \u00b7 ' + v.version_type, mc: (v.game_versions || []).slice(-4), loaders: v.loaders || [], date: v.date_published };
      });
    }
    const j = await mid('/tools/curseforge/' + id + '/files', [{ edition: ed, gameVersion: ver, modLoaderType: ml, limit: 50, pageSize: 50 }, { gameVersion: ver, modLoaderType: ml }]);
    let arr = list(j);
    // Filter again here in case the API ignored a parameter.
    if (ver) arr = arr.filter(f => !(f.gameVersions || []).length || f.gameVersions.some(v => v === ver || v.startsWith(ver + '.')));
    if (useLoader) arr = arr.filter(f => !(f.gameVersions || []).length || f.gameVersions.some(v => v.toLowerCase() === useLoader) || !f.gameVersions.some(v => CF_LOADER[v.toLowerCase()]));
    arr.sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
    return arr.slice(0, 8).map(f => {
      const gv = f.gameVersions || [];
      return { name: f.fileName || f.displayName, url: f.downloadUrl || MID + '/tools/curseforge/' + id + '/files/' + f.id + '/download', size: f.fileLength, label: (f.displayName || '') + ' \u00b7 ' + (['', 'release', 'beta', 'alpha'][f.releaseType] || 'file'), mc: gv.filter(v => /^\d+\./.test(v)).slice(0, 4), loaders: gv.filter(v => CF_LOADER[v.toLowerCase()]).map(v => v.toLowerCase()), date: f.fileDate };
    });
  });
}

// ---- Skins ----
function findHash(d) {
  if (d.skinHash) return d.skinHash;
  if (d.skin && typeof d.skin === 'object' && (d.skin.hash || d.skin.id)) return d.skin.hash || d.skin.id;
  if (typeof d.skin === 'string') return d.skin.replace(/^.*\//, '');
  for (const k of Object.keys(d)) if (/skin/i.test(k) && /hash|id|texture|url/i.test(k) && typeof d[k] === 'string') return d[k].replace(/^.*\//, '');
  return '';
}
const isSlim = d => { const m = String((d.skin && d.skin.model) || d.model || d.skinModel || d.skinType || '').toLowerCase(); return m === 'slim' || m === 'alex' || d.slim === true; };

async function skin(name) {
  if (!/^\w{1,16}$/.test(name || '')) throw [400, 'Usernames are 1 to 16 letters, numbers or underscores.'];
  return cached('skin' + name.toLowerCase(), 600000, async () => {
    try {
      const d = (await mid('/tools/skin/' + encodeURIComponent(name))).data || {};
      const hash = findHash(d);
      if (!/^[a-f0-9]{16,128}$/i.test(hash)) throw new Error('no hash');
      const r = await fetch(MID + '/tools/skin/texture/' + hash, { headers: UA });
      if (!r.ok) throw new Error('texture');
      return { png: Buffer.from(await r.arrayBuffer()), slim: isSlim(d) };
    } catch (e) {
      if (Array.isArray(e) && (e[0] === 404 || e[0] === 400)) throw e;
      // Fallback: ask Mojang directly.
      const p = await fetch('https://api.mojang.com/users/profiles/minecraft/' + name, { headers: UA });
      if (p.status !== 200) throw [404, 'No Java account with that username.'];
      const { id } = await p.json();
      const s = await (await fetch('https://sessionserver.mojang.com/session/minecraft/profile/' + id, { headers: UA })).json();
      const tx = JSON.parse(Buffer.from(s.properties[0].value, 'base64').toString()).textures.SKIN;
      if (!tx) throw [404, 'That account has no skin.'];
      return { png: Buffer.from(await (await fetch(tx.url)).arrayBuffer()), slim: !!(tx.metadata && tx.metadata.model === 'slim') };
    }
  });
}

// ---- Router ----
async function api(u) {
  const q = u.searchParams, p = u.pathname;

  if (p === '/api/status') {
    let host = q.get('host') || '', ed = q.get('edition') === 'bedrock' ? 'bedrock' : 'java', port = '';
    if (!okHost(host)) throw [400, 'Enter a valid server address.'];
    if (ed === 'bedrock' && /:\d+$/.test(host)) { port = host.split(':').pop(); host = host.replace(/:\d+$/, ''); }
    return cached('st' + ed + host + port, 30000, async () => {
      const d = (await mid('/tools/server-status', [{ host, edition: ed, port }])).data || {};
      const mo = d.motd;
      const lines = Array.isArray(mo) ? mo : mo && typeof mo === 'object' ? (mo.raw || mo.clean || mo.lines || []) : typeof mo === 'string' ? mo.split('\n') : [];
      const pl = d.players || {};
      return {
        online: !!d.online, hostname: d.hostname || d.host || host, ip: d.ip, port: d.port,
        version: d.version && (d.version.name || d.version), software: d.software, gamemode: d.gamemode,
        players: d.players || d.playersOnline != null ? { online: pl.online ?? pl.current ?? d.playersOnline ?? 0, max: pl.max ?? d.playersMax ?? 0, list: pl.list || pl.sample || [] } : undefined,
        icon: d.icon || d.favicon, motd: { raw: lines },
      };
    });
  }

  if (p === '/api/skin') {
    const r = await skin(q.get('name'));
    return r;
  }

  if (p === '/api/jd/meta') {
    return cached('meta', 3600000, async () => {
      let versions = [];
      try {
        const r = await fetch('https://api.modrinth.com/v2/tag/game_version', { headers: UA });
        versions = (await r.json()).filter(v => v.version_type === 'release').sort((a, b) => new Date(b.date) - new Date(a.date)).map(v => v.version);
      } catch (e) { /* fall back below */ }
      if (!versions.length) versions = ['1.21.4', '1.21.1', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.19.2', '1.18.2', '1.16.5', '1.12.2', '1.8.9'];
      return { versions };
    });
  }
  if (p === '/api/jd/search' || p === '/api/jd/files') return downloader(p, q);

  // ---- Marketplace DLC ----
  if (p === '/api/dlc/creators') {
    return cached('dcr', 3600000, async () => {
      const j = await mid('/dlc/creators');
      return list(j).map(c => ({ id: String(c.id || c.creatorId || c.uuid || ''), name: c.name || c.displayName || c.title || String(c.id || '') })).filter(c => c.id);
    });
  }
  if (p === '/api/dlc/categories') {
    return cached('dcat', 3600000, async () => {
      const j = await mid('/dlc/categories');
      return Array.isArray(j.data) ? j.data : Object.keys(j.data || {});
    });
  }
  if (p === '/api/dlc/list') {
    const text = (q.get('q') || '').slice(0, 100), category = (q.get('category') || '').slice(0, 40), creator = q.get('creator') || '';
    const pg = Math.max(1, parseInt(q.get('page') || '1', 10) || 1), lim = 24;
    if (creator && !okId(creator)) throw [400, 'Invalid creator.'];
    return cached(['dl', text, category, creator, pg].join('|'), 60000, async () => {
      const base = { category, page: pg, limit: lim };
      const j = creator ? await mid('/dlc/creators/' + creator + '/items', [{ ...base, q: text, search: text }, { page: pg, limit: lim }])
        : text ? await mid('/dlc/search', [{ ...base, q: text, query: text, search: text }, { q: text, category, page: pg, limit: lim }])
        : await mid('/dlc/catalog', [base, { page: pg, limit: lim }]);
      const arr = list(j), pp = pagination(j, arr.length);
      return { results: arr, base: MID, more: pp.pages ? pp.page < pp.pages : arr.length >= lim };
    });
  }
  throw [404, 'Unknown endpoint.'];
}

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
