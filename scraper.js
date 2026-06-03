// ─────────────────────────────────────────────────────────────────
// RupeeRates — Daily Scraper v4
//
// Strategy: scrape masarif.ae which aggregates rates from all major
// UAE exchange houses in plain HTML — no Puppeteer needed.
//
// Key fix from v3: masarif table columns are:
//   | Buy Rate | Sell Rate | Transfer Rate | Updated At |
// v3 was grabbing Buy Rate (e.g. 33.33 for cash) instead of
// Transfer Rate (e.g. 25.00 for remittance). v4 parses the first
// data row's 3rd <td> directly.
//
// Runs via GitHub Actions daily at 6am UAE time.
// Writes results to rates.json.
// ─────────────────────────────────────────────────────────────────

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const url   = require('url');

// ── HTTP fetch helper ─────────────────────────────────────────────
function fetch(targetUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req    = lib.request({
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
        'Accept':     'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: timeoutMs,
    }, (res) => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location)
        return fetch(res.headers.location, timeoutMs).then(resolve).catch(reject);
      let body = '';
      res.on('data', c => body += c);
      res.on('end',  () => resolve(body));
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── Parse masarif.ae table: get Transfer Rate from first data row ─
// Table: | Buy Rate | Sell Rate | Transfer Rate | Updated At |
// We want column index 2 (0-based) = Transfer Rate
function parseTransferRate(html, min, max) {
  // Find the <tbody> section
  const tbodyMatch = html.match(/<tbody[\s\S]*?<\/tbody>/i);
  if (!tbodyMatch) return null;
  
  // Get the first <tr> in tbody (most recent entry)
  const firstRow = tbodyMatch[0].match(/<tr[\s\S]*?<\/tr>/i);
  if (!firstRow) return null;
  
  // Extract all <td> values
  const tds = [];
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = tdRe.exec(firstRow[0])) !== null) {
    // Strip any HTML tags inside the td and trim
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    tds.push(text);
  }
  
  // Column 2 (index 2) = Transfer Rate
  if (tds.length >= 3) {
    const v = parseFloat(tds[2]);
    if (!isNaN(v) && v >= min && v <= max) return v;
  }
  
  // Fallback: try column 0 (Buy Rate) only if within remittance range
  // (some providers don't have Transfer Rate)
  if (tds.length >= 1) {
    const v = parseFloat(tds[0]);
    if (!isNaN(v) && v >= min && v <= max) return v;
  }
  
  return null;
}

// ── Scrape masarif.ae for a specific exchange + currency ──────────
async function masarifRate(exchangeSlug, currencySlug, min, max) {
  const pageUrl = `https://masarif.ae/currency-exchanges/${exchangeSlug}/currency-exchange-rates/${currencySlug}`;
  try {
    const html = await fetch(pageUrl);
    return parseTransferRate(html, min, max);
  } catch(e) {
    console.warn(`    fetch error: ${e.message}`);
    return null;
  }
}

// ── Mid-market rates from ExchangeRate-API ────────────────────────
async function fetchMidRates() {
  try {
    const body  = await fetch('https://api.exchangerate-api.com/v4/latest/INR');
    const data  = JSON.parse(body);
    const pairs = ['AED','SAR','USD','GBP','EUR','QAR','KWD','BHD','OMR'];
    const rates = {};
    for (const c of pairs) {
      if (data.rates[c]) rates[c] = parseFloat((1 / data.rates[c]).toFixed(4));
    }
    return rates;
  } catch(e) {
    console.warn('  [mid-rates] Failed:', e.message);
    return null;
  }
}

// ── GCC Exchange direct (proven to work) ─────────────────────────
function pluck(text, pattern, min, max) {
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const regexes = [
    new RegExp(pattern + '[^\\d]{0,60}([\\d]{1,3}\\.[\\d]{2,4})', 'i'),
    new RegExp('([\\d]{1,3}\\.[\\d]{2,4})[^\\d]{0,60}' + pattern, 'i'),
  ];
  for (const r of regexes) {
    const m = clean.match(r);
    if (m) {
      const v = parseFloat(m[1]);
      if (v >= min && v <= max) return v;
    }
  }
  return null;
}

async function scrapeGCCDirect() {
  try {
    const html = await fetch('https://www.gccexchange.com/uae-currency-exchange-rates');
    const aed  = pluck(html, 'INR', 20, 35);
    return { AED: aed };
  } catch(e) { return {}; }
}

// ── Validate a scraped rate makes sense ───────────────────────────
// Cross-check against mid-market: reject if more than 3% away
// (catches bogus numbers like 22.49 when real rate is ~25.9)
function validate(rate, midRate, tolerancePct = 3) {
  if (!rate || !midRate) return rate;
  const pctDiff = Math.abs(rate - midRate) / midRate * 100;
  if (pctDiff > tolerancePct) {
    console.warn(`    ⚠ rate ${rate} is ${pctDiff.toFixed(1)}% from mid-market ${midRate} — rejected`);
    return null;
  }
  return rate;
}

// ── Provider definitions ──────────────────────────────────────────
const MASARIF_PROVIDERS = [
  {
    id: 'al_ansari', name: 'Al Ansari Exchange', city: 'Dubai', country: 'UAE', logo: 'AA',
    url: 'https://alansariexchange.com/service/foreign-exchange/',
    slug: 'al-ansari-exchange',
    currencies: { AED: { slug:'inr', min:22, max:28 } }
  },
  {
    id: 'lulu', name: 'LuLu Exchange', city: 'Dubai', country: 'UAE', logo: 'LE',
    url: 'https://luluexchange.com/currency-converter/',
    slug: 'lulu-international-exchange',
    currencies: { AED: { slug:'inr', min:22, max:28 } }
  },
  {
    id: 'al_fardan', name: 'Al Fardan Exchange', city: 'Dubai', country: 'UAE', logo: 'AF',
    url: 'https://alfardanexchange.com/todays-exchange-rates',
    slug: 'al-fardan-exchange',
    currencies: { AED: { slug:'inr', min:22, max:28 } }
  },
  {
    id: 'wallstreet', name: 'Wall Street Exchange', city: 'Dubai', country: 'UAE', logo: 'WS',
    url: 'https://www.wallstreet.ae/personal/foreign-exchange',
    slug: 'wall-street-exchange',
    currencies: { AED: { slug:'inr', min:22, max:28 } }
  },
  {
    id: 'orient', name: 'Orient Exchange', city: 'Dubai', country: 'UAE', logo: 'OE',
    url: 'https://orientexchange.ae/',
    slug: 'orient-exchange-co-l-l-c',
    currencies: { AED: { slug:'inr', min:22, max:28 } }
  },
  {
    id: 'unimoni', name: 'Unimoni Exchange', city: 'Dubai', country: 'UAE', logo: 'UN',
    url: 'https://unimoni.ae/',
    slug: 'unimoni-uae',
    currencies: { AED: { slug:'inr', min:22, max:28 } }
  },
  {
    id: 'joyalukkas', name: 'Joyalukkas Exchange', city: 'Dubai', country: 'UAE', logo: 'JE',
    url: 'https://joyalukkasexchange.com/',
    slug: 'joyalukkas-exchange',
    currencies: { AED: { slug:'inr', min:22, max:28 } }
  },
];

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  console.log('RupeeRates scraper v4 —', new Date().toISOString());
  console.log('Fix: reads Transfer Rate column (col 2) not Buy Rate (col 0)\n');

  // 1. Mid-market rates (used for validation)
  console.log('Fetching mid-market rates...');
  const midRates = await fetchMidRates();
  if (midRates) {
    console.log('  [mid-rates]', Object.entries(midRates).map(([k,v])=>`${k}=${v}`).join('  '));
  }

  // 2. Scrape all providers via masarif.ae
  console.log('\nScraping exchange houses via masarif.ae...');
  const providers = {};

  for (const p of MASARIF_PROVIDERS) {
    const rates = {};
    for (const [currency, cfg] of Object.entries(p.currencies)) {
      const raw = await masarifRate(p.slug, cfg.slug, cfg.min, cfg.max);
      // Validate against mid-market (reject if >3% off)
      rates[currency] = validate(raw, midRates && midRates[currency]);
      await new Promise(r => setTimeout(r, 600));
    }
    
    const hasRates = Object.values(rates).some(v => v !== null);
    if (hasRates) {
      providers[p.id] = {
        name: p.name, city: p.city, country: p.country,
        logo: p.logo, url: p.url, ...rates, source: 'masarif.ae',
      };
    }
    const vals = Object.entries(rates).filter(([,v])=>v).map(([k,v])=>`${k}=${v}`);
    console.log(`  [${p.name}] ${vals.length ? vals.join('  ') : '✗ no valid rates'}`);
  }

  // 3. GCC Exchange direct (cross-check)
  console.log('\nScraping GCC Exchange direct...');
  const gcc = await scrapeGCCDirect();
  const gccAED = validate(gcc.AED, midRates && midRates.AED);
  if (gccAED) {
    providers['gcc'] = {
      name: 'GCC Exchange', city: 'Dubai', country: 'UAE', logo: 'GC',
      url: 'https://www.gccexchange.com/uae-currency-exchange-rates',
      AED: gccAED, source: 'direct',
    };
    console.log(`  [GCC Exchange] AED=${gccAED}`);
  }

  // 4. Write output
  const output = {
    scrapedAt: new Date().toISOString(),
    midRates:  midRates || {},
    providers,
  };

  fs.writeFileSync('rates.json', JSON.stringify(output, null, 2));
  console.log('\n✓ rates.json written —', new Date().toISOString());
  const withRates = Object.values(providers).filter(p => p.AED || p.SAR || p.KWD).length;
  console.log(`  Providers with valid rates: ${withRates} / ${Object.keys(providers).length}`);
})();
