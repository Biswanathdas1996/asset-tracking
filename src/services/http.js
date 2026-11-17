import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

// Respect HTTPS_PROXY / HTTP_PROXY / NO_PROXY when they are set (corporate networks etc.).
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export async function getJson(url, { headers = {}, timeoutMs = 15000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (asset-tracker)', Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new UpstreamError(`${new URL(url).host} responded ${res.status}`);
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = body?.chart?.error?.description || body?.error?.status?.error_message || body?.error || res.statusText;
        throw new UpstreamError(`${new URL(url).host}: ${msg}`, res.status === 404 ? 404 : 502);
      }
      return body;
    } catch (err) {
      if (err instanceof UpstreamError && err.status !== 502) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof UpstreamError ? lastErr : new UpstreamError(`Market data request failed: ${lastErr?.message}`);
}

/** Tiny TTL cache so repeated page loads don't hammer the free APIs. */
export function ttlCache() {
  const store = new Map();
  return {
    async get(key, ttlMs, loader) {
      const hit = store.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      const value = await loader();
      store.set(key, { at: Date.now(), value });
      return value;
    },
    clear: () => store.clear(),
  };
}
