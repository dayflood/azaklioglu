const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getBlankDb() {
  return {
    customers: [],
    transactions: [],
    products: [],
    settings: { name: '', phone: '', address: '' },
    _deleted: { customers: [], transactions: [], products: [] },
    lastUpdated: Date.now()
  };
}

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.customers) && Array.isArray(parsed.transactions)) {
        parsed.settings = parsed.settings || { name: '', phone: '', address: '' };
        parsed.products = Array.isArray(parsed.products) ? parsed.products : [];
        parsed._deleted = parsed._deleted || { customers: [], transactions: [], products: [] };
        return parsed;
      }
    }
  } catch (err) {
    console.error('[HATA] Veritabanı okunamadı:', err.message);
  }
  const blank = getBlankDb();
  saveDb(blank);
  return blank;
}

function saveDb(data) {
  try {
    data.lastUpdated = Date.now();
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[HATA] Veritabanı kaydedilemedi:', err.message);
    return false;
  }
}

function mergeDatabases(local, remote) {
  if (!remote) return local;

  const result = {
    settings: { ...(local.settings || {}), ...(remote.settings || {}) },
    _deleted: {
      customers: Array.from(new Set([...(local._deleted?.customers || []), ...(remote._deleted?.customers || [])])),
      transactions: Array.from(new Set([...(local._deleted?.transactions || []), ...(remote._deleted?.transactions || [])])),
      products: Array.from(new Set([...(local._deleted?.products || []), ...(remote._deleted?.products || [])]))
    },
    customers: [],
    transactions: [],
    products: [],
    lastUpdated: Date.now()
  };

  const custMap = new Map();
  for (const c of (local.customers || [])) {
    if (!result._deleted.customers.includes(c.id)) custMap.set(c.id, c);
  }
  for (const c of (remote.customers || [])) {
    if (!result._deleted.customers.includes(c.id)) {
      custMap.set(c.id, { ...(custMap.get(c.id) || {}), ...c });
    }
  }
  result.customers = Array.from(custMap.values());

  const txMap = new Map();
  for (const t of (local.transactions || [])) {
    if (!result._deleted.transactions.includes(t.id)) txMap.set(t.id, t);
  }
  for (const t of (remote.transactions || [])) {
    if (!result._deleted.transactions.includes(t.id)) {
      txMap.set(t.id, { ...(txMap.get(t.id) || {}), ...t });
    }
  }
  result.transactions = Array.from(txMap.values());

  const prodMap = new Map();
  for (const p of (local.products || [])) {
    if (!result._deleted.products.includes(p.id)) prodMap.set(p.id, p);
  }
  for (const p of (remote.products || [])) {
    if (!result._deleted.products.includes(p.id)) {
      prodMap.set(p.id, { ...(prodMap.get(p.id) || {}), ...p });
    }
  }
  result.products = Array.from(prodMap.values());

  return result;
}

let currentDb = loadDb();

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'online',
      serverTime: new Date().toISOString(),
      port: PORT,
      clientsCount: wss ? wss.clients.size : 0,
      customerCount: currentDb.customers.length,
      txCount: currentDb.transactions.length
    }));
    return;
  }

  if (url.pathname === '/api/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, data: currentDb }));
    return;
  }

  if (url.pathname === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const incomingDb = payload.data || payload;
        const clientId = payload.clientId || 'client';
        
        currentDb = mergeDatabases(currentDb, incomingDb);
        saveDb(currentDb);

        broadcastSync(currentDb, clientId);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, data: currentDb }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Dosya bulunamadı');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };

    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('error', () => {});

function broadcastSync(data, senderId) {
  const message = JSON.stringify({
    type: 'SYNC_UPDATE',
    data,
    senderId,
    timestamp: Date.now()
  });

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}

function broadcastClientCount() {
  const msg = JSON.stringify({
    type: 'CLIENTS_COUNT',
    count: wss.clients.size
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'INIT',
    data: currentDb,
    clientsCount: wss.clients.size
  }));

  broadcastClientCount();

  ws.on('message', (messageRaw) => {
    try {
      const msg = JSON.parse(messageRaw);
      if (msg.type === 'SYNC_PUSH') {
        currentDb = mergeDatabases(currentDb, msg.data);
        saveDb(currentDb);
        broadcastSync(currentDb, msg.clientId);
      } else if (msg.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    broadcastClientCount();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Azaklıoğlu Bulut Sunucusu çalışıyor: Port ${PORT}`);
});
