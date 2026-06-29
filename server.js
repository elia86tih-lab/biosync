const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = 4000;

// === GitHub config (runtime-updatable) ===
function loadEnv() {
  if (fs.existsSync('.env')) {
    const env = fs.readFileSync('.env', 'utf8');
    env.split('\n').forEach(line => {
      const i = line.indexOf('=');
      if (i > 0) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
  }
}
loadEnv();

let GH_TOKEN = process.env.GITHUB_TOKEN || '';
let GH_REPO = process.env.GITHUB_REPO || '';
let GH_PATH = process.env.GITHUB_PATH || 'data.json';
let GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
let GH_ACTIVE = !!(GH_TOKEN && GH_REPO);

function saveEnv() {
  const c = `GITHUB_TOKEN=${GH_TOKEN}\nGITHUB_REPO=${GH_REPO}\nGITHUB_PATH=${GH_PATH}\nGITHUB_BRANCH=${GH_BRANCH}\n`;
  fs.writeFileSync('.env', c, 'utf8');
}

// === GitHub API helpers ===
let _ghTimer, _ghPending = null, _ghStatus = 'idle';

function ghApi(url, opts) {
  return fetch('https://api.github.com' + url, {
    ...opts,
    headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Content-Type': 'application/json', ...opts?.headers }
  });
}

async function ghGetSha() {
  if (!GH_ACTIVE) return null;
  const r = await ghApi(`/repos/${GH_REPO}/contents/${GH_PATH}?ref=${GH_BRANCH}`);
  if (!r.ok) return null;
  const j = await r.json();
  return j.sha || null;
}

async function ghCommit(json) {
  if (!GH_ACTIVE) return;
  _ghStatus = 'syncing';
  try {
    const sha = await ghGetSha();
    const content = Buffer.from(JSON.stringify(json, null, 2)).toString('base64');
    const body = { message: `Auto-save ${new Date().toISOString().slice(0,10)}`, content, branch: GH_BRANCH };
    if (sha) body.sha = sha;
    const r = await ghApi(`/repos/${GH_REPO}/contents/${GH_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
    _ghStatus = r.ok ? 'synced' : 'error';
    if (!r.ok) {
      const ej = await r.json().catch(() => ({}));
      console.error('GitHub error:', r.status, ej.message || '');
    }
  } catch (e) {
    _ghStatus = 'error';
    console.error('GitHub sync error:', e.message);
  }
}

function debouncedGhCommit(json) {
  _ghPending = json;
  clearTimeout(_ghTimer);
  _ghTimer = setTimeout(async () => {
    const d = _ghPending;
    _ghPending = null;
    await ghCommit(d);
  }, 3000);
}

async function loadFromGitHub() {
  try {
    if (!GH_ACTIVE) return;
    if (fs.existsSync(DATA_FILE)) return;
    console.log('data.json not found locally, fetching from GitHub...');
    const sha = await ghGetSha();
    if (!sha) { console.log('Nothing found on GitHub.'); return; }
    const r = await ghApi(`/repos/${GH_REPO}/contents/${GH_PATH}`, { headers: { Accept: 'application/vnd.github.raw' } });
    if (!r.ok) return;
    const text = await r.text();
    fs.writeFileSync(DATA_FILE, text, 'utf8');
    console.log('Loaded data.json from GitHub.');
  } catch(e) {
    console.error('Error loading from GitHub:', e.message);
  }
}

// === HTTP server ===
function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // GET /api/data
  if (req.method === 'GET' && req.url === '/api/data') {
    fs.readFile(DATA_FILE, 'utf8', (err, data) => {
      if (err) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    });
    return;
  }

  // POST /api/data
  if (req.method === 'POST' && req.url === '/api/data') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      fs.writeFile(DATA_FILE, body, 'utf8', err => {
        if (err) { res.writeHead(500); res.end('Write error'); return; }
        if (GH_ACTIVE) {
          try { debouncedGhCommit(JSON.parse(body)); } catch (e) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, gh: GH_ACTIVE }));
      });
    });
    return;
  }

  // POST /api/config — update GitHub config at runtime
  if (req.method === 'POST' && req.url === '/api/config') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        if (cfg.token !== undefined) GH_TOKEN = cfg.token;
        if (cfg.repo !== undefined) GH_REPO = cfg.repo;
        if (cfg.path !== undefined) GH_PATH = cfg.path;
        if (cfg.branch !== undefined) GH_BRANCH = cfg.branch;
        GH_ACTIVE = !!(GH_TOKEN && GH_REPO);
        saveEnv();
        _ghStatus = 'idle';
        console.log(`GitHub config updated. Active: ${GH_ACTIVE} (${GH_REPO})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, gh: GH_ACTIVE }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET /api/status
  if (req.method === 'GET' && req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      gh: GH_ACTIVE,
      ghStatus: _ghStatus,
      ghRepo: GH_REPO,
      updatedAt: fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).mtime.toISOString() : null
    }));
    return;
  }

  // Static files
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  let ext = path.extname(filePath);
  let mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };
  serveFile(res, filePath, mime[ext] || 'application/octet-stream');
});

server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  if (GH_ACTIVE) console.log(`GitHub sync active: ${GH_REPO}/${GH_PATH}`);
  else console.log('GitHub sync inactive. Use app Settings to connect.');
});
loadFromGitHub();
