/**
 * Cloudflare Worker: static UI + /api/* parity with spacex_spread_monitor/main.py
 * State (config, history, quote cache, bark cooldown) lives in isolate memory.
 */

export interface Env {
  ASSETS: Fetcher;
}

const OKX_INST_ID = "SPACEX-USDT-SWAP";
const GATE_CURRENCY_PAIR = "SPCX_USDT";
const BITGET_SYMBOL = "PRESPAXUSDT";

const OKX_SHARES_OUTSTANDING = 1_000_000_000;
const GATE_SHARES_OUTSTANDING = 2_375_000_000;
const BITGET_SHARES_OUTSTANDING = 2_307_692_308;

// Bitget 在部分 Cloudflare PoP 上偶发 >3s；放宽超时并对 Bitget 做一次重试提升稳定性。
const UPSTREAM_TIMEOUT_MS = 6000;
const QUOTE_CACHE_TTL_MS = 900;
const HIST_APPEND_MIN_INTERVAL_MS = 1500;
const HISTORY_MAX_POINTS = 200_000;

const MCAP_NOTES =
  "固定口径：OKX=10亿股；Spot=2.375B 股。OKX Pre-IPO 合约为每股价口径；Spot 用固定股本推导隐含市值。";

type VenueNorm = "gate" | "bitget";

interface AppConfig {
  bark_enabled: boolean;
  bark_base_url: string;
  bark_title: string;
  bark_keys: string[];
  bark_threshold_pct: number;
  bark_cooldown_seconds: number;
}

interface HistPoint {
  t: number;
  v: number;
}

function defaultConfig(): AppConfig {
  return {
    bark_enabled: false,
    bark_base_url: "https://api.day.app",
    bark_title: "SPACEX/SPCX 价差提醒",
    bark_keys: [],
    bark_threshold_pct: 1.0,
    bark_cooldown_seconds: 60,
  };
}

let runtimeConfig: AppConfig = defaultConfig();

const histPointsByVenue: Record<VenueNorm, HistPoint[]> = {
  gate: [],
  bitget: [],
};

const lastHistAppendAtMsByVenue: Partial<Record<VenueNorm, number>> = {};
const lastQuotePayloadByVenue: Partial<Record<VenueNorm, Record<string, unknown>>> = {};
const lastQuoteAtMsByVenue: Partial<Record<VenueNorm, number>> = {};
const lastBarkSentByKeyMs: Record<string, number> = {};

function nowMs(): number {
  return Date.now();
}

function asFloat(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "boolean") return null;
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeBarkKey(value: unknown): string {
  if (typeof value !== "string") return "";
  let s = value.trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      const u = new URL(s);
      const parts = (u.pathname || "/").split("/").filter((x) => x.trim());
      if (parts.length) s = parts[0].trim();
    } catch {
      /* ignore */
    }
  }
  return s.replace(/\//g, "").trim();
}

function normalizeVenue(v: string | null): VenueNorm {
  return v && v.toLowerCase() === "bitget" ? "bitget" : "gate";
}

function bucketStartMs(tsMs: number, tfSeconds: number): number {
  const tfMs = tfSeconds * 1000;
  return Math.floor(tsMs / tfMs) * tfMs;
}

function loadConfig(): AppConfig {
  return { ...runtimeConfig, bark_keys: [...(runtimeConfig.bark_keys || [])] };
}

function dedupKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function saveConfigFromDict(raw: Record<string, unknown>): AppConfig {
  const cfg = loadConfig();
  if (typeof raw.bark_enabled === "boolean") cfg.bark_enabled = raw.bark_enabled;
  if (typeof raw.bark_base_url === "string" && raw.bark_base_url.trim())
    cfg.bark_base_url = raw.bark_base_url.trim();
  if (typeof raw.bark_title === "string" && raw.bark_title.trim()) cfg.bark_title = raw.bark_title.trim();

  if (Array.isArray(raw.bark_keys)) {
    const keys = raw.bark_keys.map((x) => normalizeBarkKey(x)).filter(Boolean);
    cfg.bark_keys = dedupKeys(keys);
  }
  if (typeof raw.bark_key === "string" && raw.bark_key.trim()) {
    const k = normalizeBarkKey(raw.bark_key);
    if (k) cfg.bark_keys = dedupKeys([...cfg.bark_keys, k]);
  }

  if (raw.bark_threshold_pct != null) {
    const t = asFloat(raw.bark_threshold_pct);
    if (t != null) cfg.bark_threshold_pct = Math.max(0, t);
  }
  if (raw.bark_cooldown_seconds != null) {
    const c = Number(raw.bark_cooldown_seconds);
    if (Number.isFinite(c)) cfg.bark_cooldown_seconds = Math.max(5, Math.floor(c));
  }

  cfg.bark_base_url = (cfg.bark_base_url || "https://api.day.app").trim();
  cfg.bark_title = (cfg.bark_title || "SPACEX/SPCX 价差提醒").trim();
  if (cfg.bark_enabled && (!cfg.bark_keys || cfg.bark_keys.length === 0)) cfg.bark_enabled = false;

  runtimeConfig = cfg;
  return loadConfig();
}

function maybeAppendHistoryPoint(venue: VenueNorm, v: number | null, tMs?: number): void {
  if (v == null || Number.isNaN(v)) return;
  const now = tMs ?? nowMs();
  const last = lastHistAppendAtMsByVenue[venue];
  if (last != null && now - last < HIST_APPEND_MIN_INTERVAL_MS) return;
  lastHistAppendAtMsByVenue[venue] = now;
  const arr = histPointsByVenue[venue];
  arr.push({ t: now, v });
  if (arr.length > HISTORY_MAX_POINTS) {
    histPointsByVenue[venue] = arr.slice(-HISTORY_MAX_POINTS);
  }
}

async function fetchOkxLast(): Promise<{ last: number | null; meta: Record<string, unknown> }> {
  const url = "https://www.okx.com/api/v5/market/ticker";
  const meta: Record<string, unknown> = { url, status: 0 };
  try {
    const r = await fetch(`${url}?${new URLSearchParams({ instId: OKX_INST_ID })}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    meta.status = r.status;
    if (!r.ok) {
      meta.error = `http_${r.status}`;
      return { last: null, meta };
    }
    const payload = (await r.json()) as Record<string, unknown>;
    meta.raw_code = payload.code;
    meta.raw_msg = payload.msg;
    const data = payload.data;
    if (!Array.isArray(data) || !data.length) {
      meta.error = "unexpected_okx_payload";
      return { last: null, meta };
    }
    const row = data[0] as Record<string, unknown>;
    meta.ts = row.ts;
    return { last: asFloat(row.last), meta };
  } catch (e) {
    meta.error = e instanceof Error ? e.name : "unknown";
    meta.detail = String(e);
    return { last: null, meta };
  }
}

async function fetchGateLast(): Promise<{ last: number | null; meta: Record<string, unknown> }> {
  const url = "https://api.gateio.ws/api/v4/spot/tickers";
  const meta: Record<string, unknown> = { url, status: 0 };
  try {
    const r = await fetch(`${url}?${new URLSearchParams({ currency_pair: GATE_CURRENCY_PAIR })}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    meta.status = r.status;
    if (!r.ok) {
      meta.error = `http_${r.status}`;
      return { last: null, meta };
    }
    const payload = (await r.json()) as unknown;
    if (!Array.isArray(payload) || !payload.length) {
      meta.error = "unexpected_gate_payload";
      return { last: null, meta };
    }
    const row = payload[0] as Record<string, unknown>;
    return { last: asFloat(row.last), meta };
  } catch (e) {
    meta.error = e instanceof Error ? e.name : "unknown";
    meta.detail = String(e);
    return { last: null, meta };
  }
}

async function fetchBitgetLast(): Promise<{ last: number | null; meta: Record<string, unknown> }> {
  const url = "https://api.bitget.com/api/v2/spot/market/tickers";
  const meta: Record<string, unknown> = { url, status: 0, symbol: BITGET_SYMBOL };
  const doFetch = async (attempt: number) => {
    const r = await fetch(`${url}?${new URLSearchParams({ symbol: BITGET_SYMBOL })}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        // Bitget is behind a WAF and sometimes flags serverless fetches.
        // These headers make the request look like a normal browser XHR.
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        // Use a common desktop UA (Workers default UA can be flagged).
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        referer: "https://www.bitget.com/zh-CN/spot/PRESPAXUSDT",
        origin: "https://www.bitget.com",
      },
    });
    meta.status = r.status;
    meta.attempt = attempt;
    if (!r.ok) {
      meta.error = `http_${r.status}`;
      return { last: null, meta };
    }
    const payload = (await r.json()) as Record<string, unknown>;
    meta.raw_code = payload.code;
    meta.raw_msg = payload.msg;
    const data = payload.data;
    if (!Array.isArray(data) || !data.length) {
      meta.error = "unexpected_bitget_payload";
      return { last: null, meta };
    }
    const row = data[0] as Record<string, unknown>;
    meta.ts = row.ts;
    return { last: asFloat(row.lastPr), meta };
  };

  try {
    const r1 = await doFetch(1);
    if (r1.last != null) return r1;
    // Retry once only on network/timeout-like cases.
    if (typeof meta.error === "string" && meta.error.startsWith("http_")) return r1;
    return r1;
  } catch (e1) {
    meta.error = e1 instanceof Error ? e1.name : "unknown";
    meta.detail = String(e1);
    // One retry for transient errors/timeouts.
    try {
      return await doFetch(2);
    } catch (e2) {
      meta.error2 = e2 instanceof Error ? e2.name : "unknown";
      meta.detail2 = String(e2);
      return { last: null, meta };
    }
  }
}

async function barkPush(
  baseUrl: string,
  key: string,
  title: string,
  body: string,
  opts?: { sound?: string; level?: string; volume?: number; call?: number }
): Promise<void> {
  const sound = opts?.sound ?? "alarm";
  const level = opts?.level ?? "critical";
  const volume = Math.max(0, Math.min(10, opts?.volume ?? 10));
  const call = opts?.call ? 1 : 0;
  // Match Python: only title/body are URL-encoded; key is a raw path segment.
  const root = baseUrl.replace(/\/+$/, "");
  const pathUrl = `${root}/${key}/${encodeURIComponent(title || "")}/${encodeURIComponent(body || "")}`;
  const u = new URL(pathUrl);
  u.searchParams.set("sound", sound);
  u.searchParams.set("level", level);
  u.searchParams.set("volume", String(volume));
  u.searchParams.set("call", String(call));
  const r = await fetch(u.toString(), { signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`bark_http_${r.status}`);
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers as Record<string, string>),
    },
  });
}

async function handleApiGetConfig(): Promise<Response> {
  const cfg = loadConfig();
  const cfgDict = { ...cfg, bark_keys_set: cfg.bark_keys.length, bark_keys: cfg.bark_keys };
  return json({ config: cfgDict });
}

async function handleApiPostConfig(request: Request): Promise<Response> {
  let raw: Record<string, unknown> = {};
  try {
    raw = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  saveConfigFromDict(raw);
  const c = loadConfig();
  const out = { ...c, bark_keys_set: c.bark_keys.length, bark_keys: c.bark_keys };
  return json({ ok: true, config: out });
}

async function handleApiBarkTest(request: Request): Promise<Response> {
  let payload: Record<string, unknown> = {};
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const cfg = loadConfig();
  const key = String(payload.bark_key || "").trim();
  const baseUrl = String(payload.bark_base_url || cfg.bark_base_url).trim() || "https://api.day.app";
  const title = String(payload.bark_title || cfg.bark_title).trim() || "SPACEX/SPCX 价差提醒";
  if (!key) return json({ ok: false, error: "missing_bark_key" });
  try {
    await barkPush(baseUrl, key, `${title}（测试）`, "如果你收到这条，说明 Bark 配置成功。", {
      sound: "alarm",
      level: "critical",
      volume: 10,
      call: 1,
    });
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) });
  }
}

function handleApiCandles(url: URL): Response {
  const supported = new Set([60, 120, 180, 300, 900, 1800, 3600, 10800, 21600, 86400]);
  let tf = Number(url.searchParams.get("tf") || "60");
  if (!supported.has(tf)) tf = 60;
  const venue = normalizeVenue(url.searchParams.get("venue"));
  const pts = [...histPointsByVenue[venue]];

  type Candle = { t: number; o: number; h: number; l: number; c: number };
  const candles: Candle[] = [];
  let curBucket: number | null = null;
  let o: number | null = null;
  let h: number | null = null;
  let l: number | null = null;
  let c: number | null = null;

  for (const p of pts) {
    const tMs = Math.floor(p.t || 0);
    const v = p.v;
    if (v == null || Number.isNaN(v)) continue;
    const b = bucketStartMs(tMs, tf);
    if (curBucket == null || b !== curBucket) {
      if (curBucket != null && o != null && h != null && l != null && c != null) {
        candles.push({ t: Math.floor(curBucket / 1000), o, h, l, c });
      }
      curBucket = b;
      o = h = l = c = v;
    } else {
      h = h == null ? v : Math.max(h, v);
      l = l == null ? v : Math.min(l, v);
      c = v;
    }
  }
  if (curBucket != null && o != null && h != null && l != null && c != null) {
    candles.push({ t: Math.floor(curBucket / 1000), o, h, l, c });
  }

  const lows = candles.map((x) => x.l);
  const highs = candles.map((x) => x.h);
  const rng = {
    min: lows.length ? Math.min(...lows) : null,
    max: highs.length ? Math.max(...highs) : null,
  };
  return json({
    tf,
    venue,
    candles: candles.slice(-5000),
    range: rng,
    points: pts.length,
  });
}

async function handleApiQuote(url: URL): Promise<Response> {
  const venueNorm = normalizeVenue(url.searchParams.get("venue"));
  const now = nowMs();

  const cached = lastQuotePayloadByVenue[venueNorm];
  const cachedAt = lastQuoteAtMsByVenue[venueNorm];
  if (cached && cachedAt != null && now - cachedAt <= QUOTE_CACHE_TTL_MS) {
    const mcap = cached.market_cap as Record<string, unknown> | undefined;
    const v = asFloat(mcap?.diff_pct_vs_spot);
    maybeAppendHistoryPoint(venueNorm, v, now);
    return json(cached);
  }

  const t0 = now;

  const [okxR, spotR] = await Promise.all([
    fetchOkxLast(),
    venueNorm === "bitget" ? fetchBitgetLast() : fetchGateLast(),
  ]);

  const okxLast = okxR.last;
  const spotLast = spotR.last;
  const okxMeta = okxR.meta;
  const spotMeta = spotR.meta;

  let spread: number | null = null;
  let spreadPct: number | null = null;
  let mid: number | null = null;
  if (okxLast != null && spotLast != null) {
    spread = okxLast - spotLast;
    mid = (okxLast + spotLast) / 2;
    if (spotLast !== 0) spreadPct = (spread / spotLast) * 100;
  }

  const cfg = loadConfig();
  const okxShares = OKX_SHARES_OUTSTANDING;
  const spotShares = venueNorm === "bitget" ? BITGET_SHARES_OUTSTANDING : GATE_SHARES_OUTSTANDING;
  const okxMcap = okxLast != null ? okxLast * okxShares : null;
  const spotMcap = spotLast != null ? spotLast * spotShares : null;
  let mcapDiff: number | null = null;
  let mcapDiffPct: number | null = null;
  if (okxMcap != null && spotMcap != null) {
    mcapDiff = okxMcap - spotMcap;
    if (spotMcap !== 0) mcapDiffPct = (mcapDiff / spotMcap) * 100;
  }

  maybeAppendHistoryPoint(venueNorm, mcapDiffPct);

  const bark: Record<string, unknown> = {
    enabled: cfg.bark_enabled,
    threshold_pct: cfg.bark_threshold_pct,
    cooldown_seconds: cfg.bark_cooldown_seconds,
    signal: `mcap_diff_pct_vs_${venueNorm}`,
    signal_value_pct: mcapDiffPct,
    sent: false,
    sent_count: 0,
    reason: null as string | null,
  };

  if (cfg.bark_enabled && mcapDiffPct != null) {
    const hit = Math.abs(Number(mcapDiffPct)) >= Number(cfg.bark_threshold_pct);
    if (!hit) bark.reason = "no_hit";
    else {
      const nowMsVal = nowMs();
      let sent = 0;
      for (const key of cfg.bark_keys || []) {
        const last = lastBarkSentByKeyMs[key];
        const okToSend = last == null || nowMsVal - last >= cfg.bark_cooldown_seconds * 1000;
        if (!okToSend) continue;
        try {
          const spotSym = venueNorm === "bitget" ? BITGET_SYMBOL : GATE_CURRENCY_PAIR;
          const body =
            `OKX(${OKX_INST_ID})=${okxLast}  ${venueNorm.toUpperCase()}(${spotSym})=${spotLast}\n` +
            `市值差值%（OKX-${venueNorm.toUpperCase()}，相对${venueNorm.toUpperCase()}）=${mcapDiffPct.toFixed(2)}%\n` +
            `OKX隐含市值=${okxMcap?.toFixed(2)}  ${venueNorm.toUpperCase()}隐含市值=${spotMcap?.toFixed(2)}`;
          await barkPush(cfg.bark_base_url, key, cfg.bark_title, body, {
            sound: "alarm",
            level: "critical",
            volume: 10,
            call: 1,
          });
          lastBarkSentByKeyMs[key] = nowMsVal;
          sent += 1;
        } catch {
          /* ignore per-key failure */
        }
      }
      bark.sent = sent > 0;
      bark.sent_count = sent;
      bark.reason = sent > 0 ? "hit_threshold" : "cooldown";
    }
  } else if (cfg.bark_enabled) {
    bark.reason = "no_signal";
  }

  const payload = {
    venue: venueNorm,
    at_ms: nowMs(),
    latency_ms: nowMs() - t0,
    okx: { instId: OKX_INST_ID, last: okxLast, meta: okxMeta },
    spot: {
      venue: venueNorm,
      symbol: venueNorm === "bitget" ? BITGET_SYMBOL : GATE_CURRENCY_PAIR,
      last: spotLast,
      meta: spotMeta,
    },
    spread: { abs: spread, pct_vs_spot: spreadPct, mid },
    market_cap: {
      okx_shares_outstanding: okxShares,
      spot_shares_outstanding: spotShares,
      okx_implied_usd: okxMcap,
      spot_implied_usd: spotMcap,
      diff_usd: mcapDiff,
      diff_pct_vs_spot: mcapDiffPct,
      notes: MCAP_NOTES,
    },
    bark,
  };

  lastQuotePayloadByVenue[venueNorm] = payload as unknown as Record<string, unknown>;
  lastQuoteAtMsByVenue[venueNorm] = Number(payload.at_ms);
  return json(payload);
}

async function handleApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = (url.pathname || "/").replace(/\/+$/, "") || "/";

  if (path === "/api/config" && request.method === "GET") return handleApiGetConfig();
  if (path === "/api/config" && request.method === "POST") return handleApiPostConfig(request);
  if (path === "/api/candles" && request.method === "GET") return handleApiCandles(url);
  if (path === "/api/quote" && request.method === "GET") return handleApiQuote(url);
  if (path === "/api/bark/test" && request.method === "POST") return handleApiBarkTest(request);

  return json({ error: "not_found", path }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request);
    }
    return env.ASSETS.fetch(request);
  },
};
