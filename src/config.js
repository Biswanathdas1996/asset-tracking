import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 4000),
  priceCacheSeconds: num(process.env.PRICE_CACHE_SECONDS, 60),
  // Crypto moves fast and CoinDCX returns every market in one call, so cache it briefly
  cryptoPriceCacheSeconds: num(process.env.CRYPTO_PRICE_CACHE_SECONDS, 10),
  goldImportDutyPct: num(process.env.GOLD_IMPORT_DUTY_PCT, 6),
  coingeckoApiKey: process.env.COINGECKO_API_KEY || '',
};
