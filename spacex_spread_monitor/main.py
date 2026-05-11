from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
import threading
from urllib.parse import urlparse

import requests
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request


ROOT = Path(__file__).resolve().parent
TEMPLATES_DIR = str(ROOT / "templates")
STATIC_DIR = str(ROOT / "static")
CONFIG_PATH = str(ROOT / "config.json")


OKX_INST_ID = "SPACEX-USDT-SWAP"
GATE_CURRENCY_PAIR = "SPCX_USDT"
BITGET_SYMBOL = "PRESPAXUSDT"

# Fixed share counts per docs (requested by Ron):
# - OKX: official doc states estimated shares is 1B for SpaceX pre-IPO perpetuals.
# - Gate: announcement derives implied market cap from ~2.37–2.38B shares; use 2.375B midpoint.
OKX_SHARES_OUTSTANDING = 1_000_000_000
GATE_SHARES_OUTSTANDING = 2_375_000_000
# Derived from Bitget IPO Prime article values (Ron requested):
# - SpaceX implied valuation: $1.5T
# - IPO Prime subscription price: 1 preSPAX = $650
# Shares = 1.5T / 650 = 2,307,692,308
BITGET_SHARES_OUTSTANDING = 2_307_692_308

# Keep quote endpoint snappy even when upstream hiccups.
UPSTREAM_TIMEOUT_SECONDS = 3.0
QUOTE_CACHE_TTL_MS = 900  # serve cached quote within ~1s

# History storage (since server start). We record the mcap diff % vs selected venue.
HISTORY_MAX_POINTS = 200_000
HISTORY_PATHS = {
    "gate": str(ROOT / "history_mcap_diff_pct_gate.ndjson"),
    "bitget": str(ROOT / "history_mcap_diff_pct_bitget.ndjson"),
}
LEGACY_HISTORY_PATH = str(ROOT / "history_mcap_diff_pct.ndjson")
HIST_APPEND_MIN_INTERVAL_MS = 1500


def _now_ms() -> int:
    return int(time.time() * 1000)


def _as_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return float(s)
        except Exception:
            return None
    return None


def _normalize_bark_key(value: Any) -> str:
    """
    Accept either a raw Bark key or a full Bark URL like:
      https://api.day.app/<key>/
    Returns normalized key string (no slashes) or "".
    """
    if not isinstance(value, str):
        return ""
    s = value.strip()
    if not s:
        return ""
    if s.startswith("http://") or s.startswith("https://"):
        try:
            u = urlparse(s)
            segs = [x for x in (u.path or "/").split("/") if x.strip()]
            if segs:
                s = segs[0].strip()
        except Exception:
            pass
    return s.replace("/", "").strip()


def _bucket_start_ms(ts_ms: int, tf_seconds: int) -> int:
    tf_ms = int(tf_seconds) * 1000
    return int(ts_ms // tf_ms) * tf_ms


@dataclass
class AppConfig:
    bark_enabled: bool = False
    bark_base_url: str = "https://api.day.app"
    bark_title: str = "SPACEX/SPCX 价差提醒"
    bark_keys: List[str] = None  # type: ignore[assignment]
    bark_threshold_pct: float = 1.0
    bark_cooldown_seconds: int = 60

    def __post_init__(self) -> None:
        if self.bark_keys is None:
            self.bark_keys = []


def _load_config() -> AppConfig:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            return AppConfig()
        clean = {}
        for k in asdict(AppConfig()).keys():
            if k in raw:
                clean[k] = raw[k]
        cfg = AppConfig(**clean)
        cfg.bark_base_url = (cfg.bark_base_url or "https://api.day.app").strip()
        cfg.bark_title = (cfg.bark_title or "SPACEX/SPCX 价差提醒").strip()

        # Normalize bark keys list.
        keys_raw = cfg.bark_keys if isinstance(cfg.bark_keys, list) else []
        keys: List[str] = []
        for k in keys_raw:
            s = _normalize_bark_key(k)
            if s:
                keys.append(s)
        # Backward compat: if previous config had single bark_key, merge it.
        if isinstance(raw.get("bark_key"), str) and raw.get("bark_key").strip():
            s = _normalize_bark_key(raw.get("bark_key"))
            if s:
                keys.append(s)
        # Dedup preserving order.
        seen = set()
        uniq: List[str] = []
        for k in keys:
            if k in seen:
                continue
            seen.add(k)
            uniq.append(k)
        cfg.bark_keys = uniq

        try:
            cfg.bark_threshold_pct = float(cfg.bark_threshold_pct)
        except Exception:
            cfg.bark_threshold_pct = 1.0
        if cfg.bark_threshold_pct < 0:
            cfg.bark_threshold_pct = 0.0

        try:
            cfg.bark_cooldown_seconds = int(cfg.bark_cooldown_seconds)
        except Exception:
            cfg.bark_cooldown_seconds = 60
        cfg.bark_cooldown_seconds = max(5, cfg.bark_cooldown_seconds)

        if cfg.bark_enabled and not cfg.bark_keys:
            cfg.bark_enabled = False
        return cfg
    except Exception:
        return AppConfig()


def _save_config(cfg: AppConfig) -> None:
    tmp = f"{CONFIG_PATH}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(asdict(cfg), f, ensure_ascii=False, indent=2)
        f.write("\n")
    Path(tmp).replace(CONFIG_PATH)


def _bark_push(
    sess: requests.Session,
    base_url: str,
    key: str,
    title: str,
    body: str,
    *,
    sound: str = "alarm",
    level: str = "critical",
    volume: int = 10,
    call: int = 1,
) -> None:
    safe_title = requests.utils.quote(title or "", safe="")
    safe_body = requests.utils.quote(body or "", safe="")
    endpoint = f"{base_url.rstrip('/')}/{key}/{safe_title}/{safe_body}"
    params = {
        "sound": sound,
        "level": level,
        "volume": str(max(0, min(10, int(volume)))),
        "call": str(int(bool(call))),
    }
    r = sess.get(endpoint, params=params, timeout=12)
    r.raise_for_status()


def _okx_last_price() -> Tuple[Optional[float], Dict[str, Any]]:
    """
    OKX public ticker endpoint.
    Docs are stable across products; this is the standard OKX v5 path.
    """
    sess = requests.Session()
    sess.trust_env = False
    url = "https://www.okx.com/api/v5/market/ticker"
    r = sess.get(url, params={"instId": OKX_INST_ID}, timeout=UPSTREAM_TIMEOUT_SECONDS)
    meta: Dict[str, Any] = {"url": url, "status": r.status_code}
    r.raise_for_status()
    payload = r.json()
    meta["raw_code"] = payload.get("code")
    meta["raw_msg"] = payload.get("msg")
    data = payload.get("data")
    if not isinstance(data, list) or not data:
        return None, {**meta, "error": "unexpected_okx_payload"}
    row = data[0] if isinstance(data[0], dict) else {}
    last = _as_float(row.get("last"))
    meta["ts"] = row.get("ts")
    return last, meta


def _gate_last_price() -> Tuple[Optional[float], Dict[str, Any]]:
    """
    Gate spot ticker endpoint.
    """
    sess = requests.Session()
    sess.trust_env = False
    url = "https://api.gateio.ws/api/v4/spot/tickers"
    r = sess.get(url, params={"currency_pair": GATE_CURRENCY_PAIR}, timeout=UPSTREAM_TIMEOUT_SECONDS)
    meta: Dict[str, Any] = {"url": url, "status": r.status_code}
    r.raise_for_status()
    payload = r.json()
    if not isinstance(payload, list) or not payload:
        return None, {**meta, "error": "unexpected_gate_payload"}
    row = payload[0] if isinstance(payload[0], dict) else {}
    last = _as_float(row.get("last"))
    return last, meta


def _bitget_last_price() -> Tuple[Optional[float], Dict[str, Any]]:
    """
    Bitget spot ticker endpoint (v2).
    """
    sess = requests.Session()
    sess.trust_env = False
    url = "https://api.bitget.com/api/v2/spot/market/tickers"
    r = sess.get(url, params={"symbol": BITGET_SYMBOL}, timeout=UPSTREAM_TIMEOUT_SECONDS)
    meta: Dict[str, Any] = {"url": url, "status": r.status_code, "symbol": BITGET_SYMBOL}
    r.raise_for_status()
    payload = r.json()
    meta["raw_code"] = payload.get("code")
    meta["raw_msg"] = payload.get("msg")
    data = payload.get("data")
    if not isinstance(data, list) or not data:
        return None, {**meta, "error": "unexpected_bitget_payload"}
    row = data[0] if isinstance(data[0], dict) else {}
    last = _as_float(row.get("lastPr"))
    meta["ts"] = row.get("ts")
    return last, meta


app = FastAPI(title="SPACEX Spread Monitor")
templates = Jinja2Templates(directory=TEMPLATES_DIR)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _background_sampler() -> None:
    """
    Keep history always growing even when nobody opens the page.
    This avoids perceived 'missing data' after refresh/switching venue.
    """
    while True:
        try:
            f_okx = _executor.submit(_okx_last_price)
            f_gate = _executor.submit(_gate_last_price)
            f_bitget = _executor.submit(_bitget_last_price)
            okx_last, _ = f_okx.result(timeout=UPSTREAM_TIMEOUT_SECONDS + 0.5)
            gate_last, _ = f_gate.result(timeout=UPSTREAM_TIMEOUT_SECONDS + 0.5)
            bitget_last, _ = f_bitget.result(timeout=UPSTREAM_TIMEOUT_SECONDS + 0.5)

            if okx_last is not None and gate_last is not None:
                okx_mcap = okx_last * OKX_SHARES_OUTSTANDING
                gate_mcap = gate_last * GATE_SHARES_OUTSTANDING
                v = (okx_mcap - gate_mcap) / gate_mcap * 100.0 if gate_mcap else None
                _maybe_append_history_point("gate", v)
            if okx_last is not None and bitget_last is not None:
                okx_mcap = okx_last * OKX_SHARES_OUTSTANDING
                bitget_mcap = bitget_last * BITGET_SHARES_OUTSTANDING
                v = (okx_mcap - bitget_mcap) / bitget_mcap * 100.0 if bitget_mcap else None
                _maybe_append_history_point("bitget", v)
        except Exception:
            pass
        time.sleep(2.0)


@app.on_event("startup")
async def _on_startup() -> None:
    t = threading.Thread(target=_background_sampler, name="history-sampler", daemon=True)
    t.start()

_last_bark_sent_at_ms: Optional[int] = None
_last_bark_sent_by_key_ms: Dict[str, int] = {}
_cache_lock = threading.Lock()
_last_quote_payload_by_venue: Dict[str, Dict[str, Any]] = {}
_last_quote_at_ms_by_venue: Dict[str, int] = {}
_executor = ThreadPoolExecutor(max_workers=4)

_hist_lock = threading.Lock()
_hist_points_by_venue: Dict[str, List[Dict[str, float]]] = {"gate": [], "bitget": []}  # {"venue": [{"t": ms, "v": pct}]}
_last_hist_append_at_ms_by_venue: Dict[str, int] = {}


def _load_history_from_disk(venue: str) -> None:
    try:
        venue_norm = "bitget" if str(venue).lower() == "bitget" else "gate"
        history_path = HISTORY_PATHS.get(venue_norm) or HISTORY_PATHS["gate"]
        pts: List[Dict[str, float]] = []

        def _read_file(path: str) -> None:
            nonlocal pts
            if not Path(path).exists():
                return
            with open(path, "r", encoding="utf-8") as f:
                for ln in f:
                    s = ln.strip()
                    if not s:
                        continue
                    try:
                        obj = json.loads(s)
                    except Exception:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    t = obj.get("t")
                    v = obj.get("v")
                    if t is None or v is None:
                        continue
                    try:
                        pts.append({"t": float(t), "v": float(v)})
                    except Exception:
                        continue

        # Primary per-venue file.
        _read_file(history_path)
        # Backward-compat migration: older deployments stored Gate history in LEGACY_HISTORY_PATH.
        if venue_norm == "gate":
            _read_file(LEGACY_HISTORY_PATH)

        # Sort and de-dup by timestamp (keep last value for same t).
        if pts:
            pts.sort(key=lambda x: x.get("t", 0.0))
            dedup: Dict[int, float] = {}
            for p in pts:
                try:
                    dedup[int(float(p["t"]))] = float(p["v"])
                except Exception:
                    continue
            pts = [{"t": float(t), "v": float(v)} for t, v in sorted(dedup.items(), key=lambda kv: kv[0])]
        if len(pts) > HISTORY_MAX_POINTS:
            pts = pts[-HISTORY_MAX_POINTS:]
        with _hist_lock:
            _hist_points_by_venue[venue_norm] = pts
    except Exception:
        return


def _append_history_point(venue: str, t_ms: int, v: float) -> None:
    try:
        venue_norm = "bitget" if str(venue).lower() == "bitget" else "gate"
        history_path = HISTORY_PATHS.get(venue_norm) or HISTORY_PATHS["gate"]
        with open(history_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": t_ms, "v": v}, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _maybe_append_history_point(venue: str, v: Optional[float], *, t_ms: Optional[int] = None) -> None:
    if v is None:
        return
    venue_norm = "bitget" if str(venue).lower() == "bitget" else "gate"
    now_ms = int(t_ms or _now_ms())
    last_ms = _last_hist_append_at_ms_by_venue.get(venue_norm)
    if last_ms is not None and (now_ms - int(last_ms)) < HIST_APPEND_MIN_INTERVAL_MS:
        return
    _last_hist_append_at_ms_by_venue[venue_norm] = now_ms
    with _hist_lock:
        arr = _hist_points_by_venue.get(venue_norm)
        if arr is None:
            arr = []
            _hist_points_by_venue[venue_norm] = arr
        arr.append({"t": float(now_ms), "v": float(v)})
        if len(arr) > HISTORY_MAX_POINTS:
            _hist_points_by_venue[venue_norm] = arr[-HISTORY_MAX_POINTS:]
    _append_history_point(venue_norm, now_ms, float(v))


_load_history_from_disk("gate")
_load_history_from_disk("bitget")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "okx_inst_id": OKX_INST_ID,
            "gate_pair": GATE_CURRENCY_PAIR,
            "bitget_symbol": BITGET_SYMBOL,
            "time": time,
        },
    )


@app.get("/api/config")
async def api_get_config() -> Dict[str, Any]:
    cfg = _load_config()
    cfg_dict = asdict(cfg)
    cfg_dict["bark_keys_set"] = len(cfg.bark_keys or [])
    # Ron requests to show keys in UI.
    cfg_dict["bark_keys"] = cfg.bark_keys or []
    return {"config": cfg_dict}


@app.get("/api/candles")
async def api_candles(tf: int = 60, venue: str = "gate") -> Dict[str, Any]:
    """
    OHLC candles for market cap diff % vs selected venue.
    tf seconds supported: 60,120,180,300,900,1800,3600,10800,21600,86400
    """
    supported = {60, 120, 180, 300, 900, 1800, 3600, 10800, 21600, 86400}
    tf_s = int(tf)
    if tf_s not in supported:
        tf_s = 60

    with _hist_lock:
        venue_norm = "bitget" if str(venue).lower() == "bitget" else "gate"
        pts = list(_hist_points_by_venue.get(venue_norm, []))

    candles: List[Dict[str, Any]] = []
    cur_bucket: Optional[int] = None
    o: Optional[float] = None
    h: Optional[float] = None
    l: Optional[float] = None
    c: Optional[float] = None

    for p in pts:
        t_ms = int(p.get("t") or 0)
        v = p.get("v")
        if v is None:
            continue
        v = float(v)
        b = _bucket_start_ms(t_ms, tf_s)
        if cur_bucket is None or b != cur_bucket:
            if cur_bucket is not None and o is not None:
                candles.append({"t": int(cur_bucket // 1000), "o": o, "h": float(h), "l": float(l), "c": float(c)})
            cur_bucket = b
            o = h = l = c = v
        else:
            h = v if h is None else max(float(h), v)
            l = v if l is None else min(float(l), v)
            c = v

    if cur_bucket is not None and o is not None:
        candles.append({"t": int(cur_bucket // 1000), "o": o, "h": float(h), "l": float(l), "c": float(c)})

    lows = [x["l"] for x in candles] if candles else []
    highs = [x["h"] for x in candles] if candles else []
    rng = {"min": min(lows) if lows else None, "max": max(highs) if highs else None}
    return {"tf": tf_s, "venue": venue_norm, "candles": candles[-5000:], "range": rng, "points": len(pts)}


@app.post("/api/config")
async def api_set_config(payload: Dict[str, Any]) -> Dict[str, Any]:
    cfg = _load_config()
    cfg.bark_enabled = bool(payload.get("bark_enabled"))
    cfg.bark_base_url = str(payload.get("bark_base_url") or cfg.bark_base_url).strip()
    cfg.bark_title = str(payload.get("bark_title") or cfg.bark_title).strip()
    if isinstance(payload.get("bark_keys"), list):
        cfg.bark_keys = [_normalize_bark_key(x) for x in payload.get("bark_keys") if _normalize_bark_key(x)]
    if payload.get("bark_threshold_pct") is not None:
        cfg.bark_threshold_pct = payload.get("bark_threshold_pct")
    if payload.get("bark_cooldown_seconds") is not None:
        cfg.bark_cooldown_seconds = payload.get("bark_cooldown_seconds")
    _save_config(cfg)
    out = asdict(_load_config())
    out["bark_keys_set"] = len((_load_config().bark_keys) or [])
    out["bark_keys"] = (_load_config().bark_keys) or []
    return {"ok": True, "config": out}


@app.post("/api/bark/test")
async def api_bark_test(payload: Dict[str, Any]) -> Dict[str, Any]:
    cfg = _load_config()
    key = str(payload.get("bark_key") or "").strip()
    base_url = str(payload.get("bark_base_url") or cfg.bark_base_url).strip() or "https://api.day.app"
    title = str(payload.get("bark_title") or cfg.bark_title).strip() or "SPACEX/SPCX 价差提醒"
    if not key:
        return {"ok": False, "error": "missing_bark_key"}
    sess = requests.Session()
    sess.trust_env = False
    try:
        _bark_push(
            sess,
            base_url,
            key,
            f"{title}（测试）",
            "如果你收到这条，说明 Bark 配置成功。",
            sound="alarm",
            level="critical",
            volume=10,
            call=1,
        )
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": repr(e)}


@app.get("/api/quote")
async def api_quote(venue: str = "gate") -> Dict[str, Any]:
    now = _now_ms()
    venue_norm = "bitget" if str(venue).lower() == "bitget" else "gate"
    with _cache_lock:
        last = _last_quote_payload_by_venue.get(venue_norm)
        last_at = _last_quote_at_ms_by_venue.get(venue_norm)
        if last is not None and last_at is not None and (now - last_at) <= QUOTE_CACHE_TTL_MS:
            # Even when serving cached quote, keep history continuous.
            try:
                v = _as_float(((last.get("market_cap") or {}).get("diff_pct_vs_spot")))
            except Exception:
                v = None
            _maybe_append_history_point(venue_norm, v, t_ms=now)
            return last

    t0 = now

    okx_last: Optional[float] = None
    spot_last: Optional[float] = None
    okx_meta: Dict[str, Any] = {"error": "not_fetched"}
    spot_meta: Dict[str, Any] = {"error": "not_fetched"}

    # Fetch in parallel; tolerate upstream errors and keep endpoint responsive.
    f_okx = _executor.submit(_okx_last_price)
    f_spot = _executor.submit(_bitget_last_price if venue_norm == "bitget" else _gate_last_price)
    try:
        okx_last, okx_meta = f_okx.result(timeout=UPSTREAM_TIMEOUT_SECONDS + 0.5)
    except FuturesTimeoutError:
        okx_meta = {"error": "timeout", "url": "https://www.okx.com/api/v5/market/ticker"}
    except Exception as e:
        okx_meta = {"error": f"{type(e).__name__}", "detail": repr(e), "url": "https://www.okx.com/api/v5/market/ticker"}

    try:
        spot_last, spot_meta = f_spot.result(timeout=UPSTREAM_TIMEOUT_SECONDS + 0.5)
    except FuturesTimeoutError:
        spot_meta = {"error": "timeout"}
    except Exception as e:
        spot_meta = {"error": f"{type(e).__name__}", "detail": repr(e)}

    spread = None
    spread_pct = None
    mid = None
    if okx_last is not None and spot_last is not None:
        spread = okx_last - spot_last
        mid = (okx_last + spot_last) / 2.0
        if spot_last != 0:
            spread_pct = (spread / spot_last) * 100.0

    cfg = _load_config()
    okx_shares = OKX_SHARES_OUTSTANDING
    spot_shares = BITGET_SHARES_OUTSTANDING if venue_norm == "bitget" else GATE_SHARES_OUTSTANDING
    okx_mcap = (okx_last * okx_shares) if (okx_last is not None and okx_shares) else None
    spot_mcap = (spot_last * spot_shares) if (spot_last is not None and spot_shares) else None
    mcap_diff = (okx_mcap - spot_mcap) if (okx_mcap is not None and spot_mcap is not None) else None
    mcap_diff_pct = (mcap_diff / spot_mcap * 100.0) if (mcap_diff is not None and spot_mcap not in (None, 0)) else None

    # Record history point (best-effort).
    _maybe_append_history_point(venue_norm, mcap_diff_pct)

    bark = {
        "enabled": cfg.bark_enabled,
        "threshold_pct": cfg.bark_threshold_pct,
        "cooldown_seconds": cfg.bark_cooldown_seconds,
        "signal": f"mcap_diff_pct_vs_{venue_norm}",
        "signal_value_pct": mcap_diff_pct,
        "sent": False,
        "sent_count": 0,
        "reason": None,
    }
    # Bark threshold is based on market cap diff % vs selected venue (NOT price spread).
    if cfg.bark_enabled and mcap_diff_pct is not None:
        hit = abs(float(mcap_diff_pct)) >= float(cfg.bark_threshold_pct)
        if not hit:
            bark["reason"] = "no_hit"
        else:
            now_ms = _now_ms()
            sent = 0
            for key in (cfg.bark_keys or []):
                last = _last_bark_sent_by_key_ms.get(key)
                ok_to_send = (last is None) or (now_ms - last >= int(cfg.bark_cooldown_seconds) * 1000)
                if not ok_to_send:
                    continue
                try:
                    body = (
                        f"OKX({OKX_INST_ID})={okx_last}  {venue_norm.upper()}({BITGET_SYMBOL if venue_norm=='bitget' else GATE_CURRENCY_PAIR})={spot_last}\n"
                        f"市值差值%（OKX-{venue_norm.upper()}，相对{venue_norm.upper()}）={mcap_diff_pct:.2f}%\n"
                        f"OKX隐含市值={okx_mcap:.2f}  {venue_norm.upper()}隐含市值={spot_mcap:.2f}"
                    )
                    bark_sess = requests.Session()
                    bark_sess.trust_env = False
                    _bark_push(
                        bark_sess,
                        cfg.bark_base_url,
                        key,
                        cfg.bark_title,
                        body,
                        sound="alarm",
                        level="critical",
                        volume=10,
                        call=1,
                    )
                    _last_bark_sent_by_key_ms[key] = now_ms
                    sent += 1
                except Exception:
                    pass
            bark["sent"] = sent > 0
            bark["sent_count"] = sent
            bark["reason"] = "hit_threshold" if sent > 0 else "cooldown"
    elif cfg.bark_enabled:
        bark["reason"] = "no_signal"

    payload = {
        "venue": venue_norm,
        "at_ms": _now_ms(),
        "latency_ms": _now_ms() - t0,
        "okx": {"instId": OKX_INST_ID, "last": okx_last, "meta": okx_meta},
        "spot": {"venue": venue_norm, "symbol": BITGET_SYMBOL if venue_norm == "bitget" else GATE_CURRENCY_PAIR, "last": spot_last, "meta": spot_meta},
        "spread": {"abs": spread, "pct_vs_spot": spread_pct, "mid": mid},
        "market_cap": {
            "okx_shares_outstanding": okx_shares,
            "spot_shares_outstanding": spot_shares,
            "okx_implied_usd": okx_mcap,
            "spot_implied_usd": spot_mcap,
            "diff_usd": mcap_diff,
            "diff_pct_vs_spot": mcap_diff_pct,
            "notes": "固定口径：OKX=10亿股；Spot=2.375B 股。OKX Pre-IPO 合约为每股价口径；Spot 用固定股本推导隐含市值。",
        },
        "bark": bark,
    }

    with _cache_lock:
        _last_quote_payload_by_venue[venue_norm] = payload
        _last_quote_at_ms_by_venue[venue_norm] = int(payload.get("at_ms") or _now_ms())
    return payload

