// ─────────────────────────────────────────────────────────────────
// RupeeRates — Proxy Server v2
//
// Endpoints:
//   GET  /rates       — scraped rates from exchange house websites
//   GET  /mid-rates   — live mid-market rates (ExchangeRate-API)
//   POST /scan        — photo scan via Claude vision
//   GET  /health      — health check + cache status
//
// Environment variables (set in Render dashboard):
//   ANTHROPIC_API_KEY  — from console.anthropic.com
//
// Puppeteer is used to render JS-heavy exchange house pages.
// Falls back to static HTML fetch if Puppeteer unavailable.
// All results cached and refreshed on a daily schedule (6am UAE time).
// ─────────────────────────────────────────────────────────────────

const https   = require('https');
const http    = require('http');
const urlMod  = require('url');

const PORT          = process.env.PORT || 3001;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── Try to load Puppeteer (installed via package.json) ────────────
let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch(_) {
  console.warn('[puppeteer] Not available — will use HTTP fallback');
}

// ═════════════════════════════════════════════════════════════════
// UTILITIES
// ═════════════════════════════════════════════════════════════════

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10e6) reject(new Error('Too large')); });
    req.on('end',   () => resolve(body));
    req.on('error', reject);
  });
}

function httpGet(targetUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = urlMod.parse(targetUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req    = lib.request({
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   opts.method || 'GET',
      headers: {
        'User-Agent':   'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0',
        'Accept':       opts.accept || 'application/json, text/html, */*',
        'Content-Type': opts.contentType || 'application/json',
        ...opts.headers,
      },
      timeout: 20000,
    }, (res) => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location)
        return httpGet(res.headers.location, opts).then(resolve).catch(reject);
      let body = '';
      res.on('data', c => body += c);
      res.on('end',  () => resolve(body));
    });
    if (opts.body) req.write(opts.body);
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// Launch a headless browser, navigate, wait for selector, return page content
async function browserFetch(url, waitSelector, timeoutMs = 25000) {
  if (!puppeteer) throw new Error('puppeteer_unavailable');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--single-process'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 10000 }).catch(() => {});
    }
    // Extra wait for any post-load JS
    await new Promise(r => setTimeout(r, 2000));
    return await page.content();
  } finally {
    await browser.close();
  }
}

// Pull a number that looks like an INR rate from text near a currency label
function pluckRate(text, currencyLabel, minVal, maxVal) {
  // Look for the currency label then a plausible rate number nearby
  const patterns = [
    new RegExp(currencyLabel + '[^\\d]{0,60}([\\d]{1,3}\\.[\\d]{2,4})', 'i'),
    new RegExp('([\\d]{1,3}\\.[\\d]{2,4})[^\\d]{0,60}' + currencyLabel, 'i'),
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const v = parseFloat(m[1]);
      if (v >= minVal && v <= maxVal) return v;
    }
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════
// EXCHANGE HOUSE SCRAPERS
// Each returns: { AED, SAR, USD, GBP, EUR, QAR, KWD, source, error? }
// ═════════════════════════════════════════════════════════════════

// ── Al Ansari Exchange (UAE) ─────────────────────────────────────
async function scrapeAlAnsari() {
  // Try their undocumented JSON endpoint first — it's the cleanest
  const apiUrls = [
    'https://alansariexchange.com/wp-json/alansari/v1/exchange-rates',
    'https://alansariexchange.com/wp-json/wp/v2/exchange_rates',
    'https://alansariexchange.com/api/rates',
  ];
  for (const ep of apiUrls) {
    try {
      const body = await httpGet(ep, { accept: 'application/json' });
      const data = JSON.parse(body);
      const s    = JSON.stringify(data);
      const inr  = (label) => {
        const m = s.match(new RegExp('"' + label + '"[^}]{0,300}([2-9][0-9]\\.[0-9]{2,4})', 'i'));
        return m ? parseFloat(m[1]) : null;
      };
      if (inr('AED') || inr('INR')) {
        return { AED: inr('AED'), SAR: inr('SAR'), USD: inr('USD'),
                 GBP: inr('GBP'), EUR: inr('EUR'), source: 'api' };
      }
    } catch (_) {}
  }
  // Fallback: browser render
  try {
    const html = await browserFetch(
      'https://alansariexchange.com/service/foreign-exchange/',
      '.exchange-rate, .rate-table, [class*="rate"]'
    );
    return {
      AED: pluckRate(html, 'INR', 20, 35),
      SAR: pluckRate(html, 'SAR.*?INR|INR.*?SAR', 18, 30),
      USD: pluckRate(html, 'USD.*?INR|INR.*?USD', 70, 100),
      GBP: pluckRate(html, 'GBP.*?INR|INR.*?GBP', 90, 130),
      EUR: pluckRate(html, 'EUR.*?INR|INR.*?EUR', 80, 115),
      source: 'browser',
    };
  } catch (e) {
    return { error: e.message, source: 'failed' };
  }
}

// ── LuLu Exchange (UAE/Kuwait) ───────────────────────────────────
async function scrapeLuLu() {
  // LuLu has a React app — need browser render
  try {
    const html = await browserFetch(
      'https://luluexchange.com/currency-converter/',
      '.rates-table, .currency-rate, [class*="rate"], table'
    );
    // LuLu shows rates in a table: currency | buy | sell
    // We want the "sell" rate (what customer gets sending to India)
    const rows = html.match(/INR[\s\S]{0,200}?(\d{2,3}\.\d{2,4})/gi) || [];
    let aed = pluckRate(html, 'AED', 20, 35);
    // Also try extracting from JSON embedded in page
    const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);
    if (jsonMatch) {
      try {
        const state = JSON.parse(jsonMatch[1]);
        const s = JSON.stringify(state);
        aed = aed || parseFloat((s.match(/"AED"[^}]{0,200}([2-9]\d\.\d{2,4})/) || [])[1]);
      } catch(_) {}
    }
    return {
      AED: aed,
      SAR: pluckRate(html, 'SAR', 18, 30),
      USD: pluckRate(html, 'USD', 70, 100),
      GBP: pluckRate(html, 'GBP', 90, 130),
      EUR: pluckRate(html, 'EUR', 80, 115),
      KWD: pluckRate(html, 'KWD', 200, 320),
      source: 'browser',
    };
  } catch (e) {
    return { error: e.message, source: 'failed' };
  }
}

// ── Al Fardan Exchange (UAE) ─────────────────────────────────────
async function scrapeAlFardan() {
  try {
    const html = await browserFetch(
      'https://alfardanexchange.com/todays-exchange-rates',
      'table, .rate, [class*="exchange"]'
    );
    return {
      AED: pluckRate(html, 'INR', 20, 35),
      SAR: pluckRate(html, 'SAR', 18, 30),
      USD: pluckRate(html, 'USD', 70, 100),
      GBP: pluckRate(html, 'GBP', 90, 130),
      EUR: pluckRate(html, 'EUR', 80, 115),
      source: 'browser',
    };
  } catch (e) {
    return { error: e.message, source: 'failed' };
  }
}

// ── GCC Exchange (UAE) ───────────────────────────────────────────
async function scrapeGCC() {
  try {
    // GCC has a PHP-rendered rates page — try direct first
    const html = await httpGet('https://www.gccexchange.com/uae-currency-exchange-rates');
    const aed  = pluckRate(html, 'INR', 20, 35);
    if (aed) {
      return {
        AED: aed,
        SAR: pluckRate(html, 'SAR', 18, 30),
        USD: pluckRate(html, 'USD', 70, 100),
        GBP: pluckRate(html, 'GBP', 90, 130),
        EUR: pluckRate(html, 'EUR', 80, 115),
        source: 'html',
      };
    }
    // Fallback to browser
    const html2 = await browserFetch(
      'https://www.gccexchange.com/uae-currency-exchange-rates',
      'table, .rate-row, [class*="rate"]'
    );
    return {
      AED: pluckRate(html2, 'INR', 20, 35),
      SAR: pluckRate(html2, 'SAR', 18, 30),
      USD: pluckRate(html2, 'USD', 70, 100),
      GBP: pluckRate(html2, 'GBP', 90, 130),
      EUR: pluckRate(html2, 'EUR', 80, 115),
      source: 'browser',
    };
  } catch (e) {
    return { error: e.message, source: 'failed' };
  }
}

// ── Wall Street Exchange (UAE) ───────────────────────────────────
async function scrapeWallStreet() {
  try {
    const html = await browserFetch(
      'https://www.wallstreet.ae/personal/foreign-exchange',
      'table, .rate, [class*="currency"], [class*="exchange"]'
    );
    return {
      AED: pluckRate(html, 'INR', 20, 35),
      SAR: pluckRate(html, 'SAR', 18, 30),
      USD: pluckRate(html, 'USD', 70, 100),
      GBP: pluckRate(html, 'GBP', 90, 130),
      EUR: pluckRate(html, 'EUR', 80, 115),
      source: 'browser',
    };
  } catch (e) {
    return { error: e.message, source: 'failed' };
  }
}

// ── KIECO — Kuwait India Exchange ───────────────────────────────
async function scrapeKIECO() {
  try {
    // KIECO has a live calculator — interact with it via browser
    const html = await browserFetch(
      'https://kiecokw.com/',
      '[class*="rate"], .exchange-rate, select'
    );
    // Their calculator shows KWD→INR; look for the rate
    return {
      KWD: pluckRate(html, 'KWD|India|INR', 200, 320),
      source: 'browser',
    };
  } catch (e) {
    return { error: e.message, source: 'failed' };
  }
}

// ── BEC Kuwait ───────────────────────────────────────────────────
async function scrapeBEC() {
  try {
    const html = await browserFetch(
      'https://www.bec.com.kw/',
      '[class*="rate"], .currency, table'
    );
    return {
      KWD: pluckRate(html, 'INR|India', 200, 320),
      source: 'browser',
    };
  } catch (e) {
    return { error: e.message, source: 'failed' };
  }
}

// ── Tahweel Al Rajhi (Saudi Arabia) ─────────────────────────────
async function scrapeTahweel() {
  try {
    const html = await browserFetch(
      'https://www.tahweelalrajhi.com.sa/product-and-service/best-exchange-rate',
      'table, [class*="rate"], [class*="currency"]'
    );
    return {
      SAR: pluckRate(html, 'INR|India', 18, 30),
      source: 'browser',
    };
  } catch (e) {
    return { error: e.message, source: 'failed' };
  }
}

// ═════════════════════════════════════════════════════════════════
// RATE AGGREGATOR
// Runs all scrapers in parallel, assembles a unified result
// ═════════════════════════════════════════════════════════════════

// Provider metadata — name, city, country, logo initials, source URL
const PROVIDERS = [
  { id:'al_ansari',  name:'Al Ansari Exchange',   city:'Dubai',       country:'UAE',    logo:'AA', url:'https://alansariexchange.com/service/foreign-exchange/',         fn: scrapeAlAnsari  },
  { id:'lulu_uae',   name:'LuLu Exchange',         city:'Dubai',       country:'UAE',    logo:'LE', url:'https://luluexchange.com/currency-converter/',                   fn: scrapeLuLu     },
  { id:'al_fardan',  name:'Al Fardan Exchange',    city:'Dubai',       country:'UAE',    logo:'AF', url:'https://alfardanexchange.com/todays-exchange-rates',             fn: scrapeAlFardan },
  { id:'gcc',        name:'GCC Exchange',          city:'Dubai',       country:'UAE',    logo:'GC', url:'https://www.gccexchange.com/uae-currency-exchange-rates',        fn: scrapeGCC      },
  { id:'wallstreet', name:'Wall Street Exchange',  city:'Dubai',       country:'UAE',    logo:'WS', url:'https://www.wallstreet.ae/personal/foreign-exchange',            fn: scrapeWallStreet},
  { id:'kieco',      name:'KIECO',                 city:'Kuwait City', country:'Kuwait', logo:'KI', url:'https://kiecokw.com/',                                           fn: scrapeKIECO    },
  { id:'bec',        name:'BEC Exchange',          city:'Kuwait City', country:'Kuwait', logo:'BE', url:'https://www.bec.com.kw/',                                        fn: scrapeBEC      },
  { id:'tahweel',    name:'Tahweel Al Rajhi',      city:'Riyadh',      country:'Saudi',  logo:'TR', url:'https://www.tahweelalrajhi.com.sa/product-and-service/best-exchange-rate', fn: scrapeTahweel },
];

let scraperCache = { data: null, fetchedAt: null };
const SCRAPER_CACHE_TTL = 23 * 60 * 60 * 1000; // 23 hours

async function runAllScrapers(force = false) {
  const stale = !scraperCache.fetchedAt ||
    (Date.now() - new Date(scraperCache.fetchedAt).getTime()) > SCRAPER_CACHE_TTL;
  if (!stale && !force) return scraperCache;

  console.log('[scrapers] Starting full scrape of', PROVIDERS.length, 'providers...');
  const start = Date.now();

  const results = await Promise.allSettled(
    PROVIDERS.map(p => p.fn().then(r => ({ ...r, _id: p.id })).catch(e => ({ error: e.message, source: 'failed', _id: p.id })))
  );

  const providers = {};
  results.forEach((r, i) => {
    const p   = PROVIDERS[i];
    const val = r.status === 'fulfilled' ? r.value : { error: r.reason?.message, source: 'failed' };
    const { _id, ...rates } = val;
    providers[p.id] = {
      name:    p.name,
      city:    p.city,
      country: p.country,
      logo:    p.logo,
      url:     p.url,
      ...rates,
    };
    const status = val.error ? `✗ ${val.error.slice(0,60)}` : `✓ AED=${val.AED||'?'} SAR=${val.SAR||'?'} KWD=${val.KWD||'?'}`;
    console.log(`[scrapers]   ${p.name}: ${status}`);
  });

  scraperCache = { data: { providers, fetchedAt: new Date().toISOString(), durationMs: Date.now() - start }, fetchedAt: new Date().toISOString() };
  console.log(`[scrapers] Done in ${Date.now() - start}ms`);
  return scraperCache;
}

// ═════════════════════════════════════════════════════════════════
// MID-MARKET RATES (ExchangeRate-API, free tier)
// ═════════════════════════════════════════════════════════════════

let midCache = { data: null, fetchedAt: null };
const MID_CACHE_TTL = 6 * 60 * 60 * 1000;

async function fetchMidRates(force = false) {
  const stale = !midCache.fetchedAt ||
    (Date.now() - new Date(midCache.fetchedAt).getTime()) > MID_CACHE_TTL;
  if (!stale && !force) return midCache;

  console.log('[mid-rates] Fetching...');
  try {
    const body  = await httpGet('https://api.exchangerate-api.com/v4/latest/INR', { accept: 'application/json' });
    const json  = JSON.parse(body);
    const pairs = ['AED','SAR','USD','GBP','EUR','QAR','KWD','BHD','OMR'];
    const rates = {};
    for (const c of pairs) {
      if (json.rates[c]) rates[c] = parseFloat((1 / json.rates[c]).toFixed(4));
    }
    midCache = { data: { rates, fetchedAt: new Date().toISOString() }, fetchedAt: new Date().toISOString() };
    console.log('[mid-rates] OK —', Object.entries(rates).map(([k,v])=>`${k}:${v}`).join(' '));
  } catch (err) {
    console.error('[mid-rates] Failed:', err.message);
    if (!midCache.data) {
      // Hard fallback
      midCache = { data: { rates:{ AED:25.62,SAR:22.21,USD:83.42,GBP:104.80,EUR:89.56,QAR:22.88,KWD:271.40,BHD:221.40,OMR:216.80 }, fetchedAt: new Date().toISOString(), fallback:true }, fetchedAt: new Date().toISOString() };
    }
  }
  return midCache;
}

// ═════════════════════════════════════════════════════════════════
// SCAN — Claude vision API
// ═════════════════════════════════════════════════════════════════

async function handleScan(imageBase64, mediaType) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set in Render environment variables');

  const prompt = `You are a currency rate extraction expert. The image shows an exchange house rate board or screen.

Extract all visible exchange rates TO Indian Rupees (INR).
Look for: AED, SAR, USD, GBP, EUR, QAR, KWD, OMR, BHD.
Use the SELLING or REMITTANCE rate (not buying rate).

Respond ONLY with valid JSON, no markdown, no explanation:
{"AED":25.45,"SAR":22.08,"USD":83.15,"confidence":"high","notes":"..."}
If unclear: {"error":"Cannot read rates from image"}`;

  const payload = JSON.stringify({
    model: 'claude-opus-4-5', max_tokens: 400,
    messages: [{ role:'user', content:[
      { type:'image', source:{ type:'base64', media_type: mediaType||'image/jpeg', data: imageBase64 }},
      { type:'text',  text: prompt }
    ]}]
  });

  const body = await httpGet('https://api.anthropic.com/v1/messages', {
    method:'POST', accept:'application/json', contentType:'application/json',
    headers:{ 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
    body: payload,
  });
  const data  = JSON.parse(body);
  const text  = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON from Claude');
  return JSON.parse(match[0]);
}

// ═════════════════════════════════════════════════════════════════
// DAILY SCHEDULE  — refresh at 6am UAE time (UTC+4) = 02:00 UTC
// ═════════════════════════════════════════════════════════════════

function scheduleDailyRefresh() {
  function msUntilNext2amUTC() {
    const now    = new Date();
    const next   = new Date(now);
    next.setUTCHours(2, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  function scheduleNext() {
    const delay = msUntilNext2amUTC();
    const hrs   = (delay / 3600000).toFixed(1);
    console.log(`[schedule] Next scrape in ${hrs}h (6am UAE time)`);
    setTimeout(async () => {
      console.log('[schedule] Daily refresh triggered');
      await runAllScrapers(true).catch(e => console.error('[schedule] Scrape error:', e.message));
      await fetchMidRates(true).catch(e => console.error('[schedule] Mid-rate error:', e.message));
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

// ═════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const parsed = urlMod.parse(req.url, true);
  const path   = parsed.pathname;
  const force  = parsed.query.refresh === '1';

  setCORS(res);
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /health
  if (path === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      scraperCachedAt: scraperCache.fetchedAt || null,
      midCachedAt:     midCache.fetchedAt     || null,
      puppeteer:       !!puppeteer,
    }));
    return;
  }

  // GET /rates  — scraped provider rates
  if (path === '/rates' && req.method === 'GET') {
    try {
      const result = await runAllScrapers(force);
      res.writeHead(200);
      res.end(JSON.stringify({ ok:true, ...result.data }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok:false, error: e.message }));
    }
    return;
  }

  // GET /mid-rates  — mid-market benchmark rates
  if (path === '/mid-rates' && req.method === 'GET') {
    try {
      const result = await fetchMidRates(force);
      res.writeHead(200);
      res.end(JSON.stringify({ ok:true, ...result.data }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok:false, error: e.message }));
    }
    return;
  }

  // POST /scan  — photo rate extraction
  if (path === '/scan' && req.method === 'POST') {
    try {
      const { image, mediaType } = JSON.parse(await readBody(req));
      if (!image) throw new Error('No image');
      const result = await handleScan(image, mediaType);
      res.writeHead(200);
      res.end(JSON.stringify({ ok:true, ...result }));
    } catch (e) {
      res.writeHead(e.message.includes('API_KEY') ? 503 : 400);
      res.end(JSON.stringify({ ok:false, error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok:false, error:'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[server] RupeeRates Proxy v2 — port ${PORT}`);
  console.log(`[server] Puppeteer: ${puppeteer ? '✓' : '✗ (fallback mode)'}`);
  console.log(`[server] Anthropic key: ${ANTHROPIC_KEY ? '✓' : '✗ missing'}`);

  // Warm up on start — mid-rates immediately, scrapers async
  fetchMidRates().catch(e => console.error('[warmup mid]', e.message));
  runAllScrapers().catch(e => console.error('[warmup scrapers]', e.message));
  scheduleDailyRefresh();
});
