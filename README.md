# Asset Tracker

Track all your assets in one place — **Indian stocks (NSE/BSE)**, **crypto** and **gold SIP** — valued with live market prices and stored **encrypted in your browser**. No database needed.

![stack](https://img.shields.io/badge/Node-20%2B-green) ![storage](https://img.shields.io/badge/storage-AES--256--GCM%20localStorage-blue)

## What it does

| Asset | You enter | The app calculates |
|---|---|---|
| Indian stock | Stock (searchable by name), quantity, purchase date. Optional: buy price, brokerage/charges | Buy price = that day's NSE/BSE closing price (previous trading day on holidays) unless you type your own. Invested value, live price, current value, day change, P&L |
| Crypto | Coin (searchable), quantity, purchase date. Optional: buy price, fees | Buy price in INR on that date, live INR price, current value, 24h change, P&L |
| Gold SIP | SIP amount, GST % (default 3%), whether GST is included in the amount, frequency (daily / weekly / monthly / quarterly), start date, optional end date | Every installment from start date until today, GST paid, the grams each installment bought at **that day's** gold rate, total grams, average cost/gram, live value, P&L. New installments are added automatically as they fall due |

All records are saved in your browser and revalued from the live market every time you open or refresh the dashboard (and every minute while it is open). Each day's latest valuation is kept as a snapshot, which powers the "portfolio value over time" chart.

## News & signals (AI agent)

Below your holdings, a **News & signals** card watches the news for everything you own and flags the stories most likely to move the price.

1. The server collects the last 7 days of headlines for each holding (and for the market overall) from **Google News** (India edition) and **Yahoo Finance**.
2. An LLM on **[Ollama Cloud](https://ollama.com)** (default `gpt-oss:120b`) reads them. For each story that matters, it gives:
   - **direction**: Bullish, Bearish, or Watch (mixed)
   - **impact**: high, medium or low
   - the **KPIs or catalysts** at stake, e.g. Q2 net profit, order book, promoter stake, ETF inflows, import duty
   - a one-line **reason**

   It also writes a brief on what those stories mean for the named holdings (position sizes are never sent, so the brief does not rank a "main" risk) and a sentiment for each holding.
3. The brief rescans every 15 minutes while the app is open. Stories you haven't seen before are marked **New**, and new *high-impact* stories also pop up as a notification.

The model only ever points at headlines by id, so every headline and link shown comes from the real news feed, never from the model. Only holding names and symbols are sent to the news sources and to Ollama, never quantities or amounts. The latest brief is cached in your encrypted vault.

**Setup:** create a key at [ollama.com/settings/keys](https://ollama.com/settings/keys) and set `OLLAMA_API_KEY` in `.env`. Without a key the card still works, but stories are flagged by a simpler keyword scan, and the card shows *Keyword scan* instead of *AI*.

## Ask AI (chat assistant)

The **Ask AI** button (bottom right, or press <kbd>A</kbd>) opens a chat agent that can answer anything: markets, your holdings, or any other topic. It decides for itself when to use its tools, runs several of them in parallel, and streams each step and the answer as it works:

| Tool | What it does |
|---|---|
| `web_search` | Searches the whole web (Ollama web search API with your `OLLAMA_API_KEY`; DuckDuckGo otherwise) |
| `fetch_url` | Opens a page and reads its text: a search result, or a link you paste |
| `news_search` | Real-time headlines from Google News (India), newest first |
| `get_quote` | Live prices for NSE/BSE stocks, indices (`^NSEI`, `^BSESN`), US stocks, crypto, forex, commodities, and the Indian gold rate |

Answers cite their sources inline, and a **Sources** list sits under each reply. Only holding names and symbols are sent as context, never amounts. The conversation is kept in memory only and is cleared on lock. Page fetches are limited to public addresses, so the agent cannot reach your local network.

## Your data and encryption

- Everything (purchases, SIPs, ledgers, history) is stored **only in this browser's `localStorage`**, encrypted with **AES-256-GCM**. The key is derived from your passphrase with **PBKDF2-SHA256 (600,000 iterations, random salt)**, and every save uses a fresh IV.
- The passphrase and key stay in memory only. You enter the passphrase once per visit, and the app locks itself after 15 minutes of inactivity (or when you click **Lock**).
- The server stores nothing. It only fetches market prices and does the calculations: the browser sends records to it to be priced and gets them back.
- **There is no passphrase recovery.** If you forget it, use *Forgot passphrase? Erase data* to start over.
- Data is tied to this browser and address (`http://localhost:4000`). Clearing site data, using another browser or changing `PORT` means starting empty, so use **Backup** to download an encrypted `.json` file now and then, and *Restore from backup file* on the lock screen to bring it back. A backup opens with the passphrase that was in use when it was made.



## Market data sources

| Data | Source |
|---|---|
| NSE/BSE live price, history and search | Yahoo Finance (`RELIANCE.NS`, `500325.BO` …) |
| Crypto live INR price | CoinDCX public API (INR market, or USDT market × USDT/INR); CoinGecko for coins not on CoinDCX |
| Crypto search | CoinGecko |
| Crypto value-over-time chart | CoinDCX daily candles; Yahoo Finance `<SYMBOL>-INR` for coins not on CoinDCX |
| Crypto price on an older purchase date | CoinDCX daily candles; for coins not on CoinDCX, CoinGecko (last 365 days) then Yahoo Finance `BTC-INR` |
| News | Google News RSS (India) and Yahoo Finance news, analysed by an Ollama Cloud model |
| Gold rate | COMEX gold (`GC=F`, USD/oz) × USD/INR ÷ 31.1035 g × (1 + import duty) |

No API keys are required (an optional Ollama key turns on the AI news analysis).

**Accuracy notes**

- The Indian gold rate is derived from the international rate plus import duty (`GOLD_IMPORT_DUTY_PCT`, default 6%). It closely tracks the 24K (999) rate quoted by Indian jewellers and digital-gold apps *excluding GST*. If your SIP platform charges a spread over the market rate, set the **Platform spread %** on the SIP so the grams match your statement.
- Yahoo Finance NSE/BSE quotes may lag the exchange by a few minutes during market hours. Closing prices are exact.
- Free APIs have rate limits, so prices are cached for `PRICE_CACHE_SECONDS` (60s default).

## Run it (Windows)

Requirements: Node.js 20+.

| Script | What it does |
|---|---|
| `setup.bat` | Checks Node.js, runs `npm install`, creates `.env` from `.env.example` |
| `start.bat` | Starts the server in a minimised window (logs in `server.log`) and opens the browser |
| `stop.bat` | Stops the server |

Or from any terminal:

```bash
npm install
cp .env.example .env      # optional
npm start                 # http://localhost:4000
```

Run the tests (market APIs are stubbed, so they work offline):

```bash
npm test
```

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | HTTP port (your saved data belongs to this address; changing it starts empty) |
| `PRICE_CACHE_SECONDS` | `60` | How long a live stock/gold price is reused |
| `CRYPTO_PRICE_CACHE_SECONDS` | `10` | How long the CoinDCX crypto ticker is reused |
| `GOLD_IMPORT_DUTY_PCT` | `6` | Duty added to the international gold rate |
| `COINGECKO_API_KEY` | – | Optional CoinGecko demo key for higher limits |
| `OLLAMA_API_KEY` | – | Ollama Cloud key for the news agent. Without it, news is flagged by a keyword scan |
| `OLLAMA_MODEL` | `gpt-oss:120b` | Any Ollama Cloud model, e.g. `gpt-oss:20b`, `deepseek-v3.1:671b` |
| `OLLAMA_HOST` | `https://ollama.com` | Point at a self-hosted Ollama (e.g. `http://localhost:11434`) instead |
| `NEWS_CACHE_MINUTES` | `15` | How long a news brief is reused for the same holdings |
| `NEWS_LOOKBACK_DAYS` | `7` | How far back headlines are considered |
| `CHAT_MODEL` | `OLLAMA_MODEL` | Model for the Ask AI chat (must support tool calling) |
| `CHAT_MAX_STEPS` | `8` | Max rounds of tool use per chat answer |

## REST API

The API is stateless. It prices whatever the browser sends and returns it.

| Method & path | Body / query | Description |
|---|---|---|
| `POST /api/value/holding` | `{ assetType: "stock", symbol: "RELIANCE", quantity: 10, buyDate: "2024-03-15", buyPrice?, fees?, notes?, _id? }` | Validate and value a stock purchase (`.NS` added if no exchange suffix). Buy price = market close on that date unless given |
| `POST /api/value/holding` | `{ assetType: "crypto", coinId: "bitcoin", symbol: "BTC", quantity: 0.01, buyDate: "2025-06-01", buyPrice?, fees? }` | Same for crypto (`coinId` = CoinGecko id) |
| `POST /api/value/gold-sip` | `{ sipAmount: 1000, gstPercent: 3, gstInclusive: true, frequency: "monthly", startDate: "2025-01-05", endDate?, name?, platform?, premiumPercent? }` | Build a gold SIP's installment ledger and value it |
| `POST /api/portfolio/refresh` | `{ holdings: [...], goldSips: [...] }` | Revalue the records with live prices and return them |
| `POST /api/news/brief` | `{ holdings: [{ key, assetType, symbol, name, dayChangePercent? }] }` | Recent headlines per holding, with price-moving stories flagged (impact, severity, KPIs, reason) |
| `POST /api/chat` | `{ messages: [{ role, content }], holdings?: [{ name, symbol, assetType }] }` | Chat agent; streams NDJSON events (`step`, `delta`, `reset`, `done`, `error`) |
| `GET /api/chat/status` | | Whether the chat model is configured, and which one |
| `GET /api/search/stocks?q=` / `GET /api/search/crypto?q=` | | Search NSE/BSE stocks or coins |
| `GET /api/quote/stock/:symbol`, `/api/quote/crypto/:id`, `/api/quote/gold` | `?date=YYYY-MM-DD` | Live quote (and price on a date) |

## Project layout

```
src/
  server.js            entry point
  app.js               Express app & routes
  services/            yahoo, coingecko, gold, sip (schedule + GST maths), valuation, news + newsAgent, chatAgent + webTools
  routes/              market data + stateless valuation endpoints
public/
  app.js               dashboard (no build step)
  vault.js             encrypted localStorage store (Web Crypto)
  portfolio.js         summary + snapshot maths
test/                  node:test unit + API tests
setup.bat start.bat stop.bat
```

## Deploy to Railway

The repo includes [`railway.json`](railway.json) (build with Railpack, start with `npm start`, health check on `/api/health`) and pins Node 22 via `.nvmrc`.

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo** and pick it.
3. Optional: under **Variables**, set `PRICE_CACHE_SECONDS`, `GOLD_IMPORT_DUTY_PCT` or `COINGECKO_API_KEY`. Don't set `PORT`; Railway provides it.
4. Under **Settings → Networking**, click **Generate Domain** to get a public `https://….up.railway.app` URL.

The server keeps no state, so no database or volume is needed. Your data stays encrypted in the browser, tied to the Railway domain: data saved at `http://localhost:4000` won't show up there. Move it with **Backup** locally and **Restore from backup file** on the deployed site.
