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
  return `${v.toFixed(3)}B`;
};

const $ = (id) => document.getElementById(id);

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
    timeScale: { timeVisible: true, secondsVisible: false },
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

async function loadHistory() {
  if (!ensureHistChart()) return;
  const res = await fetch(`/api/candles?tf=${histTf}&venue=${encodeURIComponent(venue)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const candles = (data?.candles || []).map((c) => ({
    time: c.t,
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
  }));
  histSeries.setData(candles);
  if (candles.length) histChart.timeScale().fitContent();

  const r = data?.range || {};
  const pts = data?.points ?? 0;
  const tf = data?.tf ?? histTf;
  $("hist-range").textContent =
    r.min == null || r.max == null
      ? `暂无数据（已记录 ${pts} 个点）`
      : `周期 ${tf}s · 区间 ${r.min.toFixed(2)}% ~ ${r.max.toFixed(2)}% · 点数 ${pts}`;
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
  const spotLink = isGate ? "https://www.gate.com/zh/trade/SPCX_USDT" : "https://www.bitget.com/zh-CN/spot/PRESPAXUSDT";

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
  const res = await fetch("/api/config", { cache: "no-store" });
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

  const r2 = await fetch("/api/config", {
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
  const res = await fetch("/api/config", { cache: "no-store" });
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

  const res = await fetch("/api/config", { cache: "no-store" });
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

  const r2 = await fetch("/api/config", {
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

  const res = await fetch("/api/config", {
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
  const res = await fetch("/api/bark/test", {
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
    const res = await fetch(`/api/quote?venue=${encodeURIComponent(venue)}`, { cache: "no-store" });
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

    // If upstream spot venue fails, surface meta error for debugging.
    const spotLast = q?.spot?.last;
    const spotErr = q?.spot?.meta?.error;
    if ((spotLast == null || Number.isNaN(Number(spotLast))) && spotErr) {
      setError(`Spot 数据源异常（${String(venue)}）：${String(spotErr)}`);
    } else {
      setError("");
    }
    $("okx-last").textContent = fmtNum(q?.okx?.last, 2);
    $("spot-last").textContent = fmtNum(q?.spot?.last, 2);
    $("spread-abs").textContent = fmtNum(q?.spread?.abs, 2);
    $("spread-pct").textContent = fmtPct(q?.spread?.pct_vs_spot);
    $("latency").textContent = q?.latency_ms != null ? `${q.latency_ms} ms` : "—";

    const ts = q?.at_ms;
    $("updated-at").textContent = ts ? new Date(ts).toLocaleString() : "—";

    renderHit(q?.spread?.pct_vs_spot);

    const m = q?.market_cap;
    $("okx-shares-out").textContent = fmtSharesB(m?.okx_shares_outstanding);
    $("spot-shares-out").textContent = fmtSharesB(m?.spot_shares_outstanding);
    $("okx-mcap").textContent = fmtUsdCompact(m?.okx_implied_usd);
    $("spot-mcap").textContent = fmtUsdCompact(m?.spot_implied_usd);
    $("mcap-diff").textContent = fmtUsdCompact(m?.diff_usd);
    $("mcap-diff-pct").textContent = fmtPct(m?.diff_pct_vs_spot);

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
      setOk("已切换：OKX×Gate");
    });
  }
  if (btnBitget) {
    btnBitget.addEventListener("click", async () => {
      setVenue("bitget");
      await refresh();
      await loadHistory();
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
        await loadHistory();
      } catch (e) {
        setError(`加载历史K线失败：${String(e?.message || e)}`);
      }
    });
  }

  loadConfig().catch(() => {});
  refresh();
  restart();
  loadHistory().catch(() => {});
}

main();

