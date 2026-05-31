// ─────────────────────────────────────────────────────────────────
// RupeeRates — Proxy Server (free-tier edition)
//
// Rates are scraped by GitHub Actions daily and saved to rates.json.
// This server just reads that file and serves it — no Puppeteer,
// runs fine on Render free tier.
//
// Endpoints:
//   GET  /rates      — scraped provider rates (from rates.json)
//   GET  /mid-rates  — mid-market rates (from rates.json)
//   POST /scan       — photo scan via Claude vision API
//   GET  /health     — server status
//
// Environment variables (Render dashboard):
//   ANTHROPIC_API_KEY  — from console.anthropic.com
// ─────────────────────────────────────────────────────────────────

const https  = require('https');
const http   = require('http');
const urlMod = require('url');
const fs     = require('fs');
const path   = require('path');

const PORT          = process.env.PORT || 3001;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const RATES_FILE    = path.join(__dirname, 'rates.json');

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function loadRates() {
  try {
    return JSON.parse(fs.readFileSync(RATES_FILE, 'utf8'));
  } catch (_) {
    return { scrapedAt: null, midRates: {}, providers: {} };
  }
}

function httpPost(targetUrl, payload, extraHeaders) {
  return new Promise((resolve, reject) => {
    const parsed = urlMod.parse(targetUrl);
    const body   = JSON.stringify(payload);
    const req    = https.request({
      hostname: parsed.hostname, path: parsed.path, method: 'POST',
      headers: { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders },
      timeout: 30000,
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d)); });
    req.on('error', reject);
    req.on('timeout', ()=>{ req.destroy(); reject(new Error('Timeout')); });
    req.write(body); req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 15e6) reject(new Error('Too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleScan(imageBase64, mediaType) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set — add it in Render environment variables');
  const result = await httpPost(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-opus-4-5', max_tokens: 400,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: `Extract all visible exchange rates TO Indian Rupees (INR) from this image.
Look for: AED, SAR, USD, GBP, EUR, QAR, KWD, OMR, BHD.
Use the SELLING or REMITTANCE rate.
Respond ONLY with valid JSON: {"AED":25.45,"SAR":22.08,"confidence":"high","notes":"..."}
If unclear: {"error":"Cannot read rates from image"}` }
      ]}]
    },
    { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }
  );
  const data  = JSON.parse(result);
  const text  = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON from Claude');
  return JSON.parse(match[0]);
}

const server = http.createServer(async (req, res) => {
  const parsed = urlMod.parse(req.url, true);
  const route  = parsed.pathname;
  setCORS(res);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (route === '/health') {
    const d = loadRates();
    res.writeHead(200);
    res.end(JSON.stringify({ ok:true, scrapedAt: d.scrapedAt||'never', providers: Object.keys(d.providers||{}).length }));
    return;
  }

  if (route === '/rates' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok:true, ...loadRates() }));
    return;
  }

  if (route === '/mid-rates' && req.method === 'GET') {
    const d = loadRates();
    res.writeHead(200);
    res.end(JSON.stringify({ ok:true, rates: d.midRates||{}, fetchedAt: d.scrapedAt }));
    return;
  }

  if (route === '/scan' && req.method === 'POST') {
    try {
      const { image, mediaType } = JSON.parse(await readBody(req));
      if (!image) throw new Error('No image');
      res.writeHead(200);
      res.end(JSON.stringify({ ok:true, ...await handleScan(image, mediaType) }));
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
  const d = loadRates();
  console.log(`[server] RupeeRates — port ${PORT}`);
  console.log(`[server] rates.json: ${d.scrapedAt ? 'loaded ('+d.scrapedAt+')' : 'not found — waiting for first GitHub Actions run'}`);
  console.log(`[server] Providers:  ${Object.keys(d.providers||{}).length}`);
  console.log(`[server] Anthropic:  ${ANTHROPIC_KEY ? 'configured' : 'MISSING'}`);
});
