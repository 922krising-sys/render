// ─────────────────────────────────────────────────────────────────
// RupeeRates — Daily Scraper
// Runs in GitHub Actions (free). Visits each exchange house website
// using a headless browser, extracts INR rates, saves to rates.json.
// ─────────────────────────────────────────────────────────────────

const puppeteer = require('puppeteer');
const fs        = require('fs');

// ── Helpers ───────────────────────────────────────────────────────

// Launch one shared browser for all scrapes
let browser;
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  return browser;
}

// Open a page, wait for content, return full HTML
async function getPage(url, waitFor, timeoutMs = 30000) {
  const b    = await getBrowser();
  const page = await b.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 900 });
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 12000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500)); // let any final JS settle
    const html = await page.content();
    return html;
  } finally {
    await page.close();
  }
}

// Find a rate number in a block of HTML near a currency label
// Returns a float or null
function pluck(html, currencyRegex, min, max) {
  // Strip HTML tags for cleaner matching
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const patterns = [
    new RegExp(currencyRegex + '[^\\d]{0,80}([\\d]{1,3}\\.[\\d]{2,4})', 'i'),
    new RegExp('([\\d]{1,3}\\.[\\d]{2,4})[^\\d]{0,80}' + currencyRegex, 'i'),
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const v = parseFloat(m[1]);
      if (v >= min && v <= max) return v;
    }
  }
  return null;
}

// Also try to find numbers embedded in JSON blobs on the page
function pluckFromJSON(html, key, min, max) {
  const patterns = [
    new RegExp('"' + key + '"\\s*:\\s*"?([\\d]{1,3}\\.[\\d]{2,4})', 'gi'),
    new RegExp("'" + key + "'\\s*:\\s*'?([\\d]{1,3}\\.[\\d]{2,4})", 'gi'),
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(html)) !== null) {
      const v = parseFloat(m[1]);
      if (v >= min && v <= max) return v;
    }
  }
  return null;
}

function log(name, rates) {
  const parts = Object.entries(rates)
    .filter(([k]) => !['source','error','city','country','url','name','logo'].includes(k))
    .map(([k,v]) => `${k}=${v ?? '—'}`);
  console.log(`  [${name}] ${rates.error ? '✗ ' + rates.error : parts.join('  ')}`);
}

// ── Individual scrapers ───────────────────────────────────────────

async function scrapeAlAnsari() {
  try {
    const html = await getPage(
      'https://alansariexchange.com/service/foreign-exchange/',
      '.exchange-rates, .rates-section, table, [class*="rate"]'
    );
    // Also check for inline JSON state
    const aed = pluckFromJSON(html, 'INR', 20, 35) || pluck(html, 'INR', 20, 35);
    return {
      AED: aed,
      SAR: pluck(html, 'SAR', 18, 30),
      USD: pluck(html, 'USD', 70, 100),
      GBP: pluck(html, 'GBP', 90, 135),
      EUR: pluck(html, 'EUR', 80, 120),
      source: 'browser',
    };
  } catch (e) { return { error: e.message.slice(0, 120), source: 'failed' }; }
}

async function scrapeLuLu() {
  try {
    const html = await getPage(
      'https://luluexchange.com/currency-converter/',
      'table, [class*="rate"], [class*="currency"]'
    );
    return {
      AED: pluckFromJSON(html, 'AED', 20, 35) || pluck(html, 'AED', 20, 35),
      SAR: pluck(html, 'SAR', 18, 30),
      USD: pluck(html, 'USD', 70, 100),
      GBP: pluck(html, 'GBP', 90, 135),
      EUR: pluck(html, 'EUR', 80, 120),
      KWD: pluck(html, 'KWD', 200, 320),
      source: 'browser',
    };
  } catch (e) { return { error: e.message.slice(0, 120), source: 'failed' }; }
}

async function scrapeAlFardan() {
  try {
    const html = await getPage(
      'https://alfardanexchange.com/todays-exchange-rates',
      'table, [class*="rate"], [class*="exchange"]'
    );
    return {
      AED: pluck(html, 'INR', 20, 35),
      SAR: pluck(html, 'SAR', 18, 30),
      USD: pluck(html, 'USD', 70, 100),
      GBP: pluck(html, 'GBP', 90, 135),
      EUR: pluck(html, 'EUR', 80, 120),
      source: 'browser',
    };
  } catch (e) { return { error: e.message.slice(0, 120), source: 'failed' }; }
}

async function scrapeGCC() {
  try {
    const html = await getPage(
      'https://www.gccexchange.com/uae-currency-exchange-rates',
      'table, [class*="rate"], [class*="currency"]'
    );
    return {
      AED: pluckFromJSON(html, 'INR', 20, 35) || pluck(html, 'INR', 20, 35),
      SAR: pluck(html, 'SAR', 18, 30),
      USD: pluck(html, 'USD', 70, 100),
      GBP: pluck(html, 'GBP', 90, 135),
      EUR: pluck(html, 'EUR', 80, 120),
      source: 'browser',
    };
  } catch (e) { return { error: e.message.slice(0, 120), source: 'failed' }; }
}

async function scrapeWallStreet() {
  try {
    const html = await getPage(
      'https://www.wallstreet.ae/personal/foreign-exchange',
      'table, [class*="rate"], [class*="currency"]'
    );
    return {
      AED: pluck(html, 'INR', 20, 35),
      SAR: pluck(html, 'SAR', 18, 30),
      USD: pluck(html, 'USD', 70, 100),
      GBP: pluck(html, 'GBP', 90, 135),
      EUR: pluck(html, 'EUR', 80, 120),
      source: 'browser',
    };
  } catch (e) { return { error: e.message.slice(0, 120), source: 'failed' }; }
}

async function scrapeKIECO() {
  try {
    const html = await getPage('https://kiecokw.com/', '[class*="rate"], select, .calculator');
    return {
      KWD: pluck(html, 'KWD|INR|India', 200, 320),
      source: 'browser',
    };
  } catch (e) { return { error: e.message.slice(0, 120), source: 'failed' }; }
}

async function scrapeBEC() {
  try {
    const html = await getPage('https://www.bec.com.kw/', '[class*="rate"], [class*="currency"], table');
    return {
      KWD: pluck(html, 'INR|India', 200, 320),
      source: 'browser',
    };
  } catch (e) { return { error: e.message.slice(0, 120), source: 'failed' }; }
}

async function scrapeTahweel() {
  try {
    const html = await getPage(
      'https://www.tahweelalrajhi.com.sa/product-and-service/best-exchange-rate',
      'table, [class*="rate"], [class*="currency"]'
    );
    return {
      SAR: pluck(html, 'INR|India', 18, 30),
      source: 'browser',
    };
  } catch (e) { return { error: e.message.slice(0, 120), source: 'failed' }; }
}

// Also fetch mid-market rates from ExchangeRate-API (no JS needed, plain JSON)
async function fetchMidRates() {
  try {
    const b    = await getBrowser();
    const page = await b.newPage();
    const resp = await page.goto('https://api.exchangerate-api.com/v4/latest/INR', { waitUntil: 'load', timeout: 15000 });
    const body = await resp.text();
    await page.close();
    const data  = JSON.parse(body);
    const pairs = ['AED','SAR','USD','GBP','EUR','QAR','KWD','BHD','OMR'];
    const rates = {};
    for (const c of pairs) {
      if (data.rates[c]) rates[c] = parseFloat((1 / data.rates[c]).toFixed(4));
    }
    return rates;
  } catch (e) {
    console.warn('  [mid-rates] Failed:', e.message);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────

const PROVIDERS = [
  { id:'al_ansari',  name:'Al Ansari Exchange',  city:'Dubai',       country:'UAE',    logo:'AA', url:'https://alansariexchange.com/service/foreign-exchange/',                  fn: scrapeAlAnsari  },
  { id:'lulu',       name:'LuLu Exchange',        city:'Dubai',       country:'UAE',    logo:'LE', url:'https://luluexchange.com/currency-converter/',                            fn: scrapeLuLu     },
  { id:'al_fardan',  name:'Al Fardan Exchange',   city:'Dubai',       country:'UAE',    logo:'AF', url:'https://alfardanexchange.com/todays-exchange-rates',                      fn: scrapeAlFardan },
  { id:'gcc',        name:'GCC Exchange',         city:'Dubai',       country:'UAE',    logo:'GC', url:'https://www.gccexchange.com/uae-currency-exchange-rates',                 fn: scrapeGCC      },
  { id:'wallstreet', name:'Wall Street Exchange', city:'Dubai',       country:'UAE',    logo:'WS', url:'https://www.wallstreet.ae/personal/foreign-exchange',                     fn: scrapeWallStreet},
  { id:'kieco',      name:'KIECO',                city:'Kuwait City', country:'Kuwait', logo:'KI', url:'https://kiecokw.com/',                                                    fn: scrapeKIECO    },
  { id:'bec',        name:'BEC Exchange',         city:'Kuwait City', country:'Kuwait', logo:'BE', url:'https://www.bec.com.kw/',                                                 fn: scrapeBEC      },
  { id:'tahweel',    name:'Tahweel Al Rajhi',     city:'Riyadh',      country:'Saudi',  logo:'TR', url:'https://www.tahweelalrajhi.com.sa/product-and-service/best-exchange-rate',fn: scrapeTahweel  },
];

(async () => {
  console.log('RupeeRates scraper starting —', new Date().toISOString());

  // Run all scrapers in parallel
  console.log('\nScraping exchange houses...');
  const results = await Promise.allSettled(
    PROVIDERS.map(p => p.fn().then(r => ({ ...r, _id: p.id })))
  );

  const providers = {};
  results.forEach((r, i) => {
    const p   = PROVIDERS[i];
    const val = r.status === 'fulfilled' ? r.value : { error: r.reason?.message?.slice(0,120), source: 'failed' };
    const { _id, ...rates } = val;
    providers[p.id] = { name: p.name, city: p.city, country: p.country, logo: p.logo, url: p.url, ...rates };
    log(p.name, providers[p.id]);
  });

  // Fetch mid-market rates
  console.log('\nFetching mid-market rates...');
  const midRates = await fetchMidRates();
  if (midRates) console.log('  [mid-rates]', Object.entries(midRates).map(([k,v])=>`${k}=${v}`).join('  '));

  await browser?.close();

  // Build final output
  const output = {
    scrapedAt:  new Date().toISOString(),
    midRates:   midRates || {},
    providers,
  };

  fs.writeFileSync('rates.json', JSON.stringify(output, null, 2));
  console.log('\n✓ rates.json written —', new Date().toISOString());
})();
