// ─────────────────────────────────────────────────────────────────
// RupeeRates — Daily Scraper v3
//
// Strategy: scrape masarif.ae which aggregates rates from all major
// UAE exchange houses in plain HTML — no Puppeteer needed for these.
// Falls back to GCC Exchange direct scrape (already working).
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

// ── Extract a rate number from HTML near a pattern ────────────────
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

// ── Scrape masarif.ae for a specific exchange + currency ──────────
// Returns the Transfer Rate (best rate customer gets for remittance)
async function masarifRate(exchangeSlug, currencySlug, min, max) {
  const pageUrl = `https://masarif.ae/currency-exchanges/${exchangeSlug}/currency-exchange-rates/${currencySlug}`;
  try {
    const html = await fetch(pageUrl);
    // Table format: | Buy Rate | Sell Rate | Transfer Rate | Updated At |
    // We want Transfer Rate (first row = most recent)
    const tableMatch = html.match(/Transfer Rate[\s\S]{0,200}?(\d{2,3}\.\d{2,4})/i);
    if (tableMatch) {
      const v = parseFloat(tableMatch[1]);
      if (v >= min && v <= max) return v;
    }
    // Fallback: try Buy Rate
    const buyMatch = html.match(/Buy Rate[\s\S]{0,200}?(\d{2,3}\.\d{2,4})/i);
    if (buyMatch) {
      const v = parseFloat(buyMatch[1]);
      if (v >= min && v <= max) return v;
    }
    return null;
  } catch(e) {
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

// ── GCC Exchange direct (already proven to work) ──────────────────
async function scrapeGCCDirect() {
  try {
    const html = await fetch('https://www.gccexchange.com/uae-currency-exchange-rates');
    const aed  = pluck(html, 'INR', 20, 35);
    return { AED: aed, source: 'direct' };
  } catch(e) { return { error: e.message }; }
}

// ── Provider definitions ──────────────────────────────────────────
// masarif slug → what currencies to fetch
const MASARIF_PROVIDERS = [
  {
    id: 'al_ansari', name: 'Al Ansari Exchange', city: 'Dubai', country: 'UAE', logo: 'AA',
    url: 'https://alansariexchange.com/service/foreign-exchange/',
    slug: 'al-ansari-exchange',
    currencies: { AED: { slug:'inr', min:20, max:35 }, SAR: { slug:'inr', min:18, max:30 } }
  },
  {
    id: 'lulu', name: 'LuLu Exchange', city: 'Dubai', country: 'UAE', logo: 'LE',
    url: 'https://luluexchange.com/currency-converter/',
    slug: 'lulu-international-exchange',
    currencies: { AED: { slug:'inr', min:20, max:35 }, SAR: { slug:'inr', min:18, max:30 } }
  },
  {
    id: 'al_fardan', name: 'Al Fardan Exchange', city: 'Dubai', country: 'UAE', logo: 'AF',
    url: 'https://alfardanexchange.com/todays-exchange-rates',
    slug: 'al-fardan-exchange',
    currencies: { AED: { slug:'inr', min:20, max:35 } }
  },
  {
    id: 'wallstreet', name: 'Wall Street Exchange', city: 'Dubai', country: 'UAE', logo: 'WS',
    url: 'https://www.wallstreet.ae/personal/foreign-exchange',
    slug: 'wall-street-exchange',
    currencies: { AED: { slug:'inr', min:20, max:35 } }
  },
  {
    id: 'orient', name: 'Orient Exchange', city: 'Dubai', country: 'UAE', logo: 'OE',
    url: 'https://orientexchange.ae/',
    slug: 'orient-exchange-co-l-l-c',
    currencies: { AED: { slug:'inr', min:20, max:35 } }
  },
  {
    id: 'unimoni', name: 'Unimoni Exchange', city: 'Dubai', country: 'UAE', logo: 'UN',
    url: 'https://unimoni.ae/',
    slug: 'unimoni-uae',
    currencies: { AED: { slug:'inr', min:20, max:35 } }
  },
  {
    id: 'joyalukkas', name: 'Joyalukkas Exchange', city: 'Dubai', country: 'UAE', logo: 'JE',
    url: 'https://joyalukkasexchange.com/',
    slug: 'joyalukkas-exchange',
    currencies: { AED: { slug:'inr', min:20, max:35 } }
  },
];

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  console.log('RupeeRates scraper v3 starting —', new Date().toISOString());
  console.log('Strategy: masarif.ae aggregator (no browser needed)\n');

  // 1. Mid-market rates
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
      rates[currency] = await masarifRate(p.slug, cfg.slug, cfg.min, cfg.max);
      // Small delay to be polite
      await new Promise(r => setTimeout(r, 500));
    }
    providers[p.id] = {
      name: p.name, city: p.city, country: p.country,
      logo: p.logo, url: p.url, ...rates, source: 'masarif.ae',
    };
    const vals = Object.entries(rates).filter(([,v])=>v).map(([k,v])=>`${k}=${v}`);
    console.log(`  [${p.name}] ${vals.length ? vals.join('  ') : '✗ no rates found'}`);
  }

  // 3. GCC Exchange direct (as backup / cross-check)
  console.log('\nScraping GCC Exchange direct...');
  const gcc = await scrapeGCCDirect();
  if (gcc.AED) {
    providers['gcc'] = {
      name: 'GCC Exchange', city: 'Dubai', country: 'UAE', logo: 'GC',
      url: 'https://www.gccexchange.com/uae-currency-exchange-rates',
      AED: gcc.AED, source: 'direct',
    };
    console.log(`  [GCC Exchange] AED=${gcc.AED}`);
  }

  // 4. Write output
  const output = {
    scrapedAt: new Date().toISOString(),
    midRates:  midRates || {},
    providers,
  };

  fs.writeFileSync('rates.json', JSON.stringify(output, null, 2));
  console.log('\n✓ rates.json written —', new Date().toISOString());
  console.log('  Providers with rates:', Object.values(providers).filter(p => p.AED || p.SAR || p.KWD).length);
})();
