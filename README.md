# RupeeRates

Live FX rate comparison for NRI remittances — AED/INR, SAR/INR, KWD/INR and more.

## Files

| File | What it is |
|---|---|
| `index.html` | Public homepage |
| `business.html` | Business portal (login, rate updates, photo scan) |
| `server.js` | Proxy server — scrapes exchange house sites + serves rates |
| `package.json` | Node.js config (includes Puppeteer) |

## How the scraper works

`server.js` uses Puppeteer (a headless Chrome browser) to visit each exchange house website, wait for rates to load, then extract the INR rate. This is necessary because all Gulf exchange house websites load rates via JavaScript — a plain HTTP fetch only gets an empty page shell.

**Scraped providers:**
- Al Ansari Exchange (Dubai)
- LuLu Exchange (Dubai / Kuwait)
- Al Fardan Exchange (Dubai)
- GCC Exchange (Dubai)
- Wall Street Exchange (Dubai)
- KIECO — Kuwait India Exchange (Kuwait City)
- BEC Exchange (Kuwait City)
- Tahweel Al Rajhi (Riyadh)

**Schedule:** Scraper runs once daily at 6am UAE time (02:00 UTC). Results are cached for 23 hours. Mid-market rates refresh every 6 hours.

## Deploy to Render

### 1. Push files to GitHub
Upload all 4 files to your GitHub repo.

### 2. Create Web Service on Render
- Build command: `npm install`
- Start command: `node server.js`
- Instance type: **Starter ($7/month)** — required for Puppeteer (free tier doesn't have enough RAM)

### 3. Add environment variable
In Render dashboard → Environment:
- Key: `ANTHROPIC_API_KEY`
- Value: your key from console.anthropic.com

### 4. Connect to your website
In `index.html` and `business.html`, find `PROXY_URL` and set it to your Render URL.

## Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /rates` | Scraped rates from all exchange house websites |
| `GET /mid-rates` | Live mid-market rates (benchmark) |
| `POST /scan` | Extract rates from a photo (uses Claude vision) |
| `GET /health` | Server status + cache timestamps |

Add `?refresh=1` to `/rates` or `/mid-rates` to force a fresh fetch.

## Important: Render plan

Puppeteer runs a full headless Chrome browser. This needs more RAM than Render's free tier provides.
Upgrade to **Starter ($7/month)** in your Render service settings. This is unavoidable — all Gulf exchange house sites require JavaScript to display rates.
