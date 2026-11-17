import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 4000),
  priceCacheSeconds: num(process.env.PRICE_CACHE_SECONDS, 60),
  // Crypto moves fast and CoinDCX returns every market in one call, so cache it briefly
  cryptoPriceCacheSeconds: num(process.env.CRYPTO_PRICE_CACHE_SECONDS, 10),
  goldImportDutyPct: num(process.env.GOLD_IMPORT_DUTY_PCT, 6),
  coingeckoApiKey: process.env.COINGECKO_API_KEY || '',
  // News agent: Ollama Cloud (https://ollama.com) or any Ollama server. Without a key/host the
  // news section still works, flagging stories with a keyword scan instead of the model.
  ollamaHost: (process.env.OLLAMA_HOST || 'https://ollama.com').replace(/\/+$/, ''),
  ollamaApiKey: process.env.OLLAMA_API_KEY || '',
  ollamaModel: process.env.OLLAMA_MODEL || 'gpt-oss:120b',
  // Chat assistant: defaults to the news model; tool rounds (search / read / quote) allowed per answer.
  chatModel: process.env.CHAT_MODEL || process.env.OLLAMA_MODEL || 'gpt-oss:120b',
  chatMaxSteps: Math.max(2, num(process.env.CHAT_MAX_STEPS, 8)),
  newsCacheMinutes: num(process.env.NEWS_CACHE_MINUTES, 15),
  newsLookbackDays: num(process.env.NEWS_LOOKBACK_DAYS, 7),
};

/** The model is used when an API key is set, or when OLLAMA_HOST points at a self-hosted server. */
export const aiEnabled = () => !!config.ollamaApiKey || !/^https:\/\/(www\.)?ollama\.com$/.test(config.ollamaHost);
