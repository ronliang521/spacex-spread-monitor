/**
 * Cloudflare Worker: static UI + /api/* parity with spacex_spread_monitor/main.py
 * State (config, history, quote cache, bark cooldown) lives in isolate memory.
 */

import { buildBitgetHistRemotePayload, buildGateHistRemotePayload } from "./remoteCandles";

export interface Env {
  ASSETS: Fetcher;
  BROWSER: unknown;
  /** 可选：自建 FastAPI 根 URL（无尾斜杠）。设置后 remote K 线可反向代理到宿主（备用）。 */
  BACKEND_ORIGIN?: string;
}

const OKX_INST_ID = "SPACEX-USDT-SWAP";
const GATE_CURRENCY_PAIR = "SPCX_USDT";
const BITGET_SYMBOL = "PRESPAXUSDT";

const OKX_SHARES_OUTSTANDING = 1_000_000_000;
const GATE_SHARES_NUMERATOR = 1_400_000_000_000;
const GATE_SHARES_DENOMINATOR = 590;
/** Gate：总股本 = 1.4 万亿 / 590（与 FastAPI main.py 一致） */
const GATE_SHARES_OUTSTANDING = GATE_SHARES_NUMERATOR / GATE_SHARES_DENOMINATOR;
const BITGET_SHARES_OUTSTANDING = 2_307_692_308;

/** 股本口径变更时递增，用于丢弃 Worker 内旧 quote 缓存（否则会短暂返回旧股数）。 */
const QUOTE_SHARES_REVISION = 2;

// Bitget 在部分 Cloudflare PoP 上偶发 >3s；放宽超时并对 Bitget 做一次重试提升稳定性。
const UPSTREAM_TIMEOUT_MS = 6000;
const QUOTE_CACHE_TTL_MS = 900;
const HIST_APPEND_MIN_INTERVAL_MS = 1500;
const HISTORY_MAX_POINTS = 200_000;
/** 与 FastAPI main.py MAX_HIST_CANDLES_RESPONSE 一致（旧 5000 会裁掉长默认窗左侧） */
const MAX_HIST_CANDLES_RESPONSE = 100_000;

const GATE_SPOT_PAGE_URL = "https://www.gate.com/zh/trade/SPCX_USDT";
const BITGET_SPOT_PAGE_URL = "https://www.bitget.com/zh-CN/spot/PRESPAXUSDT";

const MCAP_NOTES_GATE =
  "固定口径：OKX=10亿股；Gate 现货总股本=1.4万亿/590 股。OKX Pre-IPO 合约为每股价口径；Spot 用固定股本推导隐含市值。";
const MCAP_NOTES_BITGET =
  "固定口径：OKX=10亿股；Bitget PRESPAX 现货股本见 Worker/BITGET_SHARES_OUTSTANDING（IPO Prime 推导）。现货来自 Bitget 公开 REST，品种与官网 " +
  BITGET_SPOT_PAGE_URL +
  " 一致。";

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
  const tickerUrl = "https://api.bitget.com/api/v2/spot/market/tickers";
  const fillsUrl = "https://api.bitget.com/api/v2/spot/market/fills";
  const meta: Record<string, unknown> = { url: tickerUrl, status: 0, symbol: BITGET_SYMBOL };
  const requestHeaders = {
    // Bitget is behind a WAF and sometimes flags serverless fetches.
    // These headers make the request look like a normal browser XHR.
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    // Use a common desktop UA (Workers default UA can be flagged).
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    referer: BITGET_SPOT_PAGE_URL,
    origin: "https://www.bitget.com",
  };
  const doFetch = async (attempt: number) => {
    const r = await fetch(`${tickerUrl}?${new URLSearchParams({ symbol: BITGET_SYMBOL })}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: requestHeaders,
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

  const fetchFromFills = async () => {
    meta.fallback = "fills";
    const r = await fetch(`${fillsUrl}?${new URLSearchParams({ symbol: BITGET_SYMBOL, limit: "1" })}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: requestHeaders,
    });
    meta.fallback_status = r.status;
    if (!r.ok) {
      meta.fallback_error = `http_${r.status}`;
      return { last: null, meta };
    }
    const payload = (await r.json()) as Record<string, unknown>;
    const data = payload.data;
    if (!Array.isArray(data) || !data.length) {
      meta.fallback_error = "unexpected_bitget_fills_payload";
      return { last: null, meta };
    }
    const row = data[0] as Record<string, unknown>;
    const last = asFloat(row.price);
    meta.fallback_ts = row.ts;
    if (last == null) {
      meta.fallback_error = "bitget_fills_price_missing";
      return { last: null, meta };
    }
    return { last, meta };
  };

  try {
    const r1 = await doFetch(1);
    if (r1.last != null) return r1;
    // If ticker route is blocked by WAF (403), fallback to latest fills endpoint.
    if (meta.error === "http_403") {
      return await fetchFromFills();
    }
    return r1;
  } catch (e1) {
    meta.error = e1 instanceof Error ? e1.name : "unknown";
    meta.detail = String(e1);
    // One retry for transient errors/timeouts.
    try {
      const r2 = await doFetch(2);
      if (r2.last != null) return r2;
      if (meta.error === "http_403") {
        return await fetchFromFills();
      }
      return r2;
    } catch (e2) {
      meta.error2 = e2 instanceof Error ? e2.name : "unknown";
      meta.detail2 = String(e2);
      try {
        return await fetchFromFills();
      } catch (e3) {
        meta.error3 = e3 instanceof Error ? e3.name : "unknown";
        meta.detail3 = String(e3);
      }
      return { last: null, meta };
    }
  }
}

async function fetchBitgetLastViaBrowser(env: Env): Promise<{ last: number | null; meta: Record<string, unknown> }> {
  const meta: Record<string, unknown> = {
    url: BITGET_SPOT_PAGE_URL,
    status: 0,
    symbol: BITGET_SYMBOL,
    source: "browser_rendering",
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const puppeteer = require("@cloudflare/puppeteer");
    // @ts-ignore - env.BROWSER type is provided by Cloudflare runtime
    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    // Prefer calling the public API inside a browser context (has cookies + JS runtime).
    const apiUrl = `https://api.bitget.com/api/v2/spot/market/tickers?${new URLSearchParams({ symbol: BITGET_SYMBOL })}`;
    await page.goto(BITGET_SPOT_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });

    const out = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { cache: "no-store" });
        const status = r.status;
        const text = await r.text();
        return { ok: r.ok, status, text };
      } catch (e) {
        return { ok: false, status: 0, text: String(e) };
      }
    }, apiUrl);

    meta.browser_fetch_status = out?.status;
    if (!out?.ok) {
      meta.error = out?.status ? `http_${out.status}` : "browser_fetch_failed";
      meta.detail = (out?.text || "").slice(0, 400);
      await browser.close();
      return { last: null, meta };
    }

    let payload: any = null;
    try {
      payload = JSON.parse(out.text || "null");
    } catch {
      meta.error = "browser_json_parse_failed";
      meta.detail = String(out?.text || "").slice(0, 400);
      await browser.close();
      return { last: null, meta };
    }

    const row = Array.isArray(payload?.data) ? payload.data[0] : null;
    const last = asFloat(row?.lastPr);
    meta.ts = row?.ts;
    await browser.close();
    if (last == null) {
      meta.error = "browser_price_missing";
      return { last: null, meta };
    }
    return { last, meta };
  } catch (e) {
    meta.error = e instanceof Error ? e.name : "unknown";
    meta.detail = String(e);
    return { last: null, meta };
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
      "cache-control": "no-store",
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

const GATE_HIST_FROM_MS = 1778148000 * 1000; // 北京时间 2026-05-07 18:00（与 Python 默认窗一致）

function normalizeBackendOrigin(env: Env): string | null {
  const raw = env.BACKEND_ORIGIN;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim().replace(/\/+$/, "");
  return s.startsWith("http") ? s : `https://${s}`;
}

async function proxyBackendApi(env: Env, pathname: string, url: URL): Promise<Response | null> {
  const origin = normalizeBackendOrigin(env);
  if (!origin) return null;
  try {
    const target = new URL(pathname, origin.endsWith("/") ? origin : `${origin}/`);
    url.searchParams.forEach((v, k) => target.searchParams.set(k, v));
    const r = await fetch(target.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(120_000),
    });
    const headers = new Headers();
    const ct = r.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    return new Response(r.body, { status: r.status, headers });
  } catch {
    return null;
  }
}

async function handleApiCandles(url: URL, env: Env): Promise<Response> {
  const venue = normalizeVenue(url.searchParams.get("venue"));
  const source = (url.searchParams.get("source") || "remote").toLowerCase();

  if ((venue === "gate" || venue === "bitget") && source !== "local") {
    const proxied = await proxyBackendApi(env, "/api/candles", url);
    if (proxied != null) return proxied;
    const supportedRemote = new Set([60, 300, 3600, 14_400, 86_400]);
    let tf = Number(url.searchParams.get("tf") || "60");
    if (!supportedRemote.has(tf)) tf = 60;
    try {
      const payload =
        venue === "gate" ? await buildGateHistRemotePayload(tf) : await buildBitgetHistRemotePayload(tf);
      return json(payload);
    } catch (e) {
      const ds = venue === "gate" ? "okx_gate_public_rest" : "okx_bitget_public_rest";
      return json(
        {
          tf,
          venue,
          candles: [],
          range: { min: null, max: null },
          error: String(e),
          data_source: ds,
          data_source_detail: `Worker 内联 REST 失败（可配置 wrangler secret BACKEND_ORIGIN 指向 FastAPI）：${String(e)}`,
        },
        { status: 502 },
      );
    }
  }

  const supported = new Set([60, 120, 180, 300, 900, 1800, 3600, 10800, 21600, 86400]);
  let tf = Number(url.searchParams.get("tf") || "60");
  if (!supported.has(tf)) tf = 60;
  const pts = [...histPointsByVenue[venue]];

  type Candle = { t: number; o: number; h: number; l: number; c: number };
  const candles: Candle[] = [];
  let curBucket: number | null = null;
  let o: number | null = null;
  let h: number | null = null;
  let l: number | null = null;
  let c: number | null = null;
  let usedPts = 0;

  for (const p of pts) {
    const tMs = Math.floor(p.t || 0);
    if ((venue === "gate" || venue === "bitget") && tMs < GATE_HIST_FROM_MS) continue;
    const v = p.v;
    if (v == null || Number.isNaN(v)) continue;
    usedPts += 1;
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

  const nBuilt = candles.length;
  const candlesOut =
    nBuilt > MAX_HIST_CANDLES_RESPONSE ? candles.slice(-MAX_HIST_CANDLES_RESPONSE) : candles;
  const lows = candlesOut.map((x) => x.l);
  const highs = candlesOut.map((x) => x.h);
  const rng = {
    min: lows.length ? Math.min(...lows) : null,
    max: highs.length ? Math.max(...highs) : null,
  };
  const payload: Record<string, unknown> = {
    tf,
    venue,
    candles: candlesOut,
    candles_built: nBuilt,
    candles_truncated: nBuilt > MAX_HIST_CANDLES_RESPONSE,
    candles_max_return: MAX_HIST_CANDLES_RESPONSE,
    range: rng,
    points: usedPts,
    points_raw: pts.length,
    hist_from_ms: venue === "gate" || venue === "bitget" ? GATE_HIST_FROM_MS : null,
    data_source: "worker_memory_quote_samples",
    aggregation: "worker_memory_quote_samples",
    candles_first_ts: candlesOut.length ? candlesOut[0].t : null,
    candles_last_ts: candlesOut.length ? candlesOut[candlesOut.length - 1].t : null,
  };
  if (venue === "gate" && source === "local") {
    payload.data_source_detail =
      "Worker 内存报价点聚合（source=local）；默认 remote 已改为 OKX+Gate 公开 REST 全量对齐。";
  }
  if (venue === "bitget" && source === "local") {
    payload.data_source_detail =
      "Worker 内存报价点聚合（source=local）；默认 remote 已改为 OKX+Bitget 公开 REST 全量对齐。";
  }
  return json(payload);
}

async function handleApiQuote(url: URL): Promise<Response> {
  const venueNorm = normalizeVenue(url.searchParams.get("venue"));
  const now = nowMs();

  const cached = lastQuotePayloadByVenue[venueNorm];
  const cachedAt = lastQuoteAtMsByVenue[venueNorm];
  const revQ = Number((cached as Record<string, unknown> | undefined)?.shares_revision) || 0;
  if (
    cached &&
    cachedAt != null &&
    now - cachedAt <= QUOTE_CACHE_TTL_MS &&
    revQ === QUOTE_SHARES_REVISION
  ) {
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
  let spotLast = spotR.last;
  const okxMeta = okxR.meta;
  let spotMeta = spotR.meta;

  // If Bitget is blocked (403) even after endpoint fallback, try Browser Rendering as last resort.
  if (venueNorm === "bitget" && (spotLast == null) && spotMeta?.error === "http_403") {
    // Browser Rendering requires binding; if unavailable, skip.
    // @ts-ignore env is not in this function signature; passed via closure in handler below.
  }

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

  const mcapQ: Record<string, unknown> = {
    okx_shares_outstanding: okxShares,
    spot_shares_outstanding: spotShares,
    okx_implied_usd: okxMcap,
    spot_implied_usd: spotMcap,
    diff_usd: mcapDiff,
    diff_pct_vs_spot: mcapDiffPct,
    notes: venueNorm === "gate" ? MCAP_NOTES_GATE : MCAP_NOTES_BITGET,
    spot_shares_formula: null as string | null,
  };
  if (venueNorm === "gate") {
    mcapQ.spot_shares_formula = `${GATE_SHARES_NUMERATOR}/${GATE_SHARES_DENOMINATOR}`;
    mcapQ.spot_shares_outstanding_exact = GATE_SHARES_OUTSTANDING;
  }

  const payload = {
    venue: venueNorm,
    shares_revision: QUOTE_SHARES_REVISION,
    at_ms: nowMs(),
    latency_ms: nowMs() - t0,
    okx: { instId: OKX_INST_ID, last: okxLast, meta: okxMeta },
    spot: {
      venue: venueNorm,
      symbol: venueNorm === "bitget" ? BITGET_SYMBOL : GATE_CURRENCY_PAIR,
      last: spotLast,
      meta: spotMeta,
      spot_page: venueNorm === "bitget" ? BITGET_SPOT_PAGE_URL : GATE_SPOT_PAGE_URL,
    },
    spread: { abs: spread, pct_vs_spot: spreadPct, mid },
    market_cap: mcapQ,
    bark,
  };

  lastQuotePayloadByVenue[venueNorm] = payload as unknown as Record<string, unknown>;
  lastQuoteAtMsByVenue[venueNorm] = Number(payload.at_ms);
  return json(payload);
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = (url.pathname || "/").replace(/\/+$/, "") || "/";

  if (path === "/api/config" && request.method === "GET") return handleApiGetConfig();
  if (path === "/api/config" && request.method === "POST") return handleApiPostConfig(request);
  if (path === "/api/candles" && request.method === "GET") return await handleApiCandles(url, env);
  if (path === "/api/price-spread-candles" && request.method === "GET") {
    const proxied = await proxyBackendApi(env, "/api/price-spread-candles", url);
    if (proxied != null) return proxied;
    return json(
      {
        ok: false,
        error: "cloudflare_worker_stub",
        hint:
          "价差 USDT K 线需在 FastAPI 运行 /api/price-spread-candles，或在 Worker 环境变量中设置 BACKEND_ORIGIN 指向该后端以反向代理。历史差值% K 线（Gate / Bitget）已由 Worker 内联 OKX+对应现货 REST 支持（与 FastAPI 同源算法）。",
      },
      { status: 501 },
    );
  }
  if (path === "/api/quote" && request.method === "GET") return handleApiQuoteWithEnv(url, env);
  if (path === "/api/bark/test" && request.method === "POST") return handleApiBarkTest(request);

  return json({ error: "not_found", path }, { status: 404 });
}

async function handleApiQuoteWithEnv(url: URL, env: Env): Promise<Response> {
  // Reuse the same logic but allow a Browser Rendering last-resort for Bitget.
  const venueNorm = normalizeVenue(url.searchParams.get("venue"));
  const now = nowMs();

  const cached = lastQuotePayloadByVenue[venueNorm];
  const cachedAt = lastQuoteAtMsByVenue[venueNorm];
  const rev0 = Number((cached as Record<string, unknown> | undefined)?.shares_revision) || 0;
  if (
    cached &&
    cachedAt != null &&
    now - cachedAt <= QUOTE_CACHE_TTL_MS &&
    rev0 === QUOTE_SHARES_REVISION
  ) {
    const mcap = cached.market_cap as Record<string, unknown> | undefined;
    const v = asFloat(mcap?.diff_pct_vs_spot);
    maybeAppendHistoryPoint(venueNorm, v, now);
    return json(cached);
  }

  const t0 = now;
  const [okxR, spotR0] = await Promise.all([
    fetchOkxLast(),
    venueNorm === "bitget" ? fetchBitgetLast() : fetchGateLast(),
  ]);

  let spotR = spotR0;
  if (venueNorm === "bitget" && spotR.last == null && spotR.meta?.error === "http_403" && env.BROWSER) {
    const br = await fetchBitgetLastViaBrowser(env);
    if (br.last != null) spotR = br;
  }

  // Now proceed using the original quote builder by temporarily injecting the fetched results.
  // Minimal duplication: rebuild payload here (same as handleApiQuote).
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

  const mcapW: Record<string, unknown> = {
    okx_shares_outstanding: okxShares,
    spot_shares_outstanding: spotShares,
    okx_implied_usd: okxMcap,
    spot_implied_usd: spotMcap,
    diff_usd: mcapDiff,
    diff_pct_vs_spot: mcapDiffPct,
    notes: venueNorm === "gate" ? MCAP_NOTES_GATE : MCAP_NOTES_BITGET,
    spot_shares_formula: null as string | null,
  };
  if (venueNorm === "gate") {
    mcapW.spot_shares_formula = `${GATE_SHARES_NUMERATOR}/${GATE_SHARES_DENOMINATOR}`;
    mcapW.spot_shares_outstanding_exact = GATE_SHARES_OUTSTANDING;
  }

  const payload = {
    venue: venueNorm,
    shares_revision: QUOTE_SHARES_REVISION,
    at_ms: nowMs(),
    latency_ms: nowMs() - t0,
    okx: { instId: OKX_INST_ID, last: okxLast, meta: okxMeta },
    spot: {
      venue: venueNorm,
      symbol: venueNorm === "bitget" ? BITGET_SYMBOL : GATE_CURRENCY_PAIR,
      last: spotLast,
      meta: spotMeta,
      spot_page: venueNorm === "bitget" ? BITGET_SPOT_PAGE_URL : GATE_SPOT_PAGE_URL,
    },
    spread: { abs: spread, pct_vs_spot: spreadPct, mid },
    market_cap: mcapW,
    bark,
  };

  lastQuotePayloadByVenue[venueNorm] = payload as unknown as Record<string, unknown>;
  lastQuoteAtMsByVenue[venueNorm] = Number(payload.at_ms);
  return json(payload);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    const assetResp = await env.ASSETS.fetch(request);

    // Force revalidation for HTML/app bundle so hotfixes are visible immediately.
    if (url.pathname === "/" || url.pathname.endsWith(".html") || url.pathname.endsWith("/static/app.js")) {
      const headers = new Headers(assetResp.headers);
      headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
      headers.set("pragma", "no-cache");
      headers.set("expires", "0");
      return new Response(assetResp.body, {
        status: assetResp.status,
        statusText: assetResp.statusText,
        headers,
      });
    }

    return assetResp;
  },
};
