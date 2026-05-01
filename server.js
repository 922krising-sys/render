// ─────────────────────────────────────────────────────────────────────────────
// RupeeRates — Rate Proxy Server
// Deploy to Render.com, Railway.app, or any Node.js host (free tier works)
//
// HOW TO DEPLOY (takes 10 minutes, free):
//   1. Create a free account at render.com
//   2. New → Web Service → paste your GitHub repo (or upload this file)
//   3. Build command: npm install
//   4. Start command: node server.js
//   5. Done — you get a URL like https://rupeerates-proxy.onrender.com
//   6. Paste that URL into your website's PROXY_URL constant
// ─────────────────────────────────────────────────────────────────────────────

const https  = require('https');
const http   = require('http');
const url    = require('url');

const PORT   = process.env.PORT || 3001;
const CORS   = '*'; // allow your website to call this

// ── Rate cache — refresh every 60 minutes ──────────────────────────────────
let cache = { rates: null, fetchedAt: null };
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Fetch helpers ───────────────────────────────────────────────────────────
function fetchPage(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control':   'no-cache',
        ...extraHeaders,
      },
      timeout: 12000,
    };

    const req = lib.request(options, (res) => {
      // follow one redirect
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return fetchPage(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end',  ()    => resolve(body));
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── Try to fetch JSON from an API endpoint ──────────────────────────────────
function fetchJSON(apiUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    fetchPage(apiUrl, { 'Accept': 'application/json', ...extraHeaders })
      .then(body => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Not JSON')); }
      })
      .catch(reject);
  });
}

// ── Extract a rate from HTML using regex patterns ───────────────────────────
function extractRate(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const val = parseFloat(match[1] || match[2]);
      if (val && val > 1 && val < 500) return val;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER SCRAPERS
// Each returns { AED, SAR, USD, GBP, EUR, QAR } or throws
// ─────────────────────────────────────────────────────────────────────────────

// ── AL ANSARI ─────────────────────────────────────────────────────────────────
// Their site has a currency converter widget — rates are sometimes embedded
// in the initial HTML or loaded via an internal API call.
async function fetchAlAnsari() {
  // Try their known internal API endpoints first
  const apiEndpoints = [
    'https://alansariexchange.com/wp-json/alansari/v1/exchange-rates',
    'https://alansariexchange.com/wp-admin/admin-ajax.php?action=get_exchange_rates',
    'https://alansariexchange.com/api/rates',
  ];

  for (const endpoint of apiEndpoints) {
    try {
      const data = await fetchJSON(endpoint, {
        'Referer': 'https://alansariexchange.com/service/foreign-exchange/',
        'X-Requested-With': 'XMLHttpRequest',
      });
      // Try to find INR rates in various response shapes
      const inr = findINRInObject(data, 'AED');
      if (inr) {
        return {
          AED: inr,
          SAR: findINRInObject(data, 'SAR'),
          USD: findINRInObject(data, 'USD'),
          GBP: findINRInObject(data, 'GBP'),
          EUR: findINRInObject(data, 'EUR'),
          QAR: findINRInObject(data, 'QAR'),
          source: 'api',
        };
      }
    } catch (_) {}
  }

  // Fall back: parse the HTML page
  const html = await fetchPage('https://alansariexchange.com/service/foreign-exchange/');

  return {
    AED: extractRate(html, [
      /INR[^}]{0,200}["']?sell["']?\s*[:\s]+([\d.]+)/i,
      /AED[^}]{0,300}INR[^}]{0,100}([\d.]{4,7})/i,
      /"INR"[^}]{0,100}"sell_rate"\s*:\s*"?([\d.]+)/i,
      /india[^}]{0,200}(2[0-9]\.[0-9]{1,4})/i,
    ]),
    SAR: extractRate(html, [/SAR[^}]{0,200}INR[^}]{0,100}([\d.]{4,7})/i]),
    USD: extractRate(html, [/USD[^}]{0,200}INR[^}]{0,100}(7[0-9]\.[0-9]{1,4}|8[0-9]\.[0-9]{1,4})/i]),
    GBP: extractRate(html, [/GBP[^}]{0,200}INR[^}]{0,100}(9[0-9]\.[0-9]{1,4}|1[0-2][0-9]\.[0-9]{1,4})/i]),
    source: 'html',
  };
}

// ── LULU EXCHANGE ─────────────────────────────────────────────────────────────
// LuLu loads rates via a WordPress AJAX endpoint or REST API
async function fetchLulu() {
  const apiEndpoints = [
    'https://luluexchange.com/wp-json/lulu/v1/rates',
    'https://luluexchange.com/wp-json/lulu/v1/currency-rates',
    'https://luluexchange.com/wp-admin/admin-ajax.php?action=get_rates',
    'https://luluexchange.com/api/rates',
    'https://luluexchange.com/rates.json',
  ];

  for (const endpoint of apiEndpoints) {
    try {
      const data = await fetchJSON(endpoint, {
        'Referer': 'https://luluexchange.com/currency-converter/',
        'X-Requested-With': 'XMLHttpRequest',
      });
      const inr = findINRInObject(data, 'AED');
      if (inr) {
        return {
          AED: inr,
          SAR: findINRInObject(data, 'SAR'),
          USD: findINRInObject(data, 'USD'),
          GBP: findINRInObject(data, 'GBP'),
          EUR: findINRInObject(data, 'EUR'),
          QAR: findINRInObject(data, 'QAR'),
          source: 'api',
        };
      }
    } catch (_) {}
  }

  // HTML fallback
  const html = await fetchPage('https://luluexchange.com/currency-converter/', {
    'Referer': 'https://luluexchange.com/',
  });

  return {
    AED: extractRate(html, [
      /INR[^}]{0,200}(2[0-9]\.[0-9]{2,4})/i,
      /AED[^}]{0,200}INR[^}]{0,100}([\d]{2,3}\.[0-9]{2,4})/i,
      /"INR"[^}]*"([\d.]{4,8})"/i,
    ]),
    SAR: extractRate(html, [/SAR[^}]{0,200}INR[^}]{0,100}([\d.]{4,7})/i]),
    USD: extractRate(html, [/USD[^}]{0,200}INR[^}]{0,100}(7[0-9]\.|8[0-9]\.)([\d]{2,4})/i]),
    GBP: extractRate(html, [/GBP[^}]{0,200}INR[^}]{0,100}(9[0-9]\.|1[0-2][0-9]\.)([\d]{2,4})/i]),
    source: 'html',
  };
}

// ── AL FARDAN ─────────────────────────────────────────────────────────────────
// Al Fardan uses Cloudflare challenge on HTML, but may have JSON API
async function fetchAlFardan() {
  const apiEndpoints = [
    'https://alfardanexchange.com/api/rates',
    'https://alfardanexchange.com/api/exchange-rates',
    'https://alfardanexchange.com/wp-json/alfardan/v1/rates',
    'https://alfardanexchange.com/api/v1/rates?from=AED&to=INR',
  ];

  for (const endpoint of apiEndpoints) {
    try {
      const data = await fetchJSON(endpoint, {
        'Referer': 'https://alfardanexchange.com/todays-exchange-rates',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      });
      const inr = findINRInObject(data, 'AED');
      if (inr) {
        return {
          AED: inr,
          SAR: findINRInObject(data, 'SAR'),
          USD: findINRInObject(data, 'USD'),
          GBP: findINRInObject(data, 'GBP'),
          EUR: findINRInObject(data, 'EUR'),
          QAR: findINRInObject(data, 'QAR'),
          source: 'api',
        };
      }
    } catch (_) {}
  }

  // Al Fardan blocks non-JS requests at page level — mark as unavailable
  // but return a structure so the front end knows why
  return {
    AED: null, SAR: null, USD: null, GBP: null, EUR: null, QAR: null,
    source: 'blocked',
    note: 'Al Fardan uses Cloudflare bot protection. Check manually at alfardanexchange.com',
  };
}

// ── Helper: search a JSON object for INR rate for a given base currency ──────
function findINRInObject(obj, baseCurr) {
  if (!obj || typeof obj !== 'object') return null;
  const str = JSON.stringify(obj).toLowerCase();

  // Look for patterns like {"AED": {"INR": 25.45}} or {"currency":"INR","rate":25.45,"base":"AED"}
  const patterns = [
    new RegExp(`"${baseCurr.toLowerCase()}"[^}]{0,200}"inr"[^:]{0,20}:["\\s]*(2[0-9]\\.[0-9]{1,6}|7[0-9]\\.[0-9]{1,6}|8[0-9]\\.[0-9]{1,6}|9[0-9]\\.[0-9]{1,6}|1[0-9]{2}\\.[0-9]{1,6})`, 'i'),
    new RegExp(`"inr"[^}]{0,200}"${baseCurr.toLowerCase()}"[^:]{0,20}:["\\s]*(2[0-9]\\.[0-9]{1,6}|7[0-9]\\.[0-9]{1,6}|8[0-9]\\.[0-9]{1,6})`, 'i'),
    new RegExp(`"rate"[^:]{0,10}:["\\s]*(2[0-9]\\.[0-9]{1,6})`, 'i'),
  ];

  for (const p of patterns) {
    const m = str.match(p);
    if (m) {
      const val = parseFloat(m[1]);
      if (val > 1 && val < 500) return val;
    }
  }

  // Recursive search
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object') {
      const found = findINRInObject(obj[key], baseCurr);
      if (found) return found;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FETCH — runs all three in parallel
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAllRates() {
  console.log('[rates] Fetching all providers...');

  const [aa, lulu, af] = await Promise.allSettled([
    fetchAlAnsari(),
    fetchLulu(),
    fetchAlFardan(),
  ]);

  const result = {
    fetchedAt: new Date().toISOString(),
    providers: {
      al_ansari: {
        name: 'Al Ansari Exchange',
        url:  'https://alansariexchange.com/service/foreign-exchange/',
        logo: 'AA',
        ...(aa.status === 'fulfilled' ? aa.value : { error: aa.reason?.message, AED:null, SAR:null, USD:null, GBP:null }),
      },
      lulu: {
        name: 'LuLu Exchange',
        url:  'https://luluexchange.com/currency-converter/',
        logo: 'LE',
        ...(lulu.status === 'fulfilled' ? lulu.value : { error: lulu.reason?.message, AED:null, SAR:null, USD:null, GBP:null }),
      },
      al_fardan: {
        name: 'Al Fardan Exchange',
        url:  'https://alfardanexchange.com/todays-exchange-rates',
        logo: 'AF',
        ...(af.status === 'fulfilled' ? af.value : { error: af.reason?.message, AED:null, SAR:null, USD:null, GBP:null }),
      },
    },
  };

  console.log('[rates] Done:', JSON.stringify({
    al_ansari_AED: result.providers.al_ansari.AED,
    lulu_AED:      result.providers.lulu.AED,
    al_fardan_AED: result.providers.al_fardan.AED,
  }));

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP SERVER
// ─────────────────────────────────────────────────────────────────────────────
async function getRate(forceRefresh = false) {
  const stale = !cache.fetchedAt || (Date.now() - new Date(cache.fetchedAt).getTime()) > CACHE_TTL_MS;
  if (stale || forceRefresh) {
    cache = await fetchAllRates();
  }
  return cache;
}

const server = http.createServer(async (req, res) => {
  const parsed  = url.parse(req.url, true);
  const path    = parsed.pathname;
  const force   = parsed.query.refresh === '1';

  // CORS headers — allow any origin so your website can call this
  res.setHeader('Access-Control-Allow-Origin',  CORS);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (path === '/rates' || path === '/') {
    try {
      const data = await getRate(force);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, ...data }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (path === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, cached: cache.fetchedAt || null }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT}`);
  console.log(`[server] GET /rates       — fetch all provider rates`);
  console.log(`[server] GET /rates?refresh=1 — force fresh fetch`);
  console.log(`[server] GET /health      — health check`);
  // Pre-warm cache on startup
  getRate().catch(err => console.error('[server] Pre-warm failed:', err.message));
});
