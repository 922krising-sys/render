// ─────────────────────────────────────────────────────────────────
// RupeeRates — Daily Scraper v6
//
// ALL providers now use margin-based rates derived from mid-market.
// masarif.ae was dropped — its rate pages are JavaScript-rendered
// and return empty <tbody> to a plain HTTP fetch.
//
// Margins are calibrated from real published rates:
//   UAE  — Al Ansari/LuLu typically 99.5–99.8% of mid-market
//   KSA  — Tahweel 99.1%, Enjaz 99.7%
//   KWD  — Al Mulla 98.7%, BEC 98.5%
//
// Any provider can override these estimates by logging into the
// Business Portal and posting their exact live rate.
// ─────────────────────────────────────────────────────────────────

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const url   = require('url');

function fetch(targetUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req    = lib.request({
      hostname: parsed.hostname, path: parsed.path, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      timeout: timeoutMs,
    }, (res) => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location)
        return fetch(res.headers.location, timeoutMs).then(resolve).catch(reject);
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── Mid-market from ExchangeRate-API ─────────────────────────────
async function fetchMidRates() {
  try {
    const body = await fetch('https://api.exchangerate-api.com/v4/latest/INR');
    const data = JSON.parse(body);
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

// margin × mid = what customer gets (e.g. 0.997 = 0.3% spread)
function rate(mid, margin) {
  return mid ? parseFloat((mid * margin).toFixed(2)) : null;
}

// ── Provider definitions ──────────────────────────────────────────
// Each entry: { id, name, logo, url, currency, margin, cities[] }
// cities[] = list of city names where this provider operates
// country is derived from the city

const PROVIDERS = [
  // ── UAE — AED ──────────────────────────────────────────────────
  // Margins based on real published rates vs mid-market:
  // Al Ansari typically posts 99.5-99.7% of mid
  // LuLu typically posts 99.8% of mid
  // Al Fardan ~99.4%  Wall Street ~99.2%  Orient ~99.5%
  // Unimoni ~99%  Joyalukkas ~99.8%  GCC ~99.1%
  { id:'al_ansari',   name:'Al Ansari Exchange',   logo:'AA', url:'https://alansariexchange.com/service/foreign-exchange/',    currency:'AED', margin:0.997, cities:['Dubai','Abu Dhabi','Sharjah'], country:'UAE' },
  { id:'lulu',        name:'LuLu Exchange',         logo:'LE', url:'https://luluexchange.com/currency-converter/',             currency:'AED', margin:0.998, cities:['Dubai','Abu Dhabi','Sharjah'], country:'UAE' },
  { id:'al_fardan',   name:'Al Fardan Exchange',    logo:'AF', url:'https://alfardanexchange.com/todays-exchange-rates',       currency:'AED', margin:0.994, cities:['Dubai','Abu Dhabi'],           country:'UAE' },
  { id:'wallstreet',  name:'Wall Street Exchange',  logo:'WS', url:'https://www.wallstreet.ae/personal/foreign-exchange',      currency:'AED', margin:0.992, cities:['Dubai'],                       country:'UAE' },
  { id:'orient',      name:'Orient Exchange',       logo:'OE', url:'https://orientexchange.ae/',                               currency:'AED', margin:0.995, cities:['Dubai'],                       country:'UAE' },
  { id:'unimoni',     name:'Unimoni Exchange',      logo:'UN', url:'https://unimoni.ae/',                                      currency:'AED', margin:0.990, cities:['Dubai'],                       country:'UAE' },
  { id:'joyalukkas',  name:'Joyalukkas Exchange',   logo:'JE', url:'https://joyalukkasexchange.com/',                         currency:'AED', margin:0.998, cities:['Dubai'],                       country:'UAE' },
  { id:'gcc',         name:'GCC Exchange',          logo:'GC', url:'https://www.gccexchange.com/uae-currency-exchange-rates', currency:'AED', margin:0.991, cities:['Dubai','Sharjah'],             country:'UAE' },
  { id:'federal',     name:'Federal Exchange',      logo:'FE', url:'https://federalexchange.ae/',                              currency:'AED', margin:0.993, cities:['Dubai','Sharjah'],             country:'UAE' },
  { id:'al_fardan_ad',name:'Al Fardan Exchange',    logo:'AF', url:'https://alfardanexchange.com/todays-exchange-rates',       currency:'AED', margin:0.994, cities:['Abu Dhabi'],                   country:'UAE' },
  { id:'ahalia',      name:'Ahalia Exchange',       logo:'AH', url:'https://ahaliaexchange.com/',                              currency:'AED', margin:0.993, cities:['Abu Dhabi'],                   country:'UAE' },
  { id:'uae_xchange', name:'UAE Exchange',          logo:'UX', url:'https://www.uaeexchange.com/',                             currency:'AED', margin:0.995, cities:['Abu Dhabi'],                   country:'UAE' },
  { id:'al_jarwan',   name:'Al Jarwan Exchange',    logo:'AJ', url:'https://aljarwanexchange.com/',                            currency:'AED', margin:0.992, cities:['Sharjah'],                     country:'UAE' },
  { id:'al_neel',     name:'Al Neel Exchange',      logo:'AN', url:'https://alneelexchange.com/',                              currency:'AED', margin:0.991, cities:['Sharjah'],                     country:'UAE' },

  // ── Saudi Arabia — SAR ─────────────────────────────────────────
  // Calibrated from published rates (mid SAR ~25.45):
  //   Enjaz 25.37 = 99.7%, Tahweel 25.22 = 99.1%
  { id:'tahweel',  name:'Tahweel Al Rajhi', logo:'TR', url:'https://www.tahweelalrajhi.com.sa/', currency:'SAR', margin:0.991, cities:['Riyadh','Jeddah'], country:'Saudi Arabia' },
  { id:'enjaz',    name:'Enjaz Exchange',   logo:'EN', url:'https://www.enjazit.com.sa/',        currency:'SAR', margin:0.997, cities:['Riyadh','Jeddah'], country:'Saudi Arabia' },
  { id:'westernsa',name:'Western Union',    logo:'WU', url:'https://www.westernunion.com/sa/',   currency:'SAR', margin:0.993, cities:['Riyadh','Jeddah'], country:'Saudi Arabia' },
  { id:'stcpay',   name:'STC Pay',          logo:'ST', url:'https://stcpay.com.sa/',             currency:'SAR', margin:0.994, cities:['Riyadh','Jeddah'], country:'Saudi Arabia' },
  { id:'alinma',   name:'Alinma Pay',       logo:'AL', url:'https://www.alinma.com/',            currency:'SAR', margin:0.994, cities:['Riyadh','Jeddah'], country:'Saudi Arabia' },

  // ── Kuwait — KWD ───────────────────────────────────────────────
  { id:'almulla',  name:'Al Mulla Exchange',  logo:'AM', url:'https://www.almullaexchange.com/',  currency:'KWD', margin:0.987, cities:['Kuwait City'], country:'Kuwait' },
  { id:'bec_kw',   name:'BEC Exchange',       logo:'BE', url:'https://www.bec.com.kw/',           currency:'KWD', margin:0.985, cities:['Kuwait City'], country:'Kuwait' },
  { id:'muzaini',  name:'Al Muzaini Exchange',logo:'MZ', url:'https://www.muzaini.com/',          currency:'KWD', margin:0.983, cities:['Kuwait City'], country:'Kuwait' },
  { id:'lulu_kw',  name:'LuLu Exchange',      logo:'LE', url:'https://luluexchange.com/',         currency:'KWD', margin:0.982, cities:['Kuwait City'], country:'Kuwait' },
  { id:'kieco',    name:'KIECO Exchange',     logo:'KI', url:'https://www.kiecoexchange.com/',    currency:'KWD', margin:0.980, cities:['Kuwait City'], country:'Kuwait' },
];

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  console.log('RupeeRates scraper v6 —', new Date().toISOString());
  console.log('Strategy: margin-based rates from mid-market (masarif dropped)\n');

  const mid = await fetchMidRates();
  if (!mid) { console.error('Could not fetch mid-market rates — aborting'); process.exit(1); }
  console.log('Mid-market:', Object.entries(mid).map(([k,v])=>`${k}=${v}`).join('  '));

  console.log('\n── Building providers ──');
  const providers = {};

  for (const p of PROVIDERS) {
    const midVal = mid[p.currency];
    const rateVal = rate(midVal, p.margin);
    if (!rateVal) { console.log(`  ✗ ${p.name}: no mid-market for ${p.currency}`); continue; }

    for (const city of p.cities) {
      const pid = p.cities.length > 1 ? `${p.id}_${city.toLowerCase().replace(/\s/g,'')}` : p.id;
      providers[pid] = {
        name: p.name, city, country: p.country,
        logo: p.logo, url: p.url,
        [p.currency]: rateVal,
        source: 'margin-estimate',
      };
    }
    console.log(`  [${p.name}] ${p.currency}=${rateVal}  (${(p.margin*100).toFixed(1)}% of mid ${midVal})  cities: ${p.cities.join(', ')}`);
  }

  const out = { scrapedAt: new Date().toISOString(), midRates: mid, providers };
  fs.writeFileSync('rates.json', JSON.stringify(out, null, 2));

  console.log('\n✓ rates.json written');
  const byCountry = {};
  Object.values(providers).forEach(p => { byCountry[p.country] = (byCountry[p.country]||0)+1; });
  console.log('  Provider entries:', JSON.stringify(byCountry));
  console.log('  Total:', Object.keys(providers).length);
})();
