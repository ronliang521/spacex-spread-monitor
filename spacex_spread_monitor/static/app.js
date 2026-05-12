const fmtNum = (n, digits = 2) => {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
};

const fmtPct = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
};

const fmtUsdCompact = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(Number(n));
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
};

const fmtSharesB = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const v = Number(n) / 1e9;
  return `${v.toFixed(6)}B`;
};

/** Gate 总股本：与后端 `main.py` 一致；前端固定口径，避免旧 /api/quote 仍返回 2.375B。 */
const GATE_SHARES_NUMERATOR = 1_400_000_000_000;
const GATE_SHARES_DENOMINATOR = 590;
const GATE_SHARES_FLOAT = GATE_SHARES_NUMERATOR / GATE_SHARES_DENOMINATOR;
const GATE_SHARES_INT_ROUNDED = Math.round(GATE_SHARES_FLOAT);
const OKX_SHARES_FIXED_INT = 1_000_000_000;

/** 与后端 main.py 常量一致（价差 K / 文案） */
const OKX_INST_ID = "SPACEX-USDT-SWAP";
const GATE_CURRENCY_PAIR = "SPCX_USDT";
const BITGET_SYMBOL_REST = "PRESPAXUSDT";

const $ = (id) => document.getElementById(id);

/**
 * 后端 API 根（用于 Cloudflare 静态页仍命中旧 Worker 时，把 JSON 指到 FastAPI）。
 * 优先级：localStorage `SPACEX_MONITOR_API_BASE` > meta[name=spacex-monitor-api-base] > window.SPACEX_MONITOR_API_BASE
 * 例：控制台执行 localStorage.setItem("SPACEX_MONITOR_API_BASE","https://你的.trycloudflare.com") 后刷新。
 */
function apiBase() {
  try {
    const ls = localStorage.getItem("SPACEX_MONITOR_API_BASE");
    if (ls != null && String(ls).trim()) return String(ls).trim().replace(/\/+$/, "");
  } catch {
    /* ignore */
  }
  try {
    const m = document.querySelector('meta[name="spacex-monitor-api-base"]');
    const c = m?.getAttribute("content");
    if (c != null && String(c).trim()) return String(c).trim().replace(/\/+$/, "");
  } catch {
    /* ignore */
  }
  try {
    const g = window.SPACEX_MONITOR_API_BASE;
    if (typeof g === "string" && g.trim()) return g.trim().replace(/\/+$/, "");
  } catch {
    /* ignore */
  }
  return "";
}

function apiUrl(pathWithLeadingSlash) {
  const base = apiBase();
  const p = pathWithLeadingSlash.startsWith("/") ? pathWithLeadingSlash : `/${pathWithLeadingSlash}`;
  if (!base) return p;
  return `${base}${p}`;
}

let timer = null;
let intervalMs = 2000;
let paused = false;
let lastBarkStatusText = "—";
let barkKeysDraft = [];

const VENUE_KEY = "spacex_spread_venue";
let venue = "gate";

const THEME_KEY = "spacex_spread_theme";

let _systemMql = null;

function _systemTheme() {
  try {
    if (!_systemMql) _systemMql = window.matchMedia("(prefers-color-scheme: light)");
    return _systemMql.matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function _setThemeAttr(theme) {
  document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
}

function _updateThemeButton(mode) {
  const btn = $("btn-theme");
  if (!btn) return;
  const label = mode === "light" ? "白天" : mode === "dark" ? "黑夜" : "跟随系统";
  btn.textContent = label;
  btn.setAttribute("data-mode", mode);
}

function applyTheme(mode) {
  const m = mode === "light" ? "light" : mode === "dark" ? "dark" : "system";
  const effective = m === "system" ? _systemTheme() : m;
  _setThemeAttr(effective);

  try {
    localStorage.setItem(THEME_KEY, m);
  } catch {
    /* ignore */
  }
  _updateThemeButton(m);
}

function initTheme() {
  let t = "system";
  try {
    t = localStorage.getItem(THEME_KEY) || "system";
  } catch {
    /* ignore */
  }
  applyTheme(t);

  // Live follow system changes when mode=system.
  try {
    if (!_systemMql) _systemMql = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => {
      const mode = localStorage.getItem(THEME_KEY) || "system";
      if (mode === "system") applyTheme("system");
    };
    if (_systemMql.addEventListener) _systemMql.addEventListener("change", handler);
    else if (_systemMql.addListener) _systemMql.addListener(handler);
  } catch {
    /* ignore */
  }
}

function cycleTheme() {
  const btn = $("btn-theme");
  const mode = (btn && btn.getAttribute("data-mode")) || "system";
  const next = mode === "system" ? "light" : mode === "light" ? "dark" : "system";
  applyTheme(next);
  const eff = next === "system" ? _systemTheme() : next;
  setOk(`已切换：${next === "system" ? "跟随系统" : next === "light" ? "白天" : "黑夜"}（当前：${eff === "light" ? "白天" : "黑夜"}）`);
}

let histTf = 60;
let histChart = null;
let histSeries = null;

let spreadTf = "1m";
let spreadChart = null;
let spreadSeries = null;

const SPREAD_FROM_KEY = "spacex_spread_from_mode";

function spreadFromQuery() {
  let mode = "default";
  try {
    mode = localStorage.getItem(SPREAD_FROM_KEY) || "default";
  } catch {
    /* ignore */
  }
  return mode === "listing" ? "&from_ts=0" : "";
}

function setSpreadWindowMode(mode, btnDefault, btnListing) {
  const m = mode === "listing" ? "listing" : "default";
  try {
    localStorage.setItem(SPREAD_FROM_KEY, m);
  } catch {
    /* ignore */
  }
  if (btnDefault) btnDefault.classList.toggle("active", m === "default");
  if (btnListing) btnListing.classList.toggle("active", m === "listing");
}

function spreadChartTime(tf, tsec) {
  if (tf !== "1d") return tsec;
  const d = new Date(Number(tsec) * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 历史差值% K 线：1D 与 USDT 价差图相同用 UTC 自然日 business day；其余用 unix 秒 */
function histChartTime(tfSeconds, tsec) {
  if (tfSeconds !== 86400) return tsec;
  const d = new Date(Number(tsec) * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function histTfLabel(tf) {
  if (tf === 60) return "1m";
  if (tf === 300) return "5m";
  if (tf === 3600) return "1h";
  if (tf === 14400) return "4h";
  if (tf === 86400) return "1D（UTC）";
  return `${tf}s`;
}

/** K 线轴/十字线统一按北京时间（与默认窗 5/7 18:00 叙事一致） */
const CHART_TZ = "Asia/Shanghai";

function chartLocalizationShanghai(secondsVisible) {
  const full = new Intl.DateTimeFormat("zh-CN", {
    timeZone: CHART_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(secondsVisible ? { second: "2-digit" } : {}),
    hour12: false,
  });
  const dayOnly = new Intl.DateTimeFormat("zh-CN", {
    timeZone: CHART_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return {
    locale: "zh-CN",
    dateFormat: "yyyy-MM-dd",
    timeFormatter: (time, tickMarkType) => {
      if (typeof time === "number") {
        const d = new Date(time * 1000);
        const tm = Number(tickMarkType);
        if (tm === 0 || tm === 1) return dayOnly.format(d);
        if (tm === 2) return dayOnly.format(d);
        return full.format(d);
      }
      if (time && typeof time === "object" && time.year != null) {
        const ms = Date.UTC(time.year, time.month - 1, time.day);
        return dayOnly.format(new Date(ms));
      }
      return "";
    },
  };
}

function ensureHistChart() {
  const el = $("hist-chart");
  if (!el || !window.LightweightCharts) return false;
  if (histChart) return true;

  histChart = window.LightweightCharts.createChart(el, {
    layout: {
      background: { type: "solid", color: "transparent" },
      textColor: getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#eef2f8",
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.06)" },
      horzLines: { color: "rgba(255,255,255,0.06)" },
    },
    localization: chartLocalizationShanghai(histTf === 60 || histTf === 300),
    timeScale: { timeVisible: true, secondsVisible: histTf === 60 || histTf === 300 },
    rightPriceScale: { borderVisible: false },
    crosshair: { mode: 0 },
    height: 320,
  });
  histSeries = histChart.addCandlestickSeries({
    upColor: "#34d399",
    downColor: "#fb7185",
    borderUpColor: "#34d399",
    borderDownColor: "#fb7185",
    wickUpColor: "#34d399",
    wickDownColor: "#fb7185",
  });
  return true;
}

function ensureSpreadChart() {
  const el = $("spread-chart");
  if (!el || !window.LightweightCharts) return false;
  if (spreadChart) return true;

  spreadChart = window.LightweightCharts.createChart(el, {
    layout: {
      background: { type: "solid", color: "transparent" },
      textColor: getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#eef2f8",
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.06)" },
      horzLines: { color: "rgba(255,255,255,0.06)" },
    },
    localization: chartLocalizationShanghai(spreadTf === "1m" || spreadTf === "5m"),
    timeScale: { timeVisible: true, secondsVisible: spreadTf === "1m" || spreadTf === "5m" },
    rightPriceScale: { borderVisible: false },
    crosshair: { mode: 0 },
    height: 360,
  });
  spreadSeries = spreadChart.addCandlestickSeries({
    upColor: "#38bdf8",
    downColor: "#f472b6",
    borderUpColor: "#38bdf8",
    borderDownColor: "#f472b6",
    wickUpColor: "#38bdf8",
    wickDownColor: "#f472b6",
  });
  return true;
}

async function loadSpreadCandles(opts = {}) {
  const bust = !!opts.bust;
  if (!ensureSpreadChart()) return;
  const win = spreadFromQuery();
  const qs = [`tf=${encodeURIComponent(spreadTf)}`, `venue=${encodeURIComponent(venue)}`];
  if (win) qs.push(win.replace(/^&/, ""));
  if (bust) qs.push("nocache=1");
  const res = await fetch(apiUrl(`/api/price-spread-candles?${qs.join("&")}`), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.ok) {
    throw new Error(data?.error || "spread_candles_failed");
  }
  const candles = (data?.candles || []).map((c) => ({
    time: spreadChartTime(spreadTf, c.t),
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
  }));
  spreadSeries.setData(candles);
  if (candles.length) spreadChart.timeScale().fitContent();

  const r = data?.range || {};
  const meta = data?.meta || {};
  const n = candles.length;
  const wfb = meta.window_from_beijing || meta.window_from_ts_iso_utc || "—";
  const wmode = meta.window_mode === "listing" ? "OKX可溯起点" : meta.window_mode === "custom" ? "自定义" : "默认(5/7 18:00北京)";
  const rollup = meta.rollup_note ? ` · ${meta.rollup_note}` : "";
  const cache = data?.cached ? ` · 缓存 ${Math.round((data.cache_age_ms || 0) / 1000)}s` : "";
  const spreadTruncHint =
    data?.candles_truncated && data?.candles_max_return != null
      ? ` · 已截断：仅返回最近 ${data.candles_max_return} 根（共生成 ${data.candles_built ?? "?"} 根）`
      : "";
  $("spread-range").textContent =
    r.min == null || r.max == null
      ? `暂无对齐 K 线（tf=${spreadTf}，窗=${wmode}）`
      : `周期 ${spreadTf} · 窗「${wfb}」· ${wmode} · 根数 ${n} · 价差 ${fmtNum(r.min, 2)} ~ ${fmtNum(r.max, 2)} USDT${rollup}${cache}${spreadTruncHint}`;
}

async function loadHistory(opts = {}) {
  const bust = !!opts.bust;
  if (!ensureHistChart()) return;

  const src = venue === "gate" || venue === "bitget" ? "remote" : "local";
  const qs = [`tf=${encodeURIComponent(histTf)}`, `venue=${encodeURIComponent(venue)}`, `source=${encodeURIComponent(src)}`];
  if (bust) qs.push("nocache=1");
  const res = await fetch(apiUrl(`/api/candles?${qs.join("&")}`), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const candles = (data?.candles || []).map((c) => ({
    time: histChartTime(histTf, c.t),
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
  }));
  histSeries.setData(candles);
  if (histChart) {
    histChart.applyOptions({
      localization: chartLocalizationShanghai(histTf === 60 || histTf === 300),
      timeScale: { timeVisible: true, secondsVisible: histTf === 60 || histTf === 300 },
    });
  }
  if (candles.length) histChart.timeScale().fitContent();

  const r = data?.range || {};
  const pts = data?.points ?? 0;
  const ptsRaw = data?.points_raw ?? pts;
  const tf = data?.tf ?? histTf;
  const tfDisp = histTfLabel(Number(tf) || histTf);
  const fromMs = data?.hist_from_ms;
  const floorHint =
    (venue === "gate" || venue === "bitget") && fromMs != null
      ? ` · 自 ${new Date(fromMs).toLocaleString()}（北京窗起点）`
      : venue !== "gate" && venue !== "bitget" && fromMs != null
        ? ` · 自 ${new Date(fromMs).toLocaleString()}（北京窗）`
        : "";
  const ds = data?.data_source || "";
  const dsHint =
    ds === "okx_gate_public_rest"
      ? " · 源:OKX+Gate公开REST(对齐1m→固定股数→差值%)"
      : ds === "okx_bitget_public_rest"
        ? " · 源:OKX+Bitget公开REST(对齐1m→固定股数→差值%)"
      : ds === "local_ndjson"
        ? " · 源:本地NDJSON"
        : ds
          ? ` · 源:${ds}`
          : "";
  const alignHint =
    data?.hist_time_align === "okx_gate_spread_k_same_buckets"
      ? " · 时间桶同上方 OKX×Gate USDT 价差K"
      : data?.hist_time_align === "okx_bitget_spread_k_same_buckets"
        ? " · 时间桶同上方 OKX×Bitget USDT 价差K"
        : "";
  const winHint =
    (venue === "gate" || venue === "bitget") && data?.window_from_beijing
      ? ` · 默认窗起点 ${data.window_from_beijing}（与价差图 from_ts=-1 一致）`
      : "";
  const truncHint =
    data?.candles_truncated && data?.candles_max_return != null
      ? ` · 已截断：仅返回最近 ${data.candles_max_return} 根（共生成 ${data.candles_built ?? "?"} 根）`
      : "";
  const cacheHint = data?.cached ? ` · 缓存 ${Math.round((data.cache_age_ms || 0) / 1000)}s` : "";
  const agg = data?.aggregation || "";
  const spanHint =
    data?.candles_first_ts != null && data?.candles_last_ts != null
      ? ` · 首根K→末根K ${new Date(data.candles_first_ts * 1000).toLocaleString()} — ${new Date(
          data.candles_last_ts * 1000,
        ).toLocaleString()}`
      : "";
  const memoryWarn =
    agg === "worker_memory_quote_samples"
      ? " · ⚠️图为 Worker 内存采样（非全量 REST），左侧会从「开始采样时刻」起才有K线；请 wrangler deploy 最新 Worker，或用 uvicorn 跑 FastAPI，或配置 BACKEND_ORIGIN。"
      : "";
  $("hist-range").textContent =
    r.min == null || r.max == null
      ? `暂无数据（原始点 ${ptsRaw}）${dsHint}${memoryWarn}${spanHint}`
      : `周期 ${tfDisp} · 差值% ${r.min.toFixed(2)}% ~ ${r.max.toFixed(2)}% · 入图点 ${pts}${floorHint}（原始 ${ptsRaw}）${dsHint}${alignHint}${winHint}${truncHint}${cacheHint}${memoryWarn}${spanHint}`;
}

/** Bitget 现货页（与公开 REST 品种 PRESPAXUSDT 同源展示）—须与后端 BITGET_SPCX_TRADE_URL 一致 */
const BITGET_SPOT_PAGE_URL = "https://www.bitget.com/zh-CN/spot/PRESPAXUSDT";

function renderHistHint() {
  const el = $("hist-hint");
  if (!el) return;
  if (venue === "bitget") {
    el.innerHTML = `
          纵轴为<strong>隐含市值差值%</strong>（相对 Bitget），股数与后端 <code>main.py</code> 常量一致：<strong>OKX</strong>
          <code>10 亿股</code> × 永续价（REST <code>SPACEX-USDT-SWAP</code>）、<strong>Bitget</strong>
          <code>2,307,692,308</code> 股（IPO Prime 口径）× 现货价；REST 交易对 <code>PRESPAXUSDT</code> 与 Bitget 官网现货页为<strong>同一标的</strong>。公式：
          <strong>[(OKX总股数×OKX合约价) − (Bitget总股数×Bitget现货价)] ÷ (Bitget总股数×Bitget现货价) × 100%</strong>。
          现货行情取自 <strong>Bitget 公开 REST</strong>（<code>api.bitget.com</code>），与
          <a href="${BITGET_SPOT_PAGE_URL}" target="_blank" rel="noopener">此处 PRESPAXUSDT 现货页</a>
          展示同源；与 OKX 1m 对齐后聚合成所选周期；默认历史 K 为 <strong>remote</strong>（全量 REST）。<strong>默认窗</strong>指「丢弃该时刻<strong>之前</strong>的对齐 1m」的下限（北京时间 <strong>2026-05-07 18:00</strong>，与后端 <code>_SPREAD_DEFAULT_FROM_TS_SEC</code> 一致）；<strong>首根可见 K 线</strong>是窗内<strong>首次同时存在 OKX 与 Bitget 分钟数据</strong>的时刻——若品种实际上架或可对齐交集晚于窗起点，图上从左开始会是更晚的日期（属正常，不是轴坏了）。大于 1m 的周期：K 线时间戳按与价差图相同的 <strong>UTC 桶对齐</strong>；轴/十字线数字用 <strong>北京时间</strong>格式化便于阅读。下方状态栏「首根K→末根K」可与默认窗对照。
          <code>?source=local</code> 仅用本地 NDJSON 采样。<strong>上方 USDT 价差 K</strong>为 <strong>OKX×Bitget</strong>，与下方市值差%同源 1m 对齐。后台采样写盘供 Bark/离线。
        `.trim();
    return;
  }
  el.innerHTML = `
          纵轴为<strong>隐含市值差值%</strong>（相对 Gate），股数与后端 <code>main.py</code> 常量一致：<strong>OKX</strong>
          <code>10 亿股</code> × 永续价（REST <code>SPACEX-USDT-SWAP</code>）、<strong>Gate</strong>
          <code>1.4 万亿÷590</code> 股 × 现货价（REST <code>SPCX_USDT</code>）。公式：
          <strong>[(OKX总股数×OKX合约价) − (Gate总股数×Gate现货价)] ÷ (Gate总股数×Gate现货价) × 100%</strong>。
          行情为 OKX/Gate <strong>公开 REST</strong>（与
          <a href="https://www.okx.com/zh-hans/trade-swap/spacex-usdt-swap" target="_blank" rel="noopener">OKX 永续页</a>、
          <a href="https://www.gate.com/zh/trade/SPCX_USDT" target="_blank" rel="noopener">Gate 现货页</a>
          同源标的），1m 对齐后聚合成所选周期。<strong>默认窗</strong>为数据下限（早于北京时间 <strong>2026-05-07 18:00</strong> 的对齐 1m 不入图）；<strong>首根 K</strong>为窗内首次 OKX+Gate 同时对齐 minute。大于 1m 为 <strong>UTC 桶</strong>；轴标签为北京时间。状态栏「首根K→末根K」可对读。
          <code>?source=local</code> 仅用本地 NDJSON。<strong>上方 USDT 价差 K</strong>为 <strong>OKX×Gate</strong>，与下方市值差%同源 1m 对齐。后台采样写盘供 Bark/离线。
        `.trim();
}

function renderSpreadHint() {
  const el = $("spread-hint");
  if (!el) return;
  if (venue === "bitget") {
    el.innerHTML = `
          口径：<strong>OKX 永续 − Bitget 现货</strong>（<code>${escapeHtml(OKX_INST_ID)}</code> vs <code>${escapeHtml(
            BITGET_SYMBOL_REST,
          )}</code>）。数据来自两家公开 REST
          K 线并按同一时间桶对齐。<strong>默认时间窗</strong>：<strong>北京时间 2026-05-07 18:00</strong> 起至当前（与 UTC
          2026-05-07 10:00 对齐）；可切换到「从 OKX 日 K 可溯起点」。<strong>1D</strong> 为
          <strong>UTC 自然日</strong>：由对齐后的 1h 价差聚合；日 K 横轴按 UTC 日期标注。
        `.trim();
    return;
  }
  el.innerHTML = `
          口径：<strong>OKX 永续 − Gate 现货</strong>（<code>${escapeHtml(OKX_INST_ID)}</code> vs <code>${escapeHtml(
            GATE_CURRENCY_PAIR,
          )}</code>）。数据来自两家公开 REST
          K 线并按同一时间桶对齐。<strong>默认时间窗</strong>：<strong>北京时间 2026-05-07 18:00</strong> 起至当前（与 UTC
          2026-05-07 10:00 对齐）；可切换到「从 OKX 日 K 可溯起点」。<strong>1D</strong> 为
          <strong>UTC 自然日</strong>：由对齐后的 1h 价差聚合；日 K 横轴按 UTC 日期标注。
        `.trim();
}

function setVenue(next) {
  venue = next === "bitget" ? "bitget" : "gate";
  try {
    localStorage.setItem(VENUE_KEY, venue);
  } catch {
    /* ignore */
  }

  const isGate = venue === "gate";
  const spotName = isGate ? "Gate" : "Bitget";
  const spotSymbol = isGate ? "SPCX_USDT" : "PRESPAXUSDT";
  const spotLink = isGate ? "https://www.gate.com/zh/trade/SPCX_USDT" : BITGET_SPOT_PAGE_URL;

  const btnGate = $("btn-venue-gate");
  const btnBitget = $("btn-venue-bitget");
  if (btnGate) btnGate.classList.toggle("active", isGate);
  if (btnBitget) btnBitget.classList.toggle("active", !isGate);

  if ($("spot-name")) $("spot-name").textContent = spotName;
  if ($("spot-symbol")) $("spot-symbol").textContent = spotSymbol;
  if ($("spot-link")) $("spot-link").setAttribute("href", spotLink);

  if ($("spot-last-label")) $("spot-last-label").textContent = `${spotName} 现货最新价`;
  if ($("spot-diff-label")) $("spot-diff-label").textContent = spotName;
  if ($("spot-pct-label")) $("spot-pct-label").textContent = spotName;

  if ($("spot-shares-label")) $("spot-shares-label").textContent = spotName;
  if ($("spot-mcap-label")) $("spot-mcap-label").textContent = spotName;
  if ($("spot-mcap-diff-label")) $("spot-mcap-diff-label").textContent = spotName;
  if ($("spot-mcap-pct-label")) $("spot-mcap-pct-label").textContent = spotName;
  if ($("hist-spot-label")) $("hist-spot-label").textContent = spotName;

  const spreadTitle = $("spread-k-title");
  if (spreadTitle) {
    spreadTitle.textContent =
      venue === "bitget" ? "OKX×Bitget 价格价差 K 线（USDT）" : "OKX×Gate 价格价差 K 线（USDT）";
  }
  renderSpreadHint();
  renderHistHint();
}

function initVenue() {
  let v = "gate";
  try {
    v = localStorage.getItem(VENUE_KEY) || "gate";
  } catch {
    /* ignore */
  }
  setVenue(v);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderKeys() {
  const box = $("keys");
  if (!box) return;
  box.innerHTML = "";
  for (const k of barkKeysDraft) {
    const row = document.createElement("div");
    row.className = "key-row";
    row.innerHTML = `
      <label class="field">
        <span>Bark Key</span>
        <input type="text" data-k="key" data-id="${escapeHtml(k.id)}" value="${escapeHtml(
          k.value || ""
        )}" placeholder="你的 Bark Key" />
      </label>
      <div class="key-actions">
        <button type="button" class="btn btn-ghost" data-act="del-key" data-id="${escapeHtml(
          k.id
        )}">删除</button>
      </div>
    `;
    box.appendChild(row);
  }
}

function renderSavedKeys(keys) {
  const box = $("bark-keys");
  if (!box) return;
  box.innerHTML = "";
  const arr = Array.isArray(keys) ? keys : [];
  if (!arr.length) {
    box.textContent = "—";
    return;
  }
  for (const k of arr) {
    const chip = document.createElement("span");
    chip.className = "chip mono";
    chip.innerHTML = `${escapeHtml(String(k))} <button type="button" data-act="del-saved-key" data-key="${escapeHtml(
      String(k)
    )}">×</button>`;
    box.appendChild(chip);
  }
}

async function deleteSavedKey(key) {
  const res = await fetch(apiUrl("/api/config"), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const c = data?.config || {};

  const keys = Array.isArray(c.bark_keys) ? c.bark_keys : [];
  const nextKeys = keys.filter((x) => String(x) !== String(key));

  const payload = {
    bark_enabled: !!c.bark_enabled && nextKeys.length > 0,
    bark_base_url: c.bark_base_url || "https://api.day.app",
    bark_title: c.bark_title || "SPACEX/SPCX 价差提醒",
    bark_threshold_pct: Number(c.bark_threshold_pct ?? 1.0),
    bark_cooldown_seconds: Number(c.bark_cooldown_seconds ?? 60),
    bark_keys: nextKeys,
  };

  const r2 = await fetch(apiUrl("/api/config"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
  await r2.json();
  await loadConfig();
  setOk(`已删除 Key：${String(key)}`);
}

function syncKeysFromDom() {
  const box = $("keys");
  if (!box) return;
  for (const el of box.querySelectorAll("input[data-id][data-k]")) {
    const id = el.getAttribute("data-id");
    const k = el.getAttribute("data-k");
    const item = barkKeysDraft.find((x) => x.id === id);
    if (!item) continue;
    if (k === "key") item.value = normalizeBarkKeyInput(el.value);
  }
}

function normalizeBarkKeyInput(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  // Allow pasting full Bark URL like: https://api.day.app/<key>/
  try {
    if (s.startsWith("http://") || s.startsWith("https://")) {
      const u = new URL(s);
      const seg = (u.pathname || "/")
        .split("/")
        .map((x) => x.trim())
        .filter(Boolean)[0];
      if (seg) return seg;
    }
  } catch {
    /* ignore */
  }
  return s.replaceAll("/", "");
}

function setOk(msg) {
  const banner = $("ok-banner");
  if (!banner) return;
  if (!msg) {
    banner.textContent = "";
    banner.classList.remove("visible");
    return;
  }
  banner.textContent = msg;
  banner.classList.add("visible");
  setTimeout(() => setOk(""), 1800);
}

function setError(msg) {
  const banner = $("err-banner");
  if (!msg) {
    banner.textContent = "";
    banner.classList.remove("visible");
    return;
  }
  banner.textContent = msg;
  banner.classList.add("visible");
}

function pickInterval(ms, btn) {
  intervalMs = ms;
  document.querySelectorAll('.segmented button[data-interval]').forEach((b) => {
    b.classList.toggle("active", b === btn);
  });
  restart();
}

function restart() {
  if (timer) clearInterval(timer);
  if (paused) return;
  timer = setInterval(refresh, intervalMs);
}

function thresholdPct() {
  const v = Number($("threshold").value);
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

function renderHit(spreadPct) {
  const t = thresholdPct();
  const el = $("hit");
  el.classList.remove("hit-up", "hit-down");
  if (spreadPct == null || Number.isNaN(spreadPct)) {
    el.textContent = "—";
    return;
  }
  if (Math.abs(spreadPct) >= t) {
    el.textContent = `命中（|${fmtPct(spreadPct)}| ≥ ${t.toFixed(2)}%）`;
    el.classList.add(spreadPct >= 0 ? "hit-up" : "hit-down");
  } else {
    el.textContent = `未命中（|${fmtPct(spreadPct)}| < ${t.toFixed(2)}%）`;
  }
}

function showModal(show) {
  const m = $("settings-modal");
  m.classList.toggle("show", show);
  m.setAttribute("aria-hidden", show ? "false" : "true");
}

async function loadConfig() {
  const res = await fetch(apiUrl("/api/config"), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const c = data?.config || {};

  $("bark-enabled").checked = !!c.bark_enabled;
  $("bark-base-url").value = c.bark_base_url || "https://api.day.app";
  $("bark-title-input").value = c.bark_title || "SPACEX/SPCX 价差提醒";
  $("bark-threshold-pct").value =
    c.bark_threshold_pct != null ? String(c.bark_threshold_pct) : "1.0";
  const inline = $("bark-threshold-inline");
  if (inline) inline.value = c.bark_threshold_pct != null ? String(c.bark_threshold_pct) : "1.0";
  $("bark-cooldown-seconds").value =
    c.bark_cooldown_seconds != null ? String(c.bark_cooldown_seconds) : "60";

  const savedKeys = Array.isArray(c.bark_keys) ? c.bark_keys : [];
  barkKeysDraft = (savedKeys.length ? savedKeys : [""]).map((v, i) => ({
    id: `key-${Date.now()}-${i}`,
    value: String(v || ""),
  }));
  renderKeys();
  renderSavedKeys(savedKeys);

  const status = c.bark_enabled
    ? `已启用（已保存 ${savedKeys.length} 个 Key）`
    : savedKeys.length > 0
      ? `已保存 ${savedKeys.length} 个 Key（未启用）`
      : "未配置";
  $("bark-status").textContent = status;
  $("bark-threshold").textContent =
    c.bark_threshold_pct != null ? `${Number(c.bark_threshold_pct).toFixed(2)}%` : "—";
  $("bark-cooldown").textContent =
    c.bark_cooldown_seconds != null ? `${Number(c.bark_cooldown_seconds)}s` : "—";
}

async function saveThresholdInline() {
  const inline = $("bark-threshold-inline");
  if (!inline) return;
  const v = Number(inline.value);
  if (!Number.isFinite(v) || v < 0) throw new Error("阈值必须是 >= 0 的数字");

  const res = await fetch(apiUrl("/api/config"), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const c = data?.config || {};

  const payload = {
    bark_enabled: !!c.bark_enabled,
    bark_base_url: c.bark_base_url || "https://api.day.app",
    bark_title: c.bark_title || "SPACEX/SPCX 价差提醒",
    bark_threshold_pct: v,
    bark_cooldown_seconds: Number(c.bark_cooldown_seconds ?? 60),
    bark_keys: Array.isArray(c.bark_keys) ? c.bark_keys : [],
  };

  const r2 = await fetch(apiUrl("/api/config"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
  await r2.json();
  await loadConfig();
  setError("");
  setOk("阈值已保存");
}

async function saveConfig() {
  syncKeysFromDom();
  barkKeysDraft = barkKeysDraft.map((x) => ({ ...x, value: normalizeBarkKeyInput(x.value) }));
  renderKeys();
  const payload = {
    bark_enabled: $("bark-enabled").checked,
    bark_base_url: $("bark-base-url").value.trim(),
    bark_title: $("bark-title-input").value.trim(),
    bark_threshold_pct: Number($("bark-threshold-pct").value),
    bark_cooldown_seconds: Number($("bark-cooldown-seconds").value),
    bark_keys: barkKeysDraft.map((x) => String(x.value || "").trim()).filter(Boolean),
  };

  const res = await fetch(apiUrl("/api/config"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.json();
  await loadConfig();
  showModal(false);
  setError("");
  setOk("保存成功");
}

async function testBark() {
  syncKeysFromDom();
  const firstKey = (barkKeysDraft.map((x) => String(x.value || "").trim()).find(Boolean) || "").trim();
  if (!firstKey) throw new Error("请先在 Bark Keys 里填入至少 1 个 Key，再发送测试");
  const payload = {
    bark_base_url: $("bark-base-url").value.trim(),
    bark_title: $("bark-title-input").value.trim(),
    bark_key: firstKey,
  };
  const res = await fetch(apiUrl("/api/bark/test"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const out = await res.json();
  if (!out?.ok) throw new Error(out?.error || "test_failed");
  lastBarkStatusText = "测试已发送（请看手机 Bark）";
  $("bark-last").textContent = lastBarkStatusText;
}

async function fetchBitgetLastFromBrowser() {
  // Prefer official public API host. If one endpoint is rate-limited/blocked, fall back.
  const urls = [
    "https://api.bitget.com/api/v2/spot/market/tickers?symbol=PRESPAXUSDT",
    "https://api.bitget.com/api/v2/spot/market/fills?symbol=PRESPAXUSDT&limit=1",
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store", mode: "cors" });
      if (!res.ok) throw new Error(`bitget_browser_http_${res.status}`);
      const payload = await res.json();
      if (url.includes("/tickers")) {
        const row = Array.isArray(payload?.data) ? payload.data[0] : null;
        const v = Number(row?.lastPr);
        if (!Number.isFinite(v)) throw new Error("bitget_browser_price_missing");
        return v;
      } else {
        const row = Array.isArray(payload?.data) ? payload.data[0] : null;
        const v = Number(row?.price);
        if (!Number.isFinite(v)) throw new Error("bitget_browser_fills_price_missing");
        return v;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("bitget_browser_fetch_failed");
}

function applyBitgetClientFallback(q) {
  const okxLast = Number(q?.okx?.last);
  if (!Number.isFinite(okxLast)) return q;
  const spotLast = Number(q?.spot?.last);
  if (Number.isFinite(spotLast)) return q;

  return fetchBitgetLastFromBrowser().then((browserSpotLast) => {
    const spread = okxLast - browserSpotLast;
    const spreadPct = browserSpotLast !== 0 ? (spread / browserSpotLast) * 100 : null;
    const okxShares = Number(q?.market_cap?.okx_shares_outstanding || 0);
    const spotShares = Number(q?.market_cap?.spot_shares_outstanding || 0);
    const okxMcap = okxShares ? okxLast * okxShares : null;
    const spotMcap = spotShares ? browserSpotLast * spotShares : null;
    const mcapDiff = okxMcap != null && spotMcap != null ? okxMcap - spotMcap : null;
    const mcapDiffPct =
      mcapDiff != null && spotMcap != null && spotMcap !== 0 ? (mcapDiff / spotMcap) * 100 : null;

    return {
      ...q,
      spot: {
        ...(q?.spot || {}),
        last: browserSpotLast,
        meta: {
          ...(q?.spot?.meta || {}),
          source: "bitget_browser_fallback",
          error: null,
        },
      },
      spread: {
        ...(q?.spread || {}),
        abs: spread,
        pct_vs_spot: spreadPct,
      },
      market_cap: {
        ...(q?.market_cap || {}),
        okx_implied_usd: okxMcap,
        spot_implied_usd: spotMcap,
        diff_usd: mcapDiff,
        diff_pct_vs_spot: mcapDiffPct,
      },
    };
  });
}

async function refresh() {
  try {
    const res = await fetch(apiUrl(`/api/quote?venue=${encodeURIComponent(venue)}`), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let q = await res.json();

    if (venue === "bitget") {
      try {
        q = await applyBitgetClientFallback(q);
      } catch (fallbackErr) {
        // If browser fallback fails too, surface the real reason to user.
        setError(`Bitget 浏览器直连兜底失败：${String(fallbackErr?.message || fallbackErr)}`);
      }
    }

    setError("");
    $("okx-last").textContent = fmtNum(q?.okx?.last, 2);
    $("spot-last").textContent = fmtNum(q?.spot?.last, 2);
    $("spread-abs").textContent = fmtNum(q?.spread?.abs, 2);
    $("spread-pct").textContent = fmtPct(q?.spread?.pct_vs_spot);
    $("latency").textContent = q?.latency_ms != null ? `${q.latency_ms} ms` : "—";

    const ts = q?.at_ms;
    $("updated-at").textContent = ts ? new Date(ts).toLocaleString() : "—";

    renderHit(q?.spread?.pct_vs_spot);

    const m = q?.market_cap;
    const okxLastN = Number(q?.okx?.last);
    const spotLastN = Number(q?.spot?.last);

    $("okx-shares-out").textContent = fmtSharesB(OKX_SHARES_FIXED_INT);

    const fEl = $("spot-shares-formula");
    if (venue === "gate") {
      $("spot-shares-out").textContent = GATE_SHARES_INT_ROUNDED.toLocaleString("zh-CN");
      $("spot-shares-out").title = String(GATE_SHARES_INT_ROUNDED);
      if (fEl) {
        fEl.textContent = `＝ ${GATE_SHARES_NUMERATOR.toLocaleString("zh-CN")} ÷ ${GATE_SHARES_DENOMINATOR} 股`;
      }
      let okxMcapAdj = m?.okx_implied_usd;
      let spotMcapAdj = m?.spot_implied_usd;
      let diffAdj = m?.diff_usd;
      let diffPctAdj = m?.diff_pct_vs_spot;
      if (Number.isFinite(okxLastN) && Number.isFinite(spotLastN)) {
        okxMcapAdj = okxLastN * OKX_SHARES_FIXED_INT;
        spotMcapAdj = spotLastN * GATE_SHARES_FLOAT;
        diffAdj = okxMcapAdj - spotMcapAdj;
        diffPctAdj = spotMcapAdj !== 0 ? ((diffAdj / spotMcapAdj) * 100) : null;
      }
      $("okx-mcap").textContent = fmtUsdCompact(okxMcapAdj);
      $("spot-mcap").textContent = fmtUsdCompact(spotMcapAdj);
      $("mcap-diff").textContent = fmtUsdCompact(diffAdj);
      $("mcap-diff-pct").textContent = fmtPct(diffPctAdj);
    } else {
      $("spot-shares-out").textContent = fmtSharesB(m?.spot_shares_outstanding);
      $("spot-shares-out").title =
        m?.spot_shares_outstanding != null && Number.isFinite(Number(m.spot_shares_outstanding))
          ? String(Number(m.spot_shares_outstanding))
          : "";
      if (fEl) fEl.textContent = "";
      $("okx-mcap").textContent = fmtUsdCompact(m?.okx_implied_usd);
      $("spot-mcap").textContent = fmtUsdCompact(m?.spot_implied_usd);
      $("mcap-diff").textContent = fmtUsdCompact(m?.diff_usd);
      $("mcap-diff-pct").textContent = fmtPct(m?.diff_pct_vs_spot);
    }

    const bark = q?.bark;
    if (bark?.sent) {
      const t = q?.at_ms;
      const n = bark?.sent_count != null ? `（${bark.sent_count} 个 Key）` : "";
      $("bark-last").textContent = t ? `已推送${n}（${new Date(t).toLocaleString()}）` : `已推送${n}`;
    } else {
      $("bark-last").textContent = lastBarkStatusText;
    }
  } catch (e) {
    setError(`拉取报价失败：${String(e?.message || e)}`);
  }
}

function togglePause() {
  paused = !paused;
  $("btn-pause").textContent = paused ? "继续" : "暂停";
  restart();
}

function main() {
  initVenue();
  initTheme();
  const btnWinDef = $("btn-spread-win-default");
  const btnWinList = $("btn-spread-win-listing");
  const syncSpreadWinButtons = () => {
    let mode = "default";
    try {
      mode = localStorage.getItem(SPREAD_FROM_KEY) || "default";
    } catch {
      /* ignore */
    }
    setSpreadWindowMode(mode, btnWinDef, btnWinList);
  };
  syncSpreadWinButtons();
  if (btnWinDef) {
    btnWinDef.addEventListener("click", async () => {
      setSpreadWindowMode("default", btnWinDef, btnWinList);
      try {
        await loadSpreadCandles({ bust: true });
        setOk("时间窗：5/7 18:00 北京起");
      } catch (e) {
        setError(`加载价差 K 线失败：${String(e?.message || e)}`);
      }
    });
  }
  if (btnWinList) {
    btnWinList.addEventListener("click", async () => {
      setSpreadWindowMode("listing", btnWinDef, btnWinList);
      try {
        await loadSpreadCandles({ bust: true });
        setOk("时间窗：OKX 日 K 可溯起点");
      } catch (e) {
        setError(`加载价差 K 线失败：${String(e?.message || e)}`);
      }
    });
  }
  document.querySelectorAll('.segmented button[data-interval]').forEach((btn) => {
    btn.addEventListener("click", () => pickInterval(Number(btn.dataset.interval), btn));
  });
  const btnGate = $("btn-venue-gate");
  const btnBitget = $("btn-venue-bitget");
  if (btnGate) {
    btnGate.addEventListener("click", async () => {
      setVenue("gate");
      await refresh();
      await loadHistory();
      try {
        await loadSpreadCandles();
      } catch (e) {
        setError(`加载价差 K 线失败：${String(e?.message || e)}`);
      }
      setOk("已切换：OKX×Gate");
    });
  }
  if (btnBitget) {
    btnBitget.addEventListener("click", async () => {
      setVenue("bitget");
      await refresh();
      await loadHistory();
      try {
        await loadSpreadCandles();
      } catch (e) {
        setError(`加载价差 K 线失败：${String(e?.message || e)}`);
      }
      setOk("已切换：OKX×Bitget");
    });
  }
  $("btn-pause").addEventListener("click", togglePause);
  $("btn-now").addEventListener("click", refresh);
  $("threshold").addEventListener("input", () => refresh());

  $("btn-settings").addEventListener("click", async () => {
    try {
      await loadConfig();
      showModal(true);
    } catch (e) {
      setError(`加载配置失败：${String(e?.message || e)}`);
    }
  });
  const btnTheme = $("btn-theme");
  if (btnTheme) btnTheme.addEventListener("click", cycleTheme);
  $("btn-close").addEventListener("click", () => showModal(false));
  $("btn-save-bark").addEventListener("click", async () => {
    try {
      await saveConfig();
    } catch (e) {
      setError(`保存失败：${String(e?.message || e)}`);
    }
  });
  $("btn-test-bark").addEventListener("click", async () => {
    try {
      await testBark();
    } catch (e) {
      setError(`测试失败：${String(e?.message || e)}`);
    }
  });
  $("btn-add-key").addEventListener("click", () => {
    barkKeysDraft.push({ id: `key-${Date.now()}`, value: "" });
    renderKeys();
  });
  $("keys").addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.getAttribute("data-act") !== "del-key") return;
    const id = t.getAttribute("data-id");
    barkKeysDraft = barkKeysDraft.filter((r) => r.id !== id);
    if (!barkKeysDraft.length) barkKeysDraft = [{ id: `key-${Date.now()}`, value: "" }];
    renderKeys();
  });
  $("settings-modal").addEventListener("click", (ev) => {
    if (ev.target === $("settings-modal")) showModal(false);
  });
  const barkKeysBox = $("bark-keys");
  if (barkKeysBox) {
    barkKeysBox.addEventListener("click", async (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.getAttribute("data-act") !== "del-saved-key") return;
      const key = t.getAttribute("data-key") || "";
      try {
        await deleteSavedKey(key);
      } catch (e) {
        setError(`删除失败：${String(e?.message || e)}`);
      }
    });
  }
  const btnSaveTh = $("btn-save-threshold");
  if (btnSaveTh) {
    btnSaveTh.addEventListener("click", async () => {
      try {
        await saveThresholdInline();
      } catch (e) {
        setError(`保存阈值失败：${String(e?.message || e)}`);
      }
    });
  }

  document.querySelectorAll('button[data-tf]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll('button[data-tf]').forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      histTf = Number(btn.getAttribute("data-tf")) || 60;
      try {
        await loadHistory();
      } catch (e) {
        setError(`加载历史K线失败：${String(e?.message || e)}`);
      }
    });
  });
  const btnHist = $("btn-hist-refresh");
  if (btnHist) {
    btnHist.addEventListener("click", async () => {
      try {
        await loadHistory({ bust: true });
        setOk("历史 K 线已刷新");
      } catch (e) {
        setError(`加载历史K线失败：${String(e?.message || e)}`);
      }
    });
  }

  document.querySelectorAll("button[data-spread-tf]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("button[data-spread-tf]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      spreadTf = String(btn.getAttribute("data-spread-tf") || "1m");
      if (spreadChart) {
        spreadChart.applyOptions({
          localization: chartLocalizationShanghai(spreadTf === "1m" || spreadTf === "5m"),
          timeScale: { timeVisible: true, secondsVisible: spreadTf === "1m" || spreadTf === "5m" },
        });
      }
      try {
        await loadSpreadCandles();
      } catch (e) {
        setError(`加载价差 K 线失败：${String(e?.message || e)}`);
      }
    });
  });
  const btnSpr = $("btn-spread-refresh");
  if (btnSpr) {
    btnSpr.addEventListener("click", async () => {
      try {
        await loadSpreadCandles({ bust: true });
        setOk("价差 K 线已刷新");
      } catch (e) {
        setError(`加载价差 K 线失败：${String(e?.message || e)}`);
      }
    });
  }

  loadConfig().catch(() => {});
  refresh();
  restart();
  loadHistory().catch(() => {});
  loadSpreadCandles().catch((e) => setError(`加载价差 K 线失败：${String(e?.message || e)}`));
}

main();

