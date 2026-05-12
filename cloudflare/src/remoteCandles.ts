/**
 * Gate / Bitget 口径「市值差值%」历史 K：与 spacex_spread_monitor/main.py 中
 * _gate_hist_candles_from_rest_sync / _bitget_hist_candles_from_rest_sync 及
 * _aligned_1m_okx_gate_frame / _aligned_1m_okx_bitget_frame 同源逻辑，
 * 供 Worker standalone 部署（不再仅依赖内存 histPoints）。
 */

import {
  BITGET_REST_HISTORY_CANDLES,
  BITGET_SHARES_OUTSTANDING,
  BITGET_SPOT_PAGE_URL,
  BITGET_SYMBOL,
  GATE_CURRENCY_PAIR,
  GATE_SHARES_OUTSTANDING,
  OKX_INST_ID,
  OKX_SHARES_OUTSTANDING,
} from "./remoteCandlesConsts";

export const SPREAD_DEFAULT_FROM_TS_SEC = 1778148000; // 北京时间 2026-05-07 18:00（与 Python _SPREAD_DEFAULT_FROM_TS_SEC 一致）

/** 与 main.py `_aligned_rest_fetch_start_sec` 同源：OKX 日 K discovery 偏晚时仍以默认窗为 REST 拉取起点下限 */
function alignedRestFetchStartSec(discoverSec: number): number {
  return Math.min(Math.floor(discoverSec), SPREAD_DEFAULT_FROM_TS_SEC);
}

/** 与 main.py DIFF_PCT_VS_GATE_FORMULA 一致（可读 JSON） */
const DIFF_PCT_VS_GATE_FORMULA =
  "[(OKX股数×OKX合约价) − (Gate股数×Gate现货价)] / (Gate股数×Gate现货价) × 100%";

/** 与 main.py DIFF_PCT_VS_BITGET_FORMULA 一致 */
const DIFF_PCT_VS_BITGET_FORMULA =
  "[(OKX股数×OKX合约价) − (Bitget股数×Bitget现货价)] / (Bitget股数×Bitget现货价) × 100%";

type Ohlc = { o: number; h: number; l: number; c: number };

const GATE_HIST_REMOTE_TF_SEC = new Set([60, 300, 3600, 14_400, 86_400]);
const MAX_HIST_CANDLES_RESPONSE = 100_000;

let okxEarliestSecMem: number | null | undefined;

interface McapFrameRow {
  t_sec: number;
  mcap_pct: number | null;
}

interface FrameRow extends McapFrameRow {
  okx: [number, number, number, number];
  gate: [number, number, number, number];
}

function parseOkxRow(row: unknown[]): { tsMs: number; ohlc: Ohlc } | null {
  if (!Array.isArray(row) || row.length < 5) return null;
  try {
    const tsMs = Number(row[0]);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    if (!Number.isFinite(tsMs)) return null;
    return { tsMs, ohlc: { o, h, l, c } };
  } catch {
    return null;
  }
}

function parseGateRow(row: unknown[]): { tsSec: number; ohlc: Ohlc } | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  try {
    const tsSec = Number(row[0]);
    const c = Number(row[2]);
    const h = Number(row[3]);
    const l = Number(row[4]);
    const o = Number(row[5]);
    if (!Number.isFinite(tsSec)) return null;
    return { tsSec, ohlc: { o, h, l, c } };
  } catch {
    return null;
  }
}

/** 与 Python `_mcap_diff_pct_gate_from_prices` 同源：(OKX股数×OKX收 − Gate股数×Gate收) / (Gate隐含市值) × 100 */
function mcapDiffPctGateFromPrices(okxLast: number, gateLast: number): number | null {
  const gateMcap = gateLast * GATE_SHARES_OUTSTANDING;
  if (!gateMcap) return null;
  const okxMcap = okxLast * OKX_SHARES_OUTSTANDING;
  return ((okxMcap - gateMcap) / gateMcap) * 100;
}

/** 与 Python `_mcap_diff_pct_bitget_from_prices` 同源 */
function mcapDiffPctBitgetFromPrices(okxLast: number, bitgetLast: number): number | null {
  const bitgetMcap = bitgetLast * BITGET_SHARES_OUTSTANDING;
  if (!bitgetMcap) return null;
  const okxMcap = okxLast * OKX_SHARES_OUTSTANDING;
  return ((okxMcap - bitgetMcap) / bitgetMcap) * 100;
}

async function discoverOkxEarliestSec(): Promise<number | null> {
  if (okxEarliestSecMem !== undefined) return okxEarliestSecMem;
  let minMs: number | null = null;
  let afterMs: number | null = null;
  const url = "https://www.okx.com/api/v5/market/history-candles";
  for (let i = 0; i < 400; i++) {
    const p = new URLSearchParams({ instId: OKX_INST_ID, bar: "1D", limit: "100" });
    if (afterMs != null) p.set("after", String(afterMs));
    const r = await fetch(`${url}?${p}`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) break;
    const payload = (await r.json()) as { data?: unknown[] };
    const data = payload.data;
    if (!Array.isArray(data) || data.length === 0) break;
    const prevAfter = afterMs;
    for (const row of data) {
      const pr = parseOkxRow(row as unknown[]);
      if (pr) minMs = minMs == null ? pr.tsMs : Math.min(minMs, pr.tsMs);
    }
    try {
      const oldestMs = Number((data[data.length - 1] as unknown[])[0]);
      if (!Number.isFinite(oldestMs)) break;
      if (prevAfter != null && prevAfter === oldestMs) break;
      afterMs = oldestMs;
      if (data.length < 100) break;
    } catch {
      break;
    }
  }
  if (minMs == null) {
    const r2 = await fetch(
      `https://www.okx.com/api/v5/market/candles?${new URLSearchParams({
        instId: OKX_INST_ID,
        bar: "1D",
        limit: "100",
      })}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (r2.ok) {
      const payload2 = (await r2.json()) as { data?: unknown[] };
      const data2 = payload2.data;
      if (Array.isArray(data2)) {
        for (const row of data2) {
          const pr = parseOkxRow(row as unknown[]);
          if (pr) minMs = minMs == null ? pr.tsMs : Math.min(minMs, pr.tsMs);
        }
      }
    }
  }
  okxEarliestSecMem = minMs == null ? null : Math.floor(minMs / 1000);
  return okxEarliestSecMem;
}

async function okxFetchCandlesMap(bar: string, startSec: number, endSec: number): Promise<Map<number, Ohlc>> {
  const out = new Map<number, Ohlc>();
  const r0 = await fetch(
    `https://www.okx.com/api/v5/market/candles?${new URLSearchParams({
      instId: OKX_INST_ID,
      bar,
      limit: "300",
    })}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!r0.ok) throw new Error(`okx_candles_http_${r0.status}`);
  const j0 = (await r0.json()) as { data?: unknown[] };
  for (const row of j0.data || []) {
    const p = parseOkxRow(row as unknown[]);
    if (!p) continue;
    const tsSec = Math.floor(p.tsMs / 1000);
    if (tsSec < startSec || tsSec > endSec) continue;
    const { o, h, l, c } = p.ohlc;
    out.set(tsSec, { o, h, l, c });
  }

  let afterMs =
    out.size > 0 ? Math.min(...Array.from(out.keys())) * 1000 : Math.floor(endSec) * 1000;
  const urlHist = "https://www.okx.com/api/v5/market/history-candles";
  for (let iter = 0; iter < 3000; iter++) {
    const p = new URLSearchParams({
      instId: OKX_INST_ID,
      bar,
      limit: "300",
      after: String(Math.floor(afterMs)),
    });
    const rh = await fetch(`${urlHist}?${p}`, { signal: AbortSignal.timeout(30_000) });
    if (!rh.ok) throw new Error(`okx_hist_candles_http_${rh.status}`);
    const jh = (await rh.json()) as { data?: unknown[] };
    const rows = jh.data;
    if (!Array.isArray(rows) || rows.length === 0) break;
    let oldestMs = 0;
    try {
      oldestMs = Number((rows[rows.length - 1] as unknown[])[0]);
    } catch {
      break;
    }
    let stopPaging = false;
    for (const row of rows) {
      const pr = parseOkxRow(row as unknown[]);
      if (!pr) continue;
      const tsSec = Math.floor(pr.tsMs / 1000);
      if (tsSec > endSec) continue;
      if (tsSec < startSec) {
        stopPaging = true;
        continue;
      }
      const { o, h, l, c } = pr.ohlc;
      out.set(tsSec, { o, h, l, c });
    }
    afterMs = oldestMs;
    if (Math.floor(oldestMs / 1000) < startSec) stopPaging = true;
    if (rows.length < 300 || stopPaging) break;
  }
  return out;
}

function gateBarSeconds(gateInterval: string): number {
  const gi = String(gateInterval);
  return { "1m": 60, "5m": 300, "1h": 3600, "4h": 14_400 }[gi] ?? 3600;
}

function gateChunkSpanSec(gateInterval: string): number {
  return 1000 * gateBarSeconds(gateInterval);
}

async function gateFetchCandlesMap(
  gateInterval: string,
  startSec: number,
  endSec: number,
): Promise<Map<number, Ohlc>> {
  const out = new Map<number, Ohlc>();
  const url = "https://api.gateio.ws/api/v4/spot/candlesticks";
  const step = gateChunkSpanSec(gateInterval);
  let t = Math.floor(startSec);
  const end = Math.floor(endSec);
  while (t <= end) {
    const chunkEnd = Math.min(end, t + step - 1);
    const p = new URLSearchParams({
      currency_pair: GATE_CURRENCY_PAIR,
      interval: gateInterval,
      from: String(t),
      to: String(chunkEnd),
      limit: "1000",
    });
    const r = await fetch(`${url}?${p}`, { signal: AbortSignal.timeout(45_000) });
    if (!r.ok) throw new Error(`gate_candles_http_${r.status}`);
    const arr = (await r.json()) as unknown[];
    if (!Array.isArray(arr)) break;
    for (const row of arr) {
      const pr = parseGateRow(row as unknown[]);
      if (!pr) continue;
      const { tsSec, ohlc } = pr;
      if (tsSec < startSec || tsSec > endSec) continue;
      out.set(tsSec, ohlc);
    }
    t = chunkEnd + 1;
  }
  return out;
}

function parseBitgetRow(row: unknown[]): { tsSec: number; ohlc: Ohlc } | null {
  if (!Array.isArray(row) || row.length < 5) return null;
  try {
    const tsMs = Number(row[0]);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    if (!Number.isFinite(tsMs)) return null;
    const tsSec = Math.floor(tsMs / 1000);
    return { tsSec, ohlc: { o, h, l, c } };
  } catch {
    return null;
  }
}

/** Bitget v2 history-candles：分页 limit 200，granularity=1min（与 main.py 一致） */
async function bitgetFetchCandlesMap(startSec: number, endSec: number): Promise<Map<number, Ohlc>> {
  const out = new Map<number, Ohlc>();
  const startSecI = Math.floor(startSec);
  const endSecI = Math.floor(endSec);
  let endMs = Math.floor(endSecI / 60) * 60 * 1000;

  for (let iter = 0; iter < 8000; iter++) {
    const p = new URLSearchParams({
      symbol: BITGET_SYMBOL,
      granularity: "1min",
      limit: "200",
      endTime: String(endMs),
    });
    const r = await fetch(`${BITGET_REST_HISTORY_CANDLES}?${p}`, { signal: AbortSignal.timeout(45_000) });
    if (!r.ok) throw new Error(`bitget_candles_http_${r.status}`);
    const j = (await r.json()) as { code?: string; data?: unknown[] };
    if (String(j.code) !== "00000") break;
    const data = j.data;
    if (!Array.isArray(data) || data.length === 0) break;
    let batchMinMs: number | null = null;
    for (const row of data) {
      const pr = parseBitgetRow(row as unknown[]);
      if (!pr) continue;
      const tsMs = pr.tsSec * 1000;
      batchMinMs = batchMinMs == null ? tsMs : Math.min(batchMinMs, tsMs);
      const { tsSec, ohlc } = pr;
      if (tsSec > endSecI) continue;
      if (tsSec < startSecI) continue;
      out.set(tsSec, ohlc);
    }
    if (batchMinMs == null) break;
    if (Math.floor(batchMinMs / 1000) < startSecI) break;
    endMs = batchMinMs - 1;
    if (data.length < 200) break;
  }
  return out;
}

async function aligned1mOkxGateFrame(fetchStart: number, endSec: number): Promise<FrameRow[]> {
  const [okxMap, gateMap] = await Promise.all([
    okxFetchCandlesMap("1m", fetchStart, endSec),
    gateFetchCandlesMap("1m", fetchStart, endSec),
  ]);
  const keys = Array.from(okxMap.keys())
    .filter((k) => gateMap.has(k))
    .sort((a, b) => a - b);
  const out: FrameRow[] = [];
  for (const ts of keys) {
    const ok = okxMap.get(ts)!;
    const gt = gateMap.get(ts)!;
    const mcap_pct = mcapDiffPctGateFromPrices(ok.c, gt.c);
    out.push({
      t_sec: ts,
      okx: [ok.o, ok.h, ok.l, ok.c],
      gate: [gt.o, gt.h, gt.l, gt.c],
      mcap_pct,
    });
  }
  return out;
}

async function aligned1mOkxBitgetFrame(fetchStart: number, endSec: number): Promise<McapFrameRow[]> {
  const [okxMap, bitgetMap] = await Promise.all([
    okxFetchCandlesMap("1m", fetchStart, endSec),
    bitgetFetchCandlesMap(fetchStart, endSec),
  ]);
  const keys = Array.from(okxMap.keys())
    .filter((k) => bitgetMap.has(k))
    .sort((a, b) => a - b);
  const out: McapFrameRow[] = [];
  for (const ts of keys) {
    const ok = okxMap.get(ts)!;
    const bg = bitgetMap.get(ts)!;
    const mcap_pct = mcapDiffPctBitgetFromPrices(ok.c, bg.c);
    out.push({ t_sec: ts, mcap_pct });
  }
  return out;
}

interface CandlePct extends Ohlc {
  t: number;
  pct_close?: number | null;
}

function frameTo1mMcapPctCandles(frame: McapFrameRow[], floorSec: number): CandlePct[] {
  const fl = Math.floor(floorSec);
  const out: CandlePct[] = [];
  for (const r of frame) {
    const ts = r.t_sec;
    if (ts < fl) continue;
    const v = r.mcap_pct;
    if (v == null || Number.isNaN(v)) continue;
    const vf = Number(v);
    out.push({ t: ts, o: vf, h: vf, l: vf, c: vf, pct_close: vf });
  }
  return out;
}

function resampleOhlcCandles(sorted: CandlePct[], stepSec: number): CandlePct[] {
  if (!sorted.length || stepSec <= 0) return [];
  const step = Math.floor(stepSec);
  const sortedRows = [...sorted].sort((a, b) => a.t - b.t);
  const out: CandlePct[] = [];
  let curB: number | null = null;
  let o: number | null = null;
  let h: number | null = null;
  let l: number | null = null;
  let c: number | null = null;
  let lastPct: number | null = null;

  const flush = () => {
    if (curB != null && o != null && h != null && l != null && c != null) {
      out.push({ t: curB, o, h, l, c, pct_close: lastPct });
    }
  };

  for (const x of sortedRows) {
    const ts = x.t;
    const b = Math.floor(ts / step) * step;
    const vo = x.o;
    const vh = x.h;
    const vl = x.l;
    const vc = x.c;
    const pc = x.pct_close;
    if (curB === null || b !== curB) {
      flush();
      curB = b;
      o = vo;
      h = vh;
      l = vl;
      c = vc;
      lastPct = pc != null && Number.isFinite(Number(pc)) ? Number(pc) : null;
    } else {
      h = Math.max(h!, vh);
      l = Math.min(l!, vl);
      c = vc;
      if (pc != null && Number.isFinite(Number(pc))) lastPct = Number(pc);
    }
  }
  flush();
  return out;
}

function rollupSpreadToUtcDay(hourly: CandlePct[]): CandlePct[] {
  const buckets = new Map<number, CandlePct[]>();
  for (const c of hourly) {
    const ts = c.t;
    const day0 = Math.floor(ts / 86_400) * 86_400;
    const arr = buckets.get(day0) || [];
    arr.push(c);
    buckets.set(day0, arr);
  }
  const out: CandlePct[] = [];
  for (const day0 of Array.from(buckets.keys()).sort((a, b) => a - b)) {
    const arr = buckets.get(day0)!;
    arr.sort((a, b) => a.t - b.t);
    const o = arr[0].o;
    const c = arr[arr.length - 1].c;
    const h = Math.max(...arr.map((x) => x.h));
    const l = Math.min(...arr.map((x) => x.l));
    const lastPct = arr[arr.length - 1].pct_close;
    out.push({
      t: day0,
      o,
      h,
      l,
      c,
      pct_close: lastPct != null ? Number(lastPct) : null,
    });
  }
  return out;
}

function stripPctClose(candles: CandlePct[]): { t: number; o: number; h: number; l: number; c: number }[] {
  return candles.map((c) => ({
    t: c.t,
    o: c.o,
    h: c.h,
    l: c.l,
    c: c.c,
  }));
}

export async function buildGateHistRemotePayload(tfSecIn: number): Promise<Record<string, unknown>> {
  const effFrom = SPREAD_DEFAULT_FROM_TS_SEC;
  const gateHistFloorMs = effFrom * 1000;
  let tfI = Math.floor(tfSecIn);
  if (!GATE_HIST_REMOTE_TF_SEC.has(tfI)) tfI = 60;

  const discover = await discoverOkxEarliestSec();
  if (discover == null) {
    return {
      tf: tfI,
      venue: "gate",
      candles: [],
      range: { min: null, max: null },
      points: 0,
      points_raw: 0,
      hist_from_ms: gateHistFloorMs,
      effective_from_ts_sec: effFrom,
      data_source: "okx_gate_public_rest",
      error: "okx_listing_unavailable",
      data_source_detail: "无法取得 OKX 可溯起点；请稍后重试。",
      hist_time_align: "okx_gate_spread_k_same_buckets",
      diff_pct_formula: DIFF_PCT_VS_GATE_FORMULA,
      price_sources: { okx_instId: OKX_INST_ID, gate_currency_pair: GATE_CURRENCY_PAIR },
      window_timezone_note: "默认窗起点为北京时间；K 线时间戳为 Unix 秒；图表建议 Asia/Shanghai 显示",
      inst_id: OKX_INST_ID,
      gate_pair: GATE_CURRENCY_PAIR,
    };
  }

  const endSec = Math.floor(Date.now() / 1000);
  const fetchStart = alignedRestFetchStartSec(discover);
  const frame = await aligned1mOkxGateFrame(fetchStart, endSec);
  const floorSec = effFrom;
  const one_m = frameTo1mMcapPctCandles(frame, floorSec);

  let rawCandles: CandlePct[];
  if (tfI === 86_400) {
    let hourly = resampleOhlcCandles(one_m, 3600);
    hourly = hourly.filter((c) => c.t >= effFrom);
    rawCandles = rollupSpreadToUtcDay(hourly);
  } else {
    const step = { 60: 60, 300: 300, 3600: 3600, 14400: 14400 }[tfI] ?? 60;
    if (step === 60) {
      rawCandles = one_m;
    } else {
      rawCandles = resampleOhlcCandles(one_m, step);
      rawCandles = rawCandles.filter((c) => c.t >= effFrom);
    }
  }

  const candles = stripPctClose(rawCandles);
  const nBuilt = candles.length;
  const candlesOut =
    nBuilt > MAX_HIST_CANDLES_RESPONSE ? candles.slice(-MAX_HIST_CANDLES_RESPONSE) : candles;
  const lows = candlesOut.map((x) => x.l);
  const highs = candlesOut.map((x) => x.h);
  const rng = {
    min: lows.length ? Math.min(...lows) : null,
    max: highs.length ? Math.max(...highs) : null,
  };

  const windowFromBeijing = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(effFrom * 1000));

  const firstTs = candlesOut.length ? candlesOut[0].t : null;
  const lastTs = candlesOut.length ? candlesOut[candlesOut.length - 1].t : null;

  return {
    tf: tfI,
    venue: "gate",
    candles: candlesOut,
    candles_built: nBuilt,
    candles_truncated: nBuilt > MAX_HIST_CANDLES_RESPONSE,
    candles_max_return: MAX_HIST_CANDLES_RESPONSE,
    range: rng,
    aggregation: "rest_aligned_1m",
    candles_first_ts: firstTs,
    candles_last_ts: lastTs,
    points: one_m.length,
    points_raw: one_m.length,
    hist_from_ms: gateHistFloorMs,
    effective_from_ts_sec: effFrom,
    effective_from_ts_iso_utc: new Date(effFrom * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    window_from_beijing: `${windowFromBeijing.replace(/\//g, "-")}（UTC+8）`,
    window_note:
      "默认窗：北京时间 2026-05-07 18:00 起至当前（与 UTC 2026-05-07 10:00 对齐）；Worker 已与 FastAPI 同源 REST 聚合。",
    data_source: "okx_gate_public_rest",
    data_source_detail:
      "Worker 内联 OKX+Gate 公开 REST（对齐 1m→市值差值%→重采样）；与 spacex_spread_monitor/main.py 一致。",
    hist_time_align: "okx_gate_spread_k_same_buckets",
    diff_pct_formula: DIFF_PCT_VS_GATE_FORMULA,
    price_sources: { okx_instId: OKX_INST_ID, gate_currency_pair: GATE_CURRENCY_PAIR },
    window_timezone_note: "默认窗起点为北京时间；K 线时间戳为 Unix 秒；图表建议 Asia/Shanghai 显示",
    inst_id: OKX_INST_ID,
    gate_pair: GATE_CURRENCY_PAIR,
    cached: false,
  };
}

export async function buildBitgetHistRemotePayload(tfSecIn: number): Promise<Record<string, unknown>> {
  const effFrom = SPREAD_DEFAULT_FROM_TS_SEC;
  const gateHistFloorMs = effFrom * 1000;
  let tfI = Math.floor(tfSecIn);
  if (!GATE_HIST_REMOTE_TF_SEC.has(tfI)) tfI = 60;

  const discover = await discoverOkxEarliestSec();
  if (discover == null) {
    return {
      tf: tfI,
      venue: "bitget",
      candles: [],
      range: { min: null, max: null },
      points: 0,
      points_raw: 0,
      hist_from_ms: gateHistFloorMs,
      effective_from_ts_sec: effFrom,
      data_source: "okx_bitget_public_rest",
      error: "okx_listing_unavailable",
      data_source_detail: "无法取得 OKX 可溯起点；请稍后重试。",
      hist_time_align: "okx_bitget_spread_k_same_buckets",
      diff_pct_formula: DIFF_PCT_VS_BITGET_FORMULA,
      price_sources: {
        okx_instId: OKX_INST_ID,
        bitget_symbol: BITGET_SYMBOL,
        bitget_spot_page: BITGET_SPOT_PAGE_URL,
      },
      window_timezone_note: "默认窗起点为北京时间；K 线时间戳为 Unix 秒；图表建议 Asia/Shanghai 显示",
      inst_id: OKX_INST_ID,
      bitget_symbol: BITGET_SYMBOL,
      page_links: { okx: "https://www.okx.com/zh-hans/trade-swap/spacex-usdt-swap", bitget: BITGET_SPOT_PAGE_URL },
      rest_endpoints: {
        okx: "https://www.okx.com/api/v5/market/candles",
        bitget: BITGET_REST_HISTORY_CANDLES,
      },
    };
  }

  const endSec = Math.floor(Date.now() / 1000);
  const fetchStart = alignedRestFetchStartSec(discover);
  const frame = await aligned1mOkxBitgetFrame(fetchStart, endSec);
  const floorSec = effFrom;
  const one_m = frameTo1mMcapPctCandles(frame, floorSec);

  let rawCandles: CandlePct[];
  if (tfI === 86_400) {
    let hourly = resampleOhlcCandles(one_m, 3600);
    hourly = hourly.filter((c) => c.t >= effFrom);
    rawCandles = rollupSpreadToUtcDay(hourly);
  } else {
    const step = { 60: 60, 300: 300, 3600: 3600, 14400: 14400 }[tfI] ?? 60;
    if (step === 60) {
      rawCandles = one_m;
    } else {
      rawCandles = resampleOhlcCandles(one_m, step);
      rawCandles = rawCandles.filter((c) => c.t >= effFrom);
    }
  }

  const candles = stripPctClose(rawCandles);
  const nBuilt = candles.length;
  const candlesOut =
    nBuilt > MAX_HIST_CANDLES_RESPONSE ? candles.slice(-MAX_HIST_CANDLES_RESPONSE) : candles;
  const lows = candlesOut.map((x) => x.l);
  const highs = candlesOut.map((x) => x.h);
  const rng = {
    min: lows.length ? Math.min(...lows) : null,
    max: highs.length ? Math.max(...highs) : null,
  };

  const windowFromBeijing = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(effFrom * 1000));

  const firstTs = candlesOut.length ? candlesOut[0].t : null;
  const lastTs = candlesOut.length ? candlesOut[candlesOut.length - 1].t : null;

  return {
    tf: tfI,
    venue: "bitget",
    candles: candlesOut,
    candles_built: nBuilt,
    candles_truncated: nBuilt > MAX_HIST_CANDLES_RESPONSE,
    candles_max_return: MAX_HIST_CANDLES_RESPONSE,
    range: rng,
    aggregation: "rest_aligned_1m",
    candles_first_ts: firstTs,
    candles_last_ts: lastTs,
    points: one_m.length,
    points_raw: one_m.length,
    hist_from_ms: gateHistFloorMs,
    effective_from_ts_sec: effFrom,
    effective_from_ts_iso_utc: new Date(effFrom * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    window_from_beijing: `${windowFromBeijing.replace(/\//g, "-")}（UTC+8）`,
    window_note:
      "默认窗：北京时间 2026-05-07 18:00 起至当前；Worker 已与 FastAPI Bitget REST 同源聚合（OKX+Bitget 1m 对齐）。",
    data_source: "okx_bitget_public_rest",
    data_source_detail:
      "Worker 内联 OKX+Bitget 公开 REST（对齐 1m→市值差值% 相对 Bitget→重采样）；与 spacex_spread_monitor/main.py 一致。",
    hist_time_align: "okx_bitget_spread_k_same_buckets",
    diff_pct_formula: DIFF_PCT_VS_BITGET_FORMULA,
    price_sources: {
      okx_instId: OKX_INST_ID,
      bitget_symbol: BITGET_SYMBOL,
      bitget_spot_page: BITGET_SPOT_PAGE_URL,
    },
    window_timezone_note: "默认窗起点为北京时间；K 线时间戳为 Unix 秒；图表建议 Asia/Shanghai 显示",
    inst_id: OKX_INST_ID,
    bitget_symbol: BITGET_SYMBOL,
    page_links: { okx: "https://www.okx.com/zh-hans/trade-swap/spacex-usdt-swap", bitget: BITGET_SPOT_PAGE_URL },
    rest_endpoints: {
      okx: "https://www.okx.com/api/v5/market/candles",
      bitget: BITGET_REST_HISTORY_CANDLES,
    },
    cached: false,
  };
}
