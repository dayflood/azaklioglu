const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
function findPublicDir() {
  const candidates = [
    path.join(__dirname, '..', 'Web-Surumu'),
    path.join(__dirname, '..', 'shared-app'),
    path.join(__dirname, 'public'),
    path.join(__dirname, '..'),
    __dirname
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) {
      return c;
    }
  }
  return __dirname;
}
const PUBLIC_DIR = findPublicDir();


// Klasörleri hazırla
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Varsayılan veritabanı şablonu
function getBlankDb() {
  return {
    customers: [],
    transactions: [],
    products: [],
    orders: [],
    settings: { name: '', phone: '', address: '' },
    _deleted: { customers: [], transactions: [], products: [], orders: [] },
    lastUpdated: Date.now()
  };
}

// Veritabanını oku
function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.customers) && Array.isArray(parsed.transactions)) {
        parsed.settings = parsed.settings || { name: '', phone: '', address: '' };
        parsed.products = Array.isArray(parsed.products) ? parsed.products : [];
        parsed.orders = Array.isArray(parsed.orders) ? parsed.orders : [];
        parsed._deleted = parsed._deleted || { customers: [], transactions: [], products: [], orders: [] };
        return parsed;
      }
    }
  } catch (err) {
    console.error('[HATA] Veritabanı okunamadı, varsayılan oluşturuluyor:', err.message);
  }
  const blank = getBlankDb();
  saveDb(blank);
  return blank;
}

// Veritabanını kaydet
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

// Akıllı Birleştirme (Smart Merge)
function mergeDatabases(local, remote) {
  if (!remote) return local;

  const result = {
    settings: { ...(local.settings || {}), ...(remote.settings || {}) },
    _deleted: {
      customers: Array.from(new Set([...(local._deleted?.customers || []), ...(remote._deleted?.customers || [])])),
      transactions: Array.from(new Set([...(local._deleted?.transactions || []), ...(remote._deleted?.transactions || [])])),
      products: Array.from(new Set([...(local._deleted?.products || []), ...(remote._deleted?.products || [])])),
      orders: Array.from(new Set([...(local._deleted?.orders || []), ...(remote._deleted?.orders || [])]))
    },
    customers: [],
    transactions: [],
    products: [],
    orders: [],
    lastUpdated: Date.now()
  };

  // Müşterileri birleştir
  const custMap = new Map();
  for (const c of (local.customers || [])) {
    if (!result._deleted.customers.includes(c.id)) custMap.set(c.id, c);
  }
  for (const c of (remote.customers || [])) {
    if (!result._deleted.customers.includes(c.id)) {
      // Varsa en günceli veya bilgileri koru
      custMap.set(c.id, { ...(custMap.get(c.id) || {}), ...c });
    }
  }
  result.customers = Array.from(custMap.values());

  // Hareketleri (Transactions) birleştir
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

  // Ürünleri birleştir
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

  // Siparişleri birleştir
  const orderMap = new Map();
  for (const o of (local.orders || [])) {
    if (!result._deleted.orders.includes(o.id)) orderMap.set(o.id, o);
  }
  for (const o of (remote.orders || [])) {
    if (!result._deleted.orders.includes(o.id)) {
      orderMap.set(o.id, { ...(orderMap.get(o.id) || {}), ...o });
    }
  }
  result.orders = Array.from(orderMap.values());

  return result;
}

let currentDb = loadDb();

// Yerel IP adreslerini bul
function getLocalIps() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results;
}

// HTTP Sunucu
const server = http.createServer((req, res) => {
  // CORS başlıkları
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // API: Durum & Bilgi
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'online',
      serverTime: new Date().toISOString(),
      localIps: getLocalIps(),
      port: PORT,
      clientsCount: wss ? wss.clients.size : 0,
      customerCount: currentDb.customers.length,
      txCount: currentDb.transactions.length,
      orderCount: (currentDb.orders || []).length
    }));
    return;
  }

  // API: Veri Çek
  if (url.pathname === '/api/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, data: currentDb }));
    return;
  }

  // API: Senkronizasyon (HTTP POST)
  if (url.pathname === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const incomingDb = payload.data || payload;
        const clientId = payload.clientId || 'http-client';
        
        currentDb = mergeDatabases(currentDb, incomingDb);
        saveDb(currentDb);

        // Bağlı tüm WebSocket istemcilerine yay
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

  // Statik Dosya Sunumu
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

// WebSocket Sunucusu
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('error', (err) => {
  // EADDRINUSE veya soket hatalarını sessizce yakala
});

function broadcastSync(data, senderId) {
  const message = JSON.stringify({
    type: 'SYNC_UPDATE',
    data,
    senderId,
    timestamp: Date.now()
  });

  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
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

wss.on('connection', (ws, req) => {
  // İlk bağlantıda mevcut veritabanını gönder
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
        const clientDb = msg.data;
        const senderId = msg.clientId;

        currentDb = mergeDatabases(currentDb, clientDb);
        saveDb(currentDb);

        // Herkese yay
        broadcastSync(currentDb, senderId);
      } else if (msg.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
      }
    } catch (e) {
      console.error('[WS HATA] Mesaj işlenemedi:', e.message);
    }
  });

  ws.on('close', () => {
    broadcastClientCount();
  });
});

// Hata yönetimi (port çakışması vb.)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const ips = getLocalIps();
    console.log('\n================================================================');
    console.log('   AZAKLIOĞLU VERESİYE DEFTERİ - SUNUCU ZATEN ÇALIŞIYOR        ');
    console.log('================================================================');
    console.log(`💻 Sunucu şu anda arka planda zaten aktif durumda (Port: ${PORT}).`);
    console.log(`💻 Bilgisayardan Aç:              http://localhost:${PORT}`);
    if (ips.length > 0) {
      console.log(`📱 Telefondan Aç (Aynı Wi-Fi):    http://${ips[0]}:${PORT}`);
    }
    console.log('🌐 Durum:                          Canlı Senkronizasyon Açık');
    console.log('================================================================\n');
  } else {
    console.error('[HATA] Sunucu başlatılamadı:', err.message);
  }
});

// Sunucuyu başlat
server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIps();
  console.log('\n================================================================');
  console.log('       AZAKLIOĞLU VERESİYE DEFTERİ - SUNUCU AKTİF              ');
  console.log('================================================================');
  console.log(`💻 Bilgisayardan Tarayıcıyla Aç:   http://localhost:${PORT}`);
  if (ips.length > 0) {
    console.log(`📱 Telefondan Aç (Aynı Wi-Fi):    http://${ips[0]}:${PORT}`);
    if (ips.length > 1) {
      for (let i = 1; i < ips.length; i++) {
        console.log(`   (Alternatif IP):                http://${ips[i]}:${PORT}`);
      }
    }
  }
  console.log(`🌐 Canlı WebSocket:               ws://localhost:${PORT}/ws`);
  console.log('✨ Telefonda yaptıklarınız anında buraya, buradakiler telefona aktarılır!');
  console.log('================================================================\n');
});
