// ─────────────────────────────────────────────────────────────────
// RupeeRates — Real Puppeteer Scraper
//
// Run locally on your Mac:
//   npm install puppeteer
//   node scraper.js
//
// Then upload the generated rates.json to your GitHub repo.
// ─────────────────────────────────────────────────────────────────

const puppeteer = require('puppeteer');
const https     = require('https');
const fs        = require('fs');

// ── Helpers ───────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

// Pull the first number in range [min,max] from a string
function extractNum(text, min, max) {
  const matches = text.match(/\d{1,3}[.,]\d{2,4}/g) || [];
  for (const m of matches) {
    const v = parseFloat(m.replace(',', '.'));
    if (v >= min && v <= max) return v;
  }
  return null;
}

// ── Mid-market rates (real, from free API) ────────────────────────
async function fetchMidRates() {
  try {
    const body = await httpGet('https://api.exchangerate-api.com/v4/latest/INR');
    const data = JSON.parse(body);
    const out  = {};
    for (const c of ['AED','SAR','KWD','QAR','OMR','BHD','USD','GBP','EUR']) {
      if (data.rates[c]) out[c] = parseFloat((1 / data.rates[c]).toFixed(4));
    }
    return out;
  } catch(e) { console.error('Mid-rates failed:', e.message); return {}; }
}

// ── Scraper functions — one per exchange house ────────────────────
// Each returns { AED: X } or { SAR: X } etc, or {} on failure

async function scrapeGCC(page) {
  try {
    await page.goto('https://www.gccexchange.com/uae-currency-exchange-rates', { waitUntil:'networkidle2', timeout:30000 });
    await sleep(2000);
    const text = await page.evaluate(() => document.body.innerText);
    // Look for INR row — format is "INR  25.89" or similar
    const m = text.match(/INR[\s\S]{0,30}?(\d{2,3}\.\d{2,4})/);
    if (m) return { AED: parseFloat(m[1]) };
    // Fallback: grab all numbers in AED range and take first
    const v = extractNum(text, 23, 28);
    return v ? { AED: v } : {};
  } catch(e) { console.log('  GCC error:', e.message); return {}; }
}

async function scrapeAlFardan(page) {
  // Their page has a live converter — default shows 1000 AED → X INR
  // We can read the "Receiver will get" field
  try {
    await page.goto('https://alfardanexchange.com/todays-exchange-rates', { waitUntil:'networkidle2', timeout:30000 });
    await sleep(3000);
    // Make sure Transfer Rate is selected (not Cash Rate)
    try {
      const labels = await page.$$('label');
      for (const l of labels) {
        const txt = await page.evaluate(el => el.innerText, l);
        if (txt && txt.toLowerCase().includes('transfer')) { await l.click(); await sleep(1000); break; }
      }
    } catch(_) {}
    const text = await page.evaluate(() => document.body.innerText);
    // Converter shows "25950.03" for 1000 AED — divide by 1000
    const bigMatch = text.match(/(\d{4,6}\.\d{2})/);
    if (bigMatch) {
      const v = parseFloat(bigMatch[1]) / 1000;
      if (v >= 23 && v <= 28) return { AED: parseFloat(v.toFixed(2)) };
    }
    // Or rate shown directly
    const v = extractNum(text, 23, 28);
    return v ? { AED: v } : {};
  } catch(e) { console.log('  AlFardan error:', e.message); return {}; }
}

async function scrapeAlAnsari(page) {
  try {
    await page.goto('https://alansariexchange.com/service/foreign-exchange/', { waitUntil:'networkidle2', timeout:30000 });
    await sleep(3000);
    const text = await page.evaluate(() => document.body.innerText);
    // Look for INR near a rate number
    const m = text.match(/INR[\s\S]{0,50}?(\d{2}\.\d{2,4})/);
    if (m) { const v = parseFloat(m[1]); if (v >= 23 && v <= 28) return { AED: v }; }
    const v = extractNum(text, 23, 28);
    return v ? { AED: v } : {};
  } catch(e) { console.log('  AlAnsari error:', e.message); return {}; }
}

async function scrapeLuLu(page) {
  try {
    await page.goto('https://luluexchange.com/currency-converter/', { waitUntil:'networkidle2', timeout:30000 });
    await sleep(3000);
    // Try to set AED→INR and read result
    try {
      // Select AED as source currency if there's a dropdown
      await page.select('select[name*="from"], select[id*="from"], select:first-of-type', 'AED').catch(()=>{});
      await page.select('select[name*="to"], select[id*="to"], select:last-of-type', 'INR').catch(()=>{});
      await sleep(1500);
    } catch(_) {}
    const text = await page.evaluate(() => document.body.innerText);
    const m = text.match(/INR[\s\S]{0,50}?(\d{2}\.\d{2,4})/);
    if (m) { const v = parseFloat(m[1]); if (v >= 23 && v <= 28) return { AED: v }; }
    const v = extractNum(text, 23, 28);
    return v ? { AED: v } : {};
  } catch(e) { console.log('  LuLu error:', e.message); return {}; }
}

async function scrapeOrient(page) {
  try {
    await page.goto('https://orientexchange.ae/', { waitUntil:'networkidle2', timeout:30000 });
    await sleep(3000);
    const text = await page.evaluate(() => document.body.innerText);
    const m = text.match(/INR[\s\S]{0,50}?(\d{2}\.\d{2,4})/);
    if (m) { const v = parseFloat(m[1]); if (v >= 23 && v <= 28) return { AED: v }; }
    const v = extractNum(text, 23, 28);
    return v ? { AED: v } : {};
  } catch(e) { console.log('  Orient error:', e.message); return {}; }
}

async function scrapeWallStreet(page) {
  try {
    await page.goto('https://www.wallstreet.ae/personal/foreign-exchange', { waitUntil:'networkidle2', timeout:30000 });
    await sleep(3000);
    const text = await page.evaluate(() => document.body.innerText);
    const m = text.match(/INR[\s\S]{0,50}?(\d{2}\.\d{2,4})/);
    if (m) { const v = parseFloat(m[1]); if (v >= 23 && v <= 28) return { AED: v }; }
    return {};
  } catch(e) { console.log('  WallStreet error:', e.message); return {}; }
}

async function scrapeJoyalukkas(page) {
  try {
    await page.goto('https://joyalukkasexchange.com/', { waitUntil:'networkidle2', timeout:30000 });
    await sleep(3000);
    const text = await page.evaluate(() => document.body.innerText);
    const m = text.match(/INR[\s\S]{0,50}?(\d{2}\.\d{2,4})/);
    if (m) { const v = parseFloat(m[1]); if (v >= 23 && v <= 28) return { AED: v }; }
    return {};
  } catch(e) { console.log('  Joyalukkas error:', e.message); return {}; }
}

async function scrapeTahweel(page) {
  // Tahweel Al Rajhi — SAR to INR
  try {
    await page.goto('https://www.tahweelalrajhi.com.sa/en/home', { waitUntil:'networkidle2', timeout:30000 });
    await sleep(3000);
    const text = await page.evaluate(() => document.body.innerText);
    const m = text.match(/INR[\s\S]{0,50}?(\d{2}\.\d{2,4})/);
    if (m) { const v = parseFloat(m[1]); if (v >= 22 && v <= 28) return { SAR: v }; }
    const v = extractNum(text, 22, 28);
    return v ? { SAR: v } : {};
  } catch(e) { console.log('  Tahweel error:', e.message); return {}; }
}

async function scrapeEnjaz(page) {
  try {
    await page.goto('https://www.enjazit.com.sa/en/exchange-rates', { waitUntil:'networkidle2', timeout:30000 });
    await sleep(3000);
    const text = await page.evaluate(() => document.body.innerText);
    const m = text.match(/INR[\s\S]{0,50}?(\d{2}\.\d{2,4})/);
    if (m) { const v = parseFloat(m[1]); if (v >= 22 && v <= 28) return { SAR: v }; }
    return {};
  } catch(e) { console.log('  Enjaz error:', e.message); return {}; }
}

async function scrapeAlMulla(page) {
  // KWD to INR — rate is ~305
  try {
    await page.goto('https://www.almullaexchange.com/', { waitUntil:'networkidle2', timeout:30000 });
    await sleep(3000);
    const text = await page.evaluate(() => document.body.innerText);
    const m = text.match(/INR[\s\S]{0,50}?(\d{3}\.\d{2,4})/);
    if (m) { const v = parseFloat(m[1]); if (v >= 290 && v <= 320) return { KWD: v }; }
    const v = extractNum(text, 290, 320);
    return v ? { KWD: v } : {};
  } catch(e) { console.log('  AlMulla error:', e.message); return {}; }
}

async function scrapeBEC(page) {
  try {
    await page.goto('https://www.bec.com.kw/', { waitUntil:'networkidle2', timeout:30000 });
    await sleep(3000);
    const text = await page.evaluate(() => document.body.innerText);
    const m = text.match(/INR[\s\S]{0,50}?(\d{3}\.\d{2,4})/);
    if (m) { const v = parseFloat(m[1]); if (v >= 290 && v <= 320) return { KWD: v }; }
    return {};
  } catch(e) { console.log('  BEC error:', e.message); return {}; }
}

// ── Provider config ───────────────────────────────────────────────
const PROVIDERS = [
  // UAE — Dubai
  { id:'gcc',        name:'GCC Exchange',        logo:'GC', url:'https://www.gccexchange.com/uae-currency-exchange-rates', cities:['Dubai','Sharjah'],             country:'UAE',          scrape: scrapeGCC        },
  { id:'al_fardan',  name:'Al Fardan Exchange',   logo:'AF', url:'https://alfardanexchange.com/todays-exchange-rates',      cities:['Dubai','Abu Dhabi'],           country:'UAE',          scrape: scrapeAlFardan   },
  { id:'al_ansari',  name:'Al Ansari Exchange',   logo:'AA', url:'https://alansariexchange.com/service/foreign-exchange/',  cities:['Dubai','Abu Dhabi','Sharjah'], country:'UAE',          scrape: scrapeAlAnsari   },
  { id:'lulu',       name:'LuLu Exchange',         logo:'LE', url:'https://luluexchange.com/currency-converter/',           cities:['Dubai','Abu Dhabi','Sharjah'], country:'UAE',          scrape: scrapeLuLu       },
  { id:'orient',     name:'Orient Exchange',       logo:'OE', url:'https://orientexchange.ae/',                             cities:['Dubai'],                       country:'UAE',          scrape: scrapeOrient     },
  { id:'wallstreet', name:'Wall Street Exchange',  logo:'WS', url:'https://www.wallstreet.ae/personal/foreign-exchange',    cities:['Dubai'],                       country:'UAE',          scrape: scrapeWallStreet },
  { id:'joyalukkas', name:'Joyalukkas Exchange',   logo:'JE', url:'https://joyalukkasexchange.com/',                       cities:['Dubai'],                       country:'UAE',          scrape: scrapeJoyalukkas },
  // Saudi Arabia
  { id:'tahweel',    name:'Tahweel Al Rajhi',      logo:'TR', url:'https://www.tahweelalrajhi.com.sa/',                     cities:['Riyadh','Jeddah'],             country:'Saudi Arabia', scrape: scrapeTahweel    },
  { id:'enjaz',      name:'Enjaz Exchange',        logo:'EN', url:'https://www.enjazit.com.sa/en/exchange-rates',           cities:['Riyadh','Jeddah'],             country:'Saudi Arabia', scrape: scrapeEnjaz      },
  // Kuwait
  { id:'almulla',    name:'Al Mulla Exchange',     logo:'AM', url:'https://www.almullaexchange.com/',                       cities:['Kuwait City'],                 country:'Kuwait',       scrape: scrapeAlMulla    },
  { id:'bec_kw',     name:'BEC Exchange',          logo:'BE', url:'https://www.bec.com.kw/',                                cities:['Kuwait City'],                 country:'Kuwait',       scrape: scrapeBEC        },
];

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  console.log('RupeeRates real scraper —', new Date().toISOString());
  console.log('Launching Chrome...\n');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  // 1. Mid-market
  console.log('Fetching mid-market rates...');
  const mid = await fetchMidRates();
  console.log(' ', Object.entries(mid).map(([k,v])=>`${k}=${v}`).join('  '), '\n');

  const providers  = {};
  const rateCache  = {}; // same provider → same rate for all its cities

  for (const p of PROVIDERS) {
    let rates;
    if (rateCache[p.id]) {
      rates = rateCache[p.id];
      console.log(`[${p.name}] cached: ${JSON.stringify(rates)}`);
    } else {
      console.log(`[${p.name}] scraping...`);
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0 Safari/537.36');
      await page.setViewport({ width:1280, height:800 });
      rates = await p.scrape(page);
      await page.close();
      rateCache[p.id] = rates;

      // Validate against mid-market — reject if more than 3% off
      for (const [currency, val] of Object.entries(rates)) {
        if (mid[currency]) {
          const pct = Math.abs(val - mid[currency]) / mid[currency] * 100;
          if (pct > 3) {
            console.log(`  ⚠ ${val} is ${pct.toFixed(1)}% from mid ${mid[currency]} — rejected`);
            delete rates[currency];
          }
        }
      }
      const got = Object.keys(rates).length ? JSON.stringify(rates) : '✗ nothing found';
      console.log(`  → ${got}`);
    }

    // Create a provider entry for each city
    for (const city of p.cities) {
      const pid = p.cities.length > 1 ? `${p.id}_${city.toLowerCase().replace(/\s/g,'')}` : p.id;
      if (Object.keys(rates).length) {
        providers[pid] = { name:p.name, city, country:p.country, logo:p.logo, url:p.url, ...rates, source:'scraped' };
      }
    }
  }

  await browser.close();

  const out = { scrapedAt: new Date().toISOString(), midRates: mid, providers };
  fs.writeFileSync('rates.json', JSON.stringify(out, null, 2));

  console.log('\n✓ rates.json written');
  const byCountry = {};
  Object.values(providers).forEach(p => { byCountry[p.country] = (byCountry[p.country]||0)+1; });
  console.log('  Providers:', JSON.stringify(byCountry));
  console.log('  Total entries:', Object.keys(providers).length);
  console.log('\nNow upload rates.json to your GitHub repo.');
})();
