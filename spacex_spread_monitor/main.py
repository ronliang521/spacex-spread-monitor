from __future__ import annotations

import asyncio
import json
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
import threading
from urllib.parse import urlparse

import requests
from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request
from starlette.middleware.cors import CORSMiddleware


ROOT = Path(__file__).resolve().parent
TEMPLATES_DIR = str(ROOT / "templates")
STATIC_DIR = str(ROOT / "static")
CONFIG_PATH = str(ROOT / "config.json")


OKX_INST_ID = "SPACEX-USDT-SWAP"
GATE_CURRENCY_PAIR = "SPCX_USDT"
BITGET_SYMBOL = "PRESPAXUSDT"
# 与网页端同一行情源：公开 REST（非抓取 HTML）
OKX_SPACEX_TRADE_URL = "https://www.okx.com/zh-hans/trade-swap/spacex-usdt-swap"
GATE_SPCX_TRADE_URL = "https://www.gate.com/zh/trade/SPCX_USDT"
OKX_REST_MARKET_CANDLES = "https://www.okx.com/api/v5/market/candles"
GATE_REST_SPOT_CANDLES = "https://api.gateio.ws/api/v4/spot/candlesticks"
BITGET_REST_HISTORY_CANDLES = "https://api.bitget.com/api/v2/spot/market/history-candles"
BITGET_SPCX_TRADE_URL = "https://www.bitget.com/zh-CN/spot/PRESPAXUSDT"

# Fixed share counts per docs (requested by Ron):
# - OKX: official doc states estimated shares is 1B for SpaceX pre-IPO perpetuals.
# - Gate: Ron 口径 — 总股本 = 1.4 万亿 / 590（隐含市值/每股推导）。
OKX_SHARES_OUTSTANDING = 1_000_000_000
GATE_SHARES_NUMERATOR = 1_400_000_000_000
GATE_SHARES_DENOMINATOR = 590
GATE_SHARES_OUTSTANDING = float(GATE_SHARES_NUMERATOR) / float(GATE_SHARES_DENOMINATOR)
# Bump when股本口径变更：使进程内 /api/quote 旧缓存立即失效（否则会短暂返回旧 spot_shares_outstanding）。
QUOTE_SHARES_REVISION = 2
# /api/candles（Gate）返回体可读字段：与页面「历史价差 K 线」口径一致
DIFF_PCT_VS_GATE_FORMULA = (
    "[(OKX股数×OKX合约价) − (Gate股数×Gate现货价)] / (Gate股数×Gate现货价) × 100%"
)
DIFF_PCT_VS_BITGET_FORMULA = (
    "[(OKX股数×OKX合约价) − (Bitget股数×Bitget现货价)] / (Bitget股数×Bitget现货价) × 100%"
)
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
# /api/candles 与 /api/price-spread-candles 共用：旧值 5000/20000 会裁掉长窗；100k 根 1m≈69 天。
MAX_HIST_CANDLES_RESPONSE = 100_000


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


# --- OKX vs Gate: historical price spread candles (public REST) ---
_OKX_EARLIEST_SEC: Optional[int] = None
_SPREAD_CACHE_LOCK = threading.Lock()
_SPREAD_CACHE: Dict[str, Tuple[int, Dict[str, Any]]] = {}
# Gate 市值差% K 线：REST 聚合结果短缓存（秒级轮询时减压）
_GATE_HIST_REST_CACHE_LOCK = threading.Lock()
_GATE_HIST_REST_CACHE: Dict[int, Tuple[int, Dict[str, Any]]] = {}
_GATE_HIST_REST_TTL_MS = 45_000
_BITGET_HIST_REST_CACHE_LOCK = threading.Lock()
_BITGET_HIST_REST_CACHE: Dict[int, Tuple[int, Dict[str, Any]]] = {}
_BITGET_HIST_REST_TTL_MS = 45_000
# 对齐 1m 主表：OKX/Gate 各拉一次，供「USDT 价差 K」与「市值差%」共用（短缓存避免双图重复打满）
_ALIGNED_1M_FRAME_LOCK = threading.Lock()
_ALIGNED_1M_FRAME: Dict[str, Any] = {"at_ms": 0, "fetch_start": -1, "end_sec": -1, "rows": []}
_ALIGNED_1M_FRAME_TTL_MS = 30_000
# OKX 永续 + Bitget 现货 1m 对齐（市值差% 相对 Bitget REST K 线）
_ALIGNED_1M_BITGET_FRAME_LOCK = threading.Lock()
_ALIGNED_1M_BITGET_FRAME: Dict[str, Any] = {"at_ms": 0, "fetch_start": -1, "end_sec": -1, "rows": []}
# 默认：北京时间 2026-05-07 18:00:00（= UTC 2026-05-07 10:00:00）起的价差窗口
_SPREAD_DEFAULT_FROM_TS_SEC = int(
    datetime(2026, 5, 7, 18, 0, 0, tzinfo=timezone(timedelta(hours=8))).timestamp()
)
_CN8 = timezone(timedelta(hours=8))


def _aligned_rest_fetch_start_sec(discover_sec: int) -> int:
    """
    OKX 日 K discovery 得到的「最早 bar」有时晚于 PRESPAX / SPACEX 真实可对齐时间；
    与默认窗（北京 2026-05-07 18:00，=_SPREAD_DEFAULT_FROM_TS_SEC）取 min 作为 REST 拉取起点，
    避免仅从偏晚的 discover 起分页导致缺席默认窗内早期 1m（首根 K 异常偏晚）。
    """
    return min(int(discover_sec), int(_SPREAD_DEFAULT_FROM_TS_SEC))


def _aligned_1m_frame_cache_invalidate() -> None:
    with _ALIGNED_1M_FRAME_LOCK:
        _ALIGNED_1M_FRAME["at_ms"] = 0
        _ALIGNED_1M_FRAME["fetch_start"] = -1
        _ALIGNED_1M_FRAME["end_sec"] = -1
        _ALIGNED_1M_FRAME["rows"] = []


def _spread_cache_ttl_ms(tf: str) -> int:
    return {"1m": 45_000, "5m": 120_000, "1h": 300_000, "4h": 600_000, "1d": 900_000}.get(tf, 60_000)


def _parse_okx_candle_row(row: Any) -> Optional[Tuple[int, float, float, float, float]]:
    if not isinstance(row, (list, tuple)) or len(row) < 5:
        return None
    try:
        ts_ms = int(row[0])
        o, h, l, c = float(row[1]), float(row[2]), float(row[3]), float(row[4])
        return ts_ms, o, h, l, c
    except Exception:
        return None


def _parse_gate_candle_row(row: Any) -> Optional[Tuple[int, float, float, float, float]]:
    """
    Gate spot candlestick: [t, volume, close, high, low, open, ...]
    """
    if not isinstance(row, (list, tuple)) or len(row) < 6:
        return None
    try:
        ts_sec = int(row[0])
        c, h, l, o = float(row[2]), float(row[3]), float(row[4]), float(row[5])
        return ts_sec, o, h, l, c
    except Exception:
        return None


def _spread_ohlc(
    okx: Tuple[float, float, float, float], gate: Tuple[float, float, float, float]
) -> Tuple[float, float, float, float]:
    oko, okh, okl, okc = okx
    go, gh, gl, gc = gate
    o = oko - go
    c = okc - gc
    h0 = okh - gl
    l0 = okl - gh
    h = max(h0, o, c)
    l = min(l0, o, c)
    if l > h:
        l, h = min(o, c), max(o, c)
    return (o, h, l, c)


def _discover_okx_earliest_sec(sess: requests.Session) -> Optional[int]:
    global _OKX_EARLIEST_SEC
    if _OKX_EARLIEST_SEC is not None:
        return _OKX_EARLIEST_SEC
    min_ms: Optional[int] = None
    after_ms: Optional[int] = None
    url = "https://www.okx.com/api/v5/market/history-candles"
    for _ in range(400):
        p: Dict[str, str] = {"instId": OKX_INST_ID, "bar": "1D", "limit": "100"}
        if after_ms is not None:
            p["after"] = str(int(after_ms))
        r = sess.get(url, params=p, timeout=30)
        r.raise_for_status()
        payload = r.json() or {}
        data = payload.get("data") or []
        if not isinstance(data, list) or not data:
            break
        for row in data:
            parsed = _parse_okx_candle_row(row)
            if not parsed:
                continue
            ms = parsed[0]
            min_ms = ms if min_ms is None else min(min_ms, ms)
        try:
            oldest_ms = int(data[-1][0])
        except Exception:
            break
        if after_ms is not None and int(after_ms) == oldest_ms:
            break
        after_ms = oldest_ms
        if len(data) < 100:
            break
    if min_ms is None:
        r2 = sess.get(
            "https://www.okx.com/api/v5/market/candles",
            params={"instId": OKX_INST_ID, "bar": "1D", "limit": "100"},
            timeout=30,
        )
        r2.raise_for_status()
        data2 = (r2.json() or {}).get("data") or []
        if isinstance(data2, list):
            for row in data2:
                parsed = _parse_okx_candle_row(row)
                if parsed:
                    ms = parsed[0]
                    min_ms = ms if min_ms is None else min(min_ms, ms)
    if min_ms is None:
        return None
    _OKX_EARLIEST_SEC = int(min_ms // 1000)
    return _OKX_EARLIEST_SEC


def _okx_fetch_candles_map(sess: requests.Session, bar: str, start_sec: int, end_sec: int) -> Dict[int, Tuple[float, float, float, float]]:
    out: Dict[int, Tuple[float, float, float, float]] = {}
    url_recent = "https://www.okx.com/api/v5/market/candles"
    r0 = sess.get(url_recent, params={"instId": OKX_INST_ID, "bar": bar, "limit": "300"}, timeout=30)
    r0.raise_for_status()
    for row in (r0.json() or {}).get("data") or []:
        p = _parse_okx_candle_row(row)
        if not p:
            continue
        ts_ms, o, h, l, c = p
        ts_sec = int(ts_ms // 1000)
        if ts_sec < start_sec or ts_sec > end_sec:
            continue
        out[ts_sec] = (o, h, l, c)

    # OKX docs: `after` returns candles *earlier* than ts; `before` returns *newer* than ts.
    url_hist = "https://www.okx.com/api/v5/market/history-candles"
    if out:
        after_ms = int(min(out.keys()) * 1000)
    else:
        after_ms = int(end_sec) * 1000

    for _ in range(3000):
        params: Dict[str, str] = {"instId": OKX_INST_ID, "bar": bar, "limit": "300", "after": str(int(after_ms))}
        rh = sess.get(url_hist, params=params, timeout=30)
        rh.raise_for_status()
        rows = (rh.json() or {}).get("data") or []
        if not isinstance(rows, list) or not rows:
            break
        try:
            oldest_ms = int(rows[-1][0])
        except Exception:
            break

        stop_paging = False
        for row in rows:
            p = _parse_okx_candle_row(row)
            if not p:
                continue
            ts_ms, o, h, l, c = p
            ts_sec = int(ts_ms // 1000)
            if ts_sec > end_sec:
                continue
            if ts_sec < start_sec:
                stop_paging = True
                continue
            out[ts_sec] = (o, h, l, c)

        after_ms = oldest_ms
        if oldest_ms // 1000 < start_sec:
            stop_paging = True
        if len(rows) < 300 or stop_paging:
            break

    return out


def _gate_bar_seconds(gate_interval: str) -> int:
    gi = str(gate_interval)
    return {"1m": 60, "5m": 300, "1h": 3600, "4h": 14_400}.get(gi, 3600)


def _gate_chunk_span_sec(gate_interval: str) -> int:
    """Gate allows up to 1000 candles per request; chunk the time range accordingly."""
    return 1000 * _gate_bar_seconds(gate_interval)


def _gate_fetch_candles_map(sess: requests.Session, gate_interval: str, start_sec: int, end_sec: int) -> Dict[int, Tuple[float, float, float, float]]:
    out: Dict[int, Tuple[float, float, float, float]] = {}
    url = "https://api.gateio.ws/api/v4/spot/candlesticks"
    step = _gate_chunk_span_sec(gate_interval)
    t = int(start_sec)
    while t <= int(end_sec):
        chunk_end = min(int(end_sec), t + step - 1)
        r = sess.get(
            url,
            params={
                "currency_pair": GATE_CURRENCY_PAIR,
                "interval": gate_interval,
                "from": str(t),
                "to": str(chunk_end),
                "limit": "1000",
            },
            timeout=45,
        )
        r.raise_for_status()
        arr = r.json()
        if not isinstance(arr, list):
            break
        for row in arr:
            p = _parse_gate_candle_row(row)
            if not p:
                continue
            ts_sec, o, h, l, c = p
            if ts_sec < start_sec or ts_sec > end_sec:
                continue
            out[ts_sec] = (o, h, l, c)
        t = chunk_end + 1
    return out


def _parse_bitget_candle_row(row: Any) -> Optional[Tuple[int, float, float, float, float]]:
    """Bitget v2 spot history-candles：字符串数组 [ts_ms, o, h, l, c, vol, ...]。"""
    if not isinstance(row, (list, tuple)) or len(row) < 5:
        return None
    try:
        ts_ms = int(float(row[0]))
        o, h, l, c = float(row[1]), float(row[2]), float(row[3]), float(row[4])
        ts_sec = int(ts_ms // 1000)
        return ts_sec, o, h, l, c
    except Exception:
        return None


def _bitget_fetch_candles_map(sess: requests.Session, start_sec: int, end_sec: int) -> Dict[int, Tuple[float, float, float, float]]:
    """分页拉取 Bitget 现货 1min K（公开 REST，limit 最大 200）。"""
    out: Dict[int, Tuple[float, float, float, float]] = {}
    start_sec_i = int(start_sec)
    end_sec_i = int(end_sec)
    end_ms = int(end_sec_i // 60 * 60) * 1000
    for _ in range(8000):
        r = sess.get(
            BITGET_REST_HISTORY_CANDLES,
            params={
                "symbol": BITGET_SYMBOL,
                "granularity": "1min",
                "limit": "200",
                "endTime": str(int(end_ms)),
            },
            timeout=45,
        )
        r.raise_for_status()
        payload = r.json() or {}
        if str(payload.get("code")) != "00000":
            break
        data = payload.get("data")
        if not isinstance(data, list) or not data:
            break
        batch_min_ms: Optional[int] = None
        for row in data:
            p = _parse_bitget_candle_row(row)
            if not p:
                continue
            ts_sec, o, h, l, c = p
            ts_ms = int(ts_sec) * 1000
            batch_min_ms = ts_ms if batch_min_ms is None else min(batch_min_ms, ts_ms)
            if ts_sec > end_sec_i:
                continue
            if ts_sec < start_sec_i:
                continue
            out[ts_sec] = (o, h, l, c)
        if batch_min_ms is None:
            break
        if batch_min_ms // 1000 < start_sec_i:
            break
        end_ms = int(batch_min_ms) - 1
        if len(data) < 200:
            break
    return out


def _aligned_1m_okx_bitget_frame(sess: requests.Session, fetch_start: int, end_sec: int) -> List[Dict[str, Any]]:
    """对齐 1m：同一 bucket 上 OKX 永续与 Bitget 现货 OHLC，USDT 价差 OHLC（_spread_ohlc）与收盘口径市值差值%（相对 Bitget）。"""
    okx_map = _okx_fetch_candles_map(sess, "1m", fetch_start, end_sec)
    bitget_map = _bitget_fetch_candles_map(sess, fetch_start, end_sec)
    keys = sorted(set(okx_map.keys()) & set(bitget_map.keys()))
    out: List[Dict[str, Any]] = []
    for ts in keys:
        ok = okx_map[ts]
        bg = bitget_map[ts]
        spo = _spread_ohlc(ok, bg)
        mcap_pct = _mcap_diff_pct_bitget_from_prices(ok[3], bg[3])
        out.append({"t_sec": int(ts), "okx": ok, "bitget": bg, "spread_ohlc": spo, "mcap_pct": mcap_pct})
    return out


def _aligned_1m_bitget_frame_cache_invalidate() -> None:
    with _ALIGNED_1M_BITGET_FRAME_LOCK:
        _ALIGNED_1M_BITGET_FRAME["at_ms"] = 0
        _ALIGNED_1M_BITGET_FRAME["fetch_start"] = -1
        _ALIGNED_1M_BITGET_FRAME["end_sec"] = -1
        _ALIGNED_1M_BITGET_FRAME["rows"] = []


def _get_aligned_1m_bitget_frame_cached(sess: requests.Session, fetch_start: int, end_sec: int) -> List[Dict[str, Any]]:
    end_tr = int(end_sec // 60) * 60
    now = _now_ms()
    with _ALIGNED_1M_BITGET_FRAME_LOCK:
        rows = _ALIGNED_1M_BITGET_FRAME.get("rows")
        if (
            isinstance(rows, list)
            and rows
            and int(_ALIGNED_1M_BITGET_FRAME.get("fetch_start", -1)) == int(fetch_start)
            and int(_ALIGNED_1M_BITGET_FRAME.get("end_sec", -1)) == end_tr
            and now - int(_ALIGNED_1M_BITGET_FRAME.get("at_ms", 0)) < int(_ALIGNED_1M_FRAME_TTL_MS)
        ):
            return list(rows)
    built = _aligned_1m_okx_bitget_frame(sess, fetch_start, end_sec)
    with _ALIGNED_1M_BITGET_FRAME_LOCK:
        _ALIGNED_1M_BITGET_FRAME["at_ms"] = int(now)
        _ALIGNED_1M_BITGET_FRAME["fetch_start"] = int(fetch_start)
        _ALIGNED_1M_BITGET_FRAME["end_sec"] = int(end_tr)
        _ALIGNED_1M_BITGET_FRAME["rows"] = built
    return built


def _merge_spread_series(
    okx_map: Dict[int, Tuple[float, float, float, float]],
    gate_map: Dict[int, Tuple[float, float, float, float]],
) -> List[Dict[str, Any]]:
    keys = sorted(set(okx_map.keys()) & set(gate_map.keys()))
    candles: List[Dict[str, Any]] = []
    for ts in keys:
        o, h, l, c = _spread_ohlc(okx_map[ts], gate_map[ts])
        gc = gate_map[ts][3]
        pct = ((okx_map[ts][3] - gc) / gc * 100.0) if gc else None
        candles.append({"t": int(ts), "o": o, "h": h, "l": l, "c": c, "pct_close": pct})
    return candles


def _aligned_1m_okx_gate_frame(sess: requests.Session, fetch_start: int, end_sec: int) -> List[Dict[str, Any]]:
    """
    对齐 1m：同一 time bucket 上 OKX 永续与 Gate 现货 OHLC，并算出 USDT 价差 OHLC（_spread_ohlc）与市值差值%（收盘口径）。
    """
    okx_map = _okx_fetch_candles_map(sess, "1m", fetch_start, end_sec)
    gate_map = _gate_fetch_candles_map(sess, "1m", fetch_start, end_sec)
    keys = sorted(set(okx_map.keys()) & set(gate_map.keys()))
    out: List[Dict[str, Any]] = []
    for ts in keys:
        ok = okx_map[ts]
        gt = gate_map[ts]
        spo = _spread_ohlc(ok, gt)
        mcap_pct = _mcap_diff_pct_gate_from_prices(ok[3], gt[3])
        out.append({"t_sec": int(ts), "okx": ok, "gate": gt, "spread_ohlc": spo, "mcap_pct": mcap_pct})
    return out


def _get_aligned_1m_frame_cached(sess: requests.Session, fetch_start: int, end_sec: int) -> List[Dict[str, Any]]:
    end_tr = int(end_sec // 60) * 60
    now = _now_ms()
    with _ALIGNED_1M_FRAME_LOCK:
        rows = _ALIGNED_1M_FRAME.get("rows")
        if (
            isinstance(rows, list)
            and rows
            and int(_ALIGNED_1M_FRAME.get("fetch_start", -1)) == int(fetch_start)
            and int(_ALIGNED_1M_FRAME.get("end_sec", -1)) == end_tr
            and now - int(_ALIGNED_1M_FRAME.get("at_ms", 0)) < int(_ALIGNED_1M_FRAME_TTL_MS)
        ):
            return list(rows)
    built = _aligned_1m_okx_gate_frame(sess, fetch_start, end_sec)
    with _ALIGNED_1M_FRAME_LOCK:
        _ALIGNED_1M_FRAME["at_ms"] = int(now)
        _ALIGNED_1M_FRAME["fetch_start"] = int(fetch_start)
        _ALIGNED_1M_FRAME["end_sec"] = int(end_tr)
        _ALIGNED_1M_FRAME["rows"] = built
    return built


def _frame_to_1m_spread_candles(frame: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """1m 价差 K（t 为秒）：由对齐主表直接得到，与 _merge_spread_series 数值一致。"""
    out: List[Dict[str, Any]] = []
    for r in frame:
        ts = int(r["t_sec"])
        ok = r["okx"]
        so, sh, sl, sc = r["spread_ohlc"]
        if "gate" in r:
            spot_close = float(r["gate"][3])
        elif "bitget" in r:
            spot_close = float(r["bitget"][3])
        else:
            continue
        pct = ((float(ok[3]) - spot_close) / spot_close * 100.0) if spot_close else None
        out.append({"t": ts, "o": so, "h": sh, "l": sl, "c": sc, "pct_close": pct})
    return out


def _resample_ohlc_candles(sorted_candles: List[Dict[str, Any]], step_sec: int) -> List[Dict[str, Any]]:
    """将 t 为秒、带 ohlc 的 K 线重采样到更大 step_sec（开盘对齐）。"""
    if not sorted_candles or int(step_sec) <= 0:
        return []
    step = int(step_sec)
    out: List[Dict[str, Any]] = []
    cur_b: Optional[int] = None
    o: Optional[float] = None
    h: Optional[float] = None
    l: Optional[float] = None
    c: Optional[float] = None
    last_pct: Optional[float] = None

    for x in sorted(sorted_candles, key=lambda z: int(z.get("t") or 0)):
        ts = int(x.get("t") or 0)
        b = (ts // step) * step
        vo, vh, vl, vc = float(x["o"]), float(x["h"]), float(x["l"]), float(x["c"])
        pc = x.get("pct_close")
        if cur_b is None or b != cur_b:
            if cur_b is not None and o is not None:
                out.append({"t": int(cur_b), "o": o, "h": float(h), "l": float(l), "c": float(c), "pct_close": last_pct})
            cur_b = b
            o, h, l, c = vo, vh, vl, vc
            last_pct = float(pc) if pc is not None else None
        else:
            h = max(float(h), vh)
            l = min(float(l), vl)
            c = vc
            if pc is not None:
                try:
                    last_pct = float(pc)
                except Exception:
                    pass
    if cur_b is not None and o is not None:
        out.append({"t": int(cur_b), "o": o, "h": float(h), "l": float(l), "c": float(c), "pct_close": last_pct})
    return out


def _frame_to_1m_mcap_pct_candles(frame: List[Dict[str, Any]], floor_sec: int) -> List[Dict[str, Any]]:
    """对齐 1m 上每根 K 的市值差值%（相对 Gate），t 为秒；仅 t>=floor_sec 且 mcap_pct 有效。"""
    out: List[Dict[str, Any]] = []
    fl = int(floor_sec)
    for r in frame:
        ts = int(r["t_sec"])
        if ts < fl:
            continue
        v = r.get("mcap_pct")
        if v is None:
            continue
        try:
            vf = float(v)
        except Exception:
            continue
        out.append({"t": ts, "o": vf, "h": vf, "l": vf, "c": vf, "pct_close": vf})
    return out


def _strip_pct_close_from_candles(candles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for c in candles:
        out.append(
            {
                "t": int(c["t"]),
                "o": float(c["o"]),
                "h": float(c["h"]),
                "l": float(c["l"]),
                "c": float(c["c"]),
            }
        )
    return out


def _rollup_spread_to_utc_day(hourly: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    buckets: Dict[int, List[Dict[str, Any]]] = {}
    for c in hourly:
        ts = int(c.get("t") or 0)
        day0 = (ts // 86_400) * 86_400
        buckets.setdefault(day0, []).append(c)
    out: List[Dict[str, Any]] = []
    for day0 in sorted(buckets.keys()):
        arr = sorted(buckets[day0], key=lambda x: int(x.get("t") or 0))
        o = float(arr[0]["o"])
        c = float(arr[-1]["c"])
        h = max(float(x["h"]) for x in arr)
        l = min(float(x["l"]) for x in arr)
        last_pct = arr[-1].get("pct_close")
        pct_close = float(last_pct) if last_pct is not None else None
        out.append({"t": int(day0), "o": o, "h": h, "l": l, "c": c, "pct_close": pct_close})
    return out


def _spread_effective_from_sec(sess: requests.Session, from_ts: int) -> Tuple[int, str]:
    """
    from_ts:
      -1  -> 默认：北京时间 2026-05-07 18:00
       0  -> OKX 日 K 可溯最早时间（合约可拉到的起点）
      >0  -> 自定义 unix 秒（对齐后只保留 t >= from 的 K 线）
    """
    disc = _discover_okx_earliest_sec(sess)
    if disc is None:
        disc = int(time.time()) - 86400 * 14
    if int(from_ts) == 0:
        return int(disc), "listing"
    if int(from_ts) < 0:
        return int(_SPREAD_DEFAULT_FROM_TS_SEC), "default_beijing_20260507_1800"
    return int(from_ts), "custom"


def _spread_cache_key(tf_norm: str, eff_from: int, venue_norm: str = "gate") -> str:
    vn = str(venue_norm).lower().strip()
    if vn not in {"gate", "bitget"}:
        vn = "gate"
    return f"{tf_norm}|{eff_from}|{vn}"


def _spread_aligned_caches_invalidate() -> None:
    _aligned_1m_frame_cache_invalidate()
    _aligned_1m_bitget_frame_cache_invalidate()


def _price_spread_candles_build(tf: str, from_ts: int, venue_norm: str = "gate") -> Dict[str, Any]:
    vn = str(venue_norm).lower().strip()
    if vn not in {"gate", "bitget"}:
        vn = "gate"
    tf_norm = str(tf).lower().strip()
    if tf_norm not in {"1m", "5m", "1h", "4h", "1d"}:
        tf_norm = "1m"
    rollup_day = tf_norm == "1d"
    sess = requests.Session()
    sess.trust_env = False
    discover_sec = _discover_okx_earliest_sec(sess)
    if discover_sec is None:
        return {"ok": False, "error": "okx_listing_unavailable", "tf": tf_norm, "venue": vn}
    eff_from, win_mode = _spread_effective_from_sec(sess, int(from_ts))
    end_sec = int(time.time())
    fetch_start = _aligned_rest_fetch_start_sec(int(discover_sec))

    if vn == "bitget":
        frame = _get_aligned_1m_bitget_frame_cached(sess, fetch_start, end_sec)
    else:
        frame = _get_aligned_1m_frame_cached(sess, fetch_start, end_sec)
    one_m = _frame_to_1m_spread_candles(frame)
    one_m = [c for c in one_m if int(c.get("t") or 0) >= eff_from]

    if rollup_day:
        hourly = _resample_ohlc_candles(one_m, 3600)
        hourly = [c for c in hourly if int(c.get("t") or 0) >= eff_from]
        candles = _rollup_spread_to_utc_day(hourly)
    else:
        step = {"1m": 60, "5m": 300, "1h": 3600, "4h": 14400}.get(tf_norm, 60)
        if step == 60:
            candles = one_m
        else:
            candles = _resample_ohlc_candles(one_m, step)
            candles = [c for c in candles if int(c.get("t") or 0) >= eff_from]

    n_built = len(candles)
    candles_out = candles[-MAX_HIST_CANDLES_RESPONSE:] if n_built > MAX_HIST_CANDLES_RESPONSE else candles
    lows_out = [float(x["l"]) for x in candles_out]
    highs_out = [float(x["h"]) for x in candles_out]
    rng = {"min": min(lows_out) if lows_out else None, "max": max(highs_out) if highs_out else None}
    eff_cn = datetime.fromtimestamp(eff_from, tz=_CN8).strftime("%Y-%m-%d %H:%M")
    meta: Dict[str, Any] = {
        "okx_inst": OKX_INST_ID,
        "spot_venue": vn,
        "okx_listing_first_ts_sec": int(discover_sec),
        "okx_listing_first_ts_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(discover_sec))),
        "window_from_ts_sec": int(eff_from),
        "window_from_ts_iso_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(eff_from))),
        "window_from_beijing": f"{eff_cn}（UTC+8）",
        "window_mode": win_mode,
        "merged_bars": int(n_built),
        "rollup_note": "1d 使用对齐的 1h 价差聚合为 UTC 0 点自然日（两家原生日 K 边界不同）。" if rollup_day else None,
    }
    if vn == "bitget":
        meta["bitget_symbol"] = BITGET_SYMBOL
    else:
        meta["gate_pair"] = GATE_CURRENCY_PAIR

    if vn == "bitget":
        definition = (
            "每根 K：先对齐 1m OKX 永续与 Bitget 现货 OHLC，在同一 time bucket 上合成价差 OHLC（high=max(OKX.high−Bitget.low, open, close)；"
            "low=min(OKX.low−Bitget.high, open, close)）；大于 1m 的周期由 1m 价差 K 重采样；1d 再经 1h 聚合为 UTC 自然日。"
            "与 /api/candles?venue=bitget 市值差% 同源、共用一次 REST 拉取（短 TTL 内存缓存）。默认窗北京时间 2026-05-07 18:00 起；from_ts=0 表示从 OKX 可溯起点。"
        )
    else:
        definition = (
            "每根 K：先对齐 1m OKX 永续与 Gate 现货 OHLC，在同一 time bucket 上合成价差 OHLC（high=max(OKX.high−Gate.low, open, close)；"
            "low=min(OKX.low−Gate.high, open, close)）；大于 1m 的周期由 1m 价差 K 重采样；1d 再经 1h 聚合为 UTC 自然日。"
            "与 /api/candles?venue=gate 市值差% 同源、共用一次 REST 拉取（短 TTL 内存缓存）。默认窗北京时间 2026-05-07 18:00 起；from_ts=0 表示从 OKX 可溯起点。"
        )

    return {
        "ok": True,
        "venue": vn,
        "tf": tf_norm,
        "from_ts": int(from_ts),
        "effective_from_ts_sec": int(eff_from),
        "cache_key": _spread_cache_key(tf_norm, eff_from, vn),
        "definition": definition,
        "meta": meta,
        "candles": candles_out,
        "candles_built": int(n_built),
        "candles_truncated": bool(n_built > MAX_HIST_CANDLES_RESPONSE),
        "candles_max_return": int(MAX_HIST_CANDLES_RESPONSE),
        "range": rng,
        "built_at_ms": _now_ms(),
    }


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
    meta["spot_page"] = GATE_SPCX_TRADE_URL
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
    meta["spot_page"] = BITGET_SPCX_TRADE_URL
    return last, meta


app = FastAPI(title="SPACEX Spread Monitor")
# 允许前端通过 meta / localStorage 指定其它源的 API 根（cloudflared 隧道等）拉取 /api/*。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
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
    try:
        await asyncio.to_thread(_merge_gate_mcap_backfill_and_persist)
    except Exception:
        pass
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


def _mcap_diff_pct_gate_from_prices(okx_last: float, gate_last: float) -> Optional[float]:
    """
    与 /api/quote 中 market_cap.diff_pct_vs_spot（Gate 口径）一致：
    (OKX_last*OKX股数 - Gate_last*Gate股数) / (Gate_last*Gate股数) * 100
    """
    gate_mcap = gate_last * GATE_SHARES_OUTSTANDING
    if not gate_mcap:
        return None
    okx_mcap = okx_last * OKX_SHARES_OUTSTANDING
    return (okx_mcap - gate_mcap) / gate_mcap * 100.0


def _mcap_diff_pct_bitget_from_prices(okx_last: float, bitget_last: float) -> Optional[float]:
    """与 /api/quote venue=bitget 的市值差值%（相对 Bitget）一致。"""
    bitget_mcap = bitget_last * BITGET_SHARES_OUTSTANDING
    if not bitget_mcap:
        return None
    okx_mcap = okx_last * OKX_SHARES_OUTSTANDING
    return (okx_mcap - bitget_mcap) / bitget_mcap * 100.0


def _build_gate_mcap_hist_backfill_ms(sess: requests.Session) -> List[Dict[str, float]]:
    """
    用对齐的 1m K 线收盘价回填「市值差值%（相对 Gate）」时间序列（毫秒时间戳 = K 线开盘时间）。
    起点：北京时间 2026-05-07 18:00（与价差 K 默认窗一致）。
    """
    start_sec = int(_SPREAD_DEFAULT_FROM_TS_SEC)
    end_sec = int(time.time())
    disc = _discover_okx_earliest_sec(sess)
    if disc is None:
        disc = start_sec
    fetch_start = _aligned_rest_fetch_start_sec(int(disc))
    frame = _get_aligned_1m_frame_cached(sess, fetch_start, end_sec)
    out: List[Dict[str, float]] = []
    for r in frame:
        ts = int(r["t_sec"])
        if ts < start_sec:
            continue
        v = r.get("mcap_pct")
        if v is None:
            continue
        try:
            vf = float(v)
        except Exception:
            continue
        out.append({"t": float(ts * 1000), "v": vf})
    return out


def _merge_gate_mcap_backfill_and_persist() -> Dict[str, Any]:
    """
    将回填点与磁盘/内存中已有采样点合并（同毫秒 t 保留已有，不覆盖实时写入），并重写 Gate NDJSON。
    """
    venue_norm = "gate"
    hist_path = HISTORY_PATHS.get(venue_norm) or HISTORY_PATHS["gate"]
    sess = requests.Session()
    sess.trust_env = False
    try:
        new_pts = _build_gate_mcap_hist_backfill_ms(sess)
    except Exception as e:
        return {"ok": False, "error": repr(e), "added": 0, "merged": 0}
    with _hist_lock:
        cur = list(_hist_points_by_venue.get(venue_norm, []))
    by_t: Dict[int, float] = {}
    for p in cur:
        try:
            by_t[int(float(p["t"]))] = float(p["v"])
        except Exception:
            continue
    n_before = len(by_t)
    for p in new_pts:
        t = int(p["t"])
        if t in by_t:
            continue
        by_t[t] = float(p["v"])
    added = len(by_t) - n_before
    merged = [{"t": float(t), "v": float(v)} for t, v in sorted(by_t.items(), key=lambda kv: kv[0])]
    if len(merged) > HISTORY_MAX_POINTS:
        merged = merged[-HISTORY_MAX_POINTS:]
    with _hist_lock:
        _hist_points_by_venue[venue_norm] = merged
    if added > 0:
        try:
            tmp = f"{hist_path}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                for p in merged:
                    f.write(json.dumps({"t": int(p["t"]), "v": float(p["v"])}, ensure_ascii=False) + "\n")
            Path(tmp).replace(hist_path)
        except Exception:
            pass
    return {"ok": True, "added": int(added), "merged": len(merged)}


def _hist_aggregate_points_to_candles(
    tf_s: int,
    pts: List[Dict[str, Any]],
    *,
    venue_norm: str,
    gate_hist_floor_ms: int,
) -> Tuple[List[Dict[str, Any]], int]:
    """将 (t_ms, v) 采样点聚合成 OHLC K 线（t 为桶起点秒）。"""
    candles: List[Dict[str, Any]] = []
    cur_bucket: Optional[int] = None
    o: Optional[float] = None
    h: Optional[float] = None
    l: Optional[float] = None
    c: Optional[float] = None
    used_pts = 0

    for p in pts:
        t_ms = int(p.get("t") or 0)
        if venue_norm in ("gate", "bitget") and t_ms < gate_hist_floor_ms:
            continue
        used_pts += 1
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

    return candles, used_pts


# 历史「差值% 相对 Gate」与 OKX×Gate USDT 价差 K 共用：对齐 1m 收盘价 + 固定股数算市值差%，再按相同 step 重采样；1D=1h 后按 UTC 自然日聚合（与 /api/price-spread-candles 一致）。
_GATE_HIST_REMOTE_TF_SEC = {60, 300, 3600, 14_400, 86_400}


def _gate_hist_candles_from_rest_sync(tf_s: int) -> Dict[str, Any]:
    """
    Gate 口径市值差值% K 线：与「OKX×Gate 价格价差 K 线（USDT）」同源对齐 1m 表 + 固定股数公式；
    默认时间窗与 /api/price-spread-candles?from_ts=-1 一致：北京时间 2026-05-07 18:00（= UTC 2026-05-07 10:00）起至今。
    重采样与价差的 _price_spread_candles_build 相同：先筛 t>=eff_from 的 1m，再大周期聚合后再筛 bucket（1D 仅筛 1h、不按日 K 的 t 截断）。
    """
    gate_hist_floor_ms = int(_SPREAD_DEFAULT_FROM_TS_SEC) * 1000
    eff_from = int(_SPREAD_DEFAULT_FROM_TS_SEC)
    floor_sec = eff_from
    tf_i = int(tf_s)
    if tf_i not in _GATE_HIST_REMOTE_TF_SEC:
        tf_i = 60
    sess = requests.Session()
    sess.trust_env = False
    discover = _discover_okx_earliest_sec(sess)
    if discover is None:
        return {
            "tf": int(tf_i),
            "venue": "gate",
            "candles": [],
            "range": {"min": None, "max": None},
            "points": 0,
            "points_raw": 0,
            "hist_from_ms": int(gate_hist_floor_ms),
            "effective_from_ts_sec": int(eff_from),
            "data_source": "okx_gate_public_rest",
            "error": "okx_listing_unavailable",
            "data_source_detail": "无法取得 OKX 可溯起点；请稍后重试。",
            "page_links": {"okx": OKX_SPACEX_TRADE_URL, "gate": GATE_SPCX_TRADE_URL},
            "rest_endpoints": {"okx": OKX_REST_MARKET_CANDLES, "gate": GATE_REST_SPOT_CANDLES},
            "inst_id": OKX_INST_ID,
            "gate_pair": GATE_CURRENCY_PAIR,
            "hist_time_align": "okx_gate_spread_k_same_buckets",
            "diff_pct_formula": DIFF_PCT_VS_GATE_FORMULA,
            "price_sources": {"okx_instId": OKX_INST_ID, "gate_currency_pair": GATE_CURRENCY_PAIR},
            "window_timezone_note": "默认窗起点为北京时间；K 线时间戳为 Unix 秒；图表建议 Asia/Shanghai 显示",
        }
    fetch_start = _aligned_rest_fetch_start_sec(int(discover))
    end_sec = int(time.time())
    frame = _get_aligned_1m_frame_cached(sess, fetch_start, end_sec)
    one_m = _frame_to_1m_mcap_pct_candles(frame, floor_sec)
    if tf_i == 86_400:
        hourly = _resample_ohlc_candles(one_m, 3600)
        hourly = [c for c in hourly if int(c.get("t") or 0) >= eff_from]
        raw_candles = _rollup_spread_to_utc_day(hourly)
    else:
        step = {60: 60, 300: 300, 3600: 3600, 14_400: 14_400}.get(tf_i, 60)
        if step == 60:
            raw_candles = one_m
        else:
            raw_candles = _resample_ohlc_candles(one_m, step)
            raw_candles = [c for c in raw_candles if int(c.get("t") or 0) >= eff_from]
    candles = _strip_pct_close_from_candles(raw_candles)
    n_built = len(candles)
    candles_out = candles[-MAX_HIST_CANDLES_RESPONSE:] if n_built > MAX_HIST_CANDLES_RESPONSE else candles
    lows = [float(x["l"]) for x in candles_out] if candles_out else []
    highs = [float(x["h"]) for x in candles_out] if candles_out else []
    rng = {"min": min(lows) if lows else None, "max": max(highs) if highs else None}
    eff_cn = datetime.fromtimestamp(eff_from, tz=_CN8).strftime("%Y-%m-%d %H:%M")
    first_ts = int(candles_out[0]["t"]) if candles_out else None
    last_ts = int(candles_out[-1]["t"]) if candles_out else None
    return {
        "tf": int(tf_i),
        "venue": "gate",
        "candles": candles_out,
        "candles_built": int(n_built),
        "candles_truncated": bool(n_built > MAX_HIST_CANDLES_RESPONSE),
        "candles_max_return": int(MAX_HIST_CANDLES_RESPONSE),
        "range": rng,
        "aggregation": "rest_aligned_1m",
        "candles_first_ts": first_ts,
        "candles_last_ts": last_ts,
        "points": int(len(one_m)),
        "points_raw": int(len(one_m)),
        "hist_from_ms": int(gate_hist_floor_ms),
        "effective_from_ts_sec": int(eff_from),
        "effective_from_ts_iso_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(eff_from))),
        "window_from_beijing": f"{eff_cn}（UTC+8）",
        "window_note": "默认窗：北京时间 2026-05-07 18:00 起至当前（与 UTC 2026-05-07 10:00 对齐）；与 price-spread-candles from_ts=-1 一致。",
        "data_source": "okx_gate_public_rest",
        "data_source_detail": "同源对齐 1m（与 USDT 价差 K）→ 市值差值% 公式与上方实时一致 → 按价差 K 相同 step 重采样；1D：先 1h 且仅保留 t≥窗起点的小时，再 UTC 自然日 rollup。",
        "page_links": {"okx": OKX_SPACEX_TRADE_URL, "gate": GATE_SPCX_TRADE_URL},
        "rest_endpoints": {"okx": OKX_REST_MARKET_CANDLES, "gate": GATE_REST_SPOT_CANDLES},
        "inst_id": OKX_INST_ID,
        "gate_pair": GATE_CURRENCY_PAIR,
        "hist_time_align": "okx_gate_spread_k_same_buckets",
        "diff_pct_formula": DIFF_PCT_VS_GATE_FORMULA,
        "price_sources": {"okx_instId": OKX_INST_ID, "gate_currency_pair": GATE_CURRENCY_PAIR},
        "window_timezone_note": "默认窗起点为北京时间；K 线时间戳为 Unix 秒；图表建议 Asia/Shanghai 显示",
    }


def _bitget_hist_candles_from_rest_sync(tf_s: int) -> Dict[str, Any]:
    """
    Bitget 口径市值差值% K 线：OKX 永续 + Bitget 现货公开 REST 对齐 1m + 固定股数公式（与 venue=bitget 的 /api/quote 一致）；
    默认时间窗与 Gate REST 相同（北京时间 2026-05-07 18:00 起）。
    """
    gate_hist_floor_ms = int(_SPREAD_DEFAULT_FROM_TS_SEC) * 1000
    eff_from = int(_SPREAD_DEFAULT_FROM_TS_SEC)
    floor_sec = eff_from
    tf_i = int(tf_s)
    if tf_i not in _GATE_HIST_REMOTE_TF_SEC:
        tf_i = 60
    sess = requests.Session()
    sess.trust_env = False
    discover = _discover_okx_earliest_sec(sess)
    if discover is None:
        return {
            "tf": int(tf_i),
            "venue": "bitget",
            "candles": [],
            "range": {"min": None, "max": None},
            "points": 0,
            "points_raw": 0,
            "hist_from_ms": int(gate_hist_floor_ms),
            "effective_from_ts_sec": int(eff_from),
            "data_source": "okx_bitget_public_rest",
            "error": "okx_listing_unavailable",
            "data_source_detail": "无法取得 OKX 可溯起点；请稍后重试。",
            "page_links": {"okx": OKX_SPACEX_TRADE_URL, "bitget": BITGET_SPCX_TRADE_URL},
            "rest_endpoints": {"okx": OKX_REST_MARKET_CANDLES, "bitget": BITGET_REST_HISTORY_CANDLES},
            "inst_id": OKX_INST_ID,
            "bitget_symbol": BITGET_SYMBOL,
            "hist_time_align": "okx_bitget_spread_k_same_buckets",
            "diff_pct_formula": DIFF_PCT_VS_BITGET_FORMULA,
            "price_sources": {
                "okx_instId": OKX_INST_ID,
                "bitget_symbol": BITGET_SYMBOL,
                "bitget_spot_page": BITGET_SPCX_TRADE_URL,
            },
            "window_timezone_note": "默认窗起点为北京时间；K 线时间戳为 Unix 秒；图表建议 Asia/Shanghai 显示",
        }
    fetch_start = _aligned_rest_fetch_start_sec(int(discover))
    end_sec = int(time.time())
    frame = _get_aligned_1m_bitget_frame_cached(sess, fetch_start, end_sec)
    one_m = _frame_to_1m_mcap_pct_candles(frame, floor_sec)
    if tf_i == 86_400:
        hourly = _resample_ohlc_candles(one_m, 3600)
        hourly = [c for c in hourly if int(c.get("t") or 0) >= eff_from]
        raw_candles = _rollup_spread_to_utc_day(hourly)
    else:
        step = {60: 60, 300: 300, 3600: 3600, 14_400: 14_400}.get(tf_i, 60)
        if step == 60:
            raw_candles = one_m
        else:
            raw_candles = _resample_ohlc_candles(one_m, step)
            raw_candles = [c for c in raw_candles if int(c.get("t") or 0) >= eff_from]
    candles = _strip_pct_close_from_candles(raw_candles)
    n_built = len(candles)
    candles_out = candles[-MAX_HIST_CANDLES_RESPONSE:] if n_built > MAX_HIST_CANDLES_RESPONSE else candles
    lows = [float(x["l"]) for x in candles_out] if candles_out else []
    highs = [float(x["h"]) for x in candles_out] if candles_out else []
    rng = {"min": min(lows) if lows else None, "max": max(highs) if highs else None}
    eff_cn = datetime.fromtimestamp(eff_from, tz=_CN8).strftime("%Y-%m-%d %H:%M")
    first_ts = int(candles_out[0]["t"]) if candles_out else None
    last_ts = int(candles_out[-1]["t"]) if candles_out else None
    return {
        "tf": int(tf_i),
        "venue": "bitget",
        "candles": candles_out,
        "candles_built": int(n_built),
        "candles_truncated": bool(n_built > MAX_HIST_CANDLES_RESPONSE),
        "candles_max_return": int(MAX_HIST_CANDLES_RESPONSE),
        "range": rng,
        "aggregation": "rest_aligned_1m",
        "candles_first_ts": first_ts,
        "candles_last_ts": last_ts,
        "points": int(len(one_m)),
        "points_raw": int(len(one_m)),
        "hist_from_ms": int(gate_hist_floor_ms),
        "effective_from_ts_sec": int(eff_from),
        "effective_from_ts_iso_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(eff_from))),
        "window_from_beijing": f"{eff_cn}（UTC+8）",
        "window_note": "默认窗：北京时间 2026-05-07 18:00 起至当前（与 Gate REST 默认窗一致）。",
        "data_source": "okx_bitget_public_rest",
        "data_source_detail": "对齐 1m（OKX 永续 + Bitget 现货公开 REST，品种与 Bitget 官网 PRESPAXUSDT 现货页一致）→ 市值差值% 相对 Bitget 与实时报价公式一致 → 按与 Gate REST 相同的 step 重采样；1D：先 1h 再 UTC 自然日 rollup。",
        "page_links": {"okx": OKX_SPACEX_TRADE_URL, "bitget": BITGET_SPCX_TRADE_URL},
        "rest_endpoints": {"okx": OKX_REST_MARKET_CANDLES, "bitget": BITGET_REST_HISTORY_CANDLES},
        "inst_id": OKX_INST_ID,
        "bitget_symbol": BITGET_SYMBOL,
        "hist_time_align": "okx_bitget_spread_k_same_buckets",
        "diff_pct_formula": DIFF_PCT_VS_BITGET_FORMULA,
        "price_sources": {
            "okx_instId": OKX_INST_ID,
            "bitget_symbol": BITGET_SYMBOL,
            "bitget_spot_page": BITGET_SPCX_TRADE_URL,
        },
        "window_timezone_note": "默认窗起点为北京时间；K 线时间戳为 Unix 秒；图表建议 Asia/Shanghai 显示",
    }


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
async def api_candles(
    tf: int = 60,
    venue: str = "gate",
    source: str = Query(
        "remote",
        description="gate/bitget: remote=OKX+对应现货公开REST(对齐1m); local=仅本地NDJSON采样聚合",
    ),
    nocache: int = 0,
) -> Dict[str, Any]:
    """
    OHLC candles for market cap diff % vs selected venue.
    Gate / Bitget（remote）：仅 60,300,3600,14400,86400（与 USDT 价差 K 的 1m/5m/1h/4h/1D 时间桶一致）。
    Gate / Bitget（local）：另支持 120,180,900,1800,10800,21600 等秒周期（本地 NDJSON 聚合）。
    """
    supported_gate = {60, 300, 3600, 14_400, 86_400}
    supported_bitget_local = {60, 120, 180, 300, 900, 1800, 3600, 10_800, 21_600, 86_400, 14_400}
    tf_s = int(tf)

    venue_norm = "bitget" if str(venue).lower() == "bitget" else "gate"
    source_l = str(source or "remote").lower().strip()
    gate_hist_floor_ms = int(_SPREAD_DEFAULT_FROM_TS_SEC) * 1000

    if venue_norm == "gate" and source_l == "remote":
        if tf_s not in supported_gate:
            tf_s = 60
    elif venue_norm == "bitget" and source_l == "remote":
        if tf_s not in supported_gate:
            tf_s = 60
    else:
        if tf_s not in supported_bitget_local:
            tf_s = 60

    if venue_norm == "gate" and source_l != "local":
        if int(nocache) != 0:
            with _GATE_HIST_REST_CACHE_LOCK:
                _GATE_HIST_REST_CACHE.pop(tf_s, None)
            _aligned_1m_frame_cache_invalidate()
        now = _now_ms()
        with _GATE_HIST_REST_CACHE_LOCK:
            ent = _GATE_HIST_REST_CACHE.get(tf_s)
            if ent is not None:
                cached_at, payload = ent
                if now - int(cached_at) < int(_GATE_HIST_REST_TTL_MS) and isinstance(payload, dict):
                    return {**payload, "cached": True, "cache_age_ms": now - int(cached_at)}
        try:
            payload = await asyncio.to_thread(_gate_hist_candles_from_rest_sync, tf_s)
        except Exception as e:
            return {
                "tf": tf_s,
                "venue": "gate",
                "error": repr(e),
                "candles": [],
                "range": {"min": None, "max": None},
                "points": 0,
                "points_raw": 0,
                "hist_from_ms": int(gate_hist_floor_ms),
                "data_source": "okx_gate_public_rest",
                "cached": False,
            }
        if not payload.get("error"):
            with _GATE_HIST_REST_CACHE_LOCK:
                _GATE_HIST_REST_CACHE[tf_s] = (int(_now_ms()), dict(payload))
        return {**payload, "cached": False}

    if venue_norm == "bitget" and source_l != "local":
        if int(nocache) != 0:
            with _BITGET_HIST_REST_CACHE_LOCK:
                _BITGET_HIST_REST_CACHE.pop(tf_s, None)
            _aligned_1m_bitget_frame_cache_invalidate()
        now = _now_ms()
        with _BITGET_HIST_REST_CACHE_LOCK:
            ent = _BITGET_HIST_REST_CACHE.get(tf_s)
            if ent is not None:
                cached_at, payload = ent
                if now - int(cached_at) < int(_BITGET_HIST_REST_TTL_MS) and isinstance(payload, dict):
                    return {**payload, "cached": True, "cache_age_ms": now - int(cached_at)}
        try:
            payload = await asyncio.to_thread(_bitget_hist_candles_from_rest_sync, tf_s)
        except Exception as e:
            return {
                "tf": tf_s,
                "venue": "bitget",
                "error": repr(e),
                "candles": [],
                "range": {"min": None, "max": None},
                "points": 0,
                "points_raw": 0,
                "hist_from_ms": int(gate_hist_floor_ms),
                "data_source": "okx_bitget_public_rest",
                "cached": False,
            }
        if not payload.get("error"):
            with _BITGET_HIST_REST_CACHE_LOCK:
                _BITGET_HIST_REST_CACHE[tf_s] = (int(_now_ms()), dict(payload))
        return {**payload, "cached": False}

    with _hist_lock:
        pts = list(_hist_points_by_venue.get(venue_norm, []))

    candles, used_pts = _hist_aggregate_points_to_candles(
        tf_s, pts, venue_norm=venue_norm, gate_hist_floor_ms=gate_hist_floor_ms
    )
    n_c = len(candles)
    candles_out = candles[-MAX_HIST_CANDLES_RESPONSE:] if n_c > MAX_HIST_CANDLES_RESPONSE else candles
    lows = [float(x["l"]) for x in candles_out] if candles_out else []
    highs = [float(x["h"]) for x in candles_out] if candles_out else []
    rng = {"min": min(lows) if lows else None, "max": max(highs) if highs else None}
    first_ts = int(candles_out[0]["t"]) if candles_out else None
    last_ts = int(candles_out[-1]["t"]) if candles_out else None
    local_payload: Dict[str, Any] = {
        "tf": tf_s,
        "venue": venue_norm,
        "candles": candles_out,
        "candles_built": int(n_c),
        "candles_truncated": bool(n_c > MAX_HIST_CANDLES_RESPONSE),
        "candles_max_return": int(MAX_HIST_CANDLES_RESPONSE),
        "range": rng,
        "aggregation": "local_ndjson" if venue_norm == "gate" else "local_ndjson_bitget",
        "candles_first_ts": first_ts,
        "candles_last_ts": last_ts,
        "points": int(used_pts),
        "points_raw": len(pts),
        "hist_from_ms": int(gate_hist_floor_ms) if venue_norm == "gate" else None,
        "data_source": "local_ndjson",
        "page_links": {
            "okx": OKX_SPACEX_TRADE_URL,
            "gate": GATE_SPCX_TRADE_URL,
            "bitget": BITGET_SPCX_TRADE_URL,
        },
    }
    if venue_norm == "gate":
        local_payload["diff_pct_formula"] = DIFF_PCT_VS_GATE_FORMULA
        local_payload["price_sources"] = {"okx_instId": OKX_INST_ID, "gate_currency_pair": GATE_CURRENCY_PAIR}
        local_payload["window_timezone_note"] = "默认窗起点为北京时间；K 线时间戳为 Unix 秒；图表建议 Asia/Shanghai 显示"
    elif venue_norm == "bitget":
        local_payload["hist_from_ms"] = int(gate_hist_floor_ms)
        local_payload["diff_pct_formula"] = DIFF_PCT_VS_BITGET_FORMULA
        local_payload["price_sources"] = {
            "okx_instId": OKX_INST_ID,
            "bitget_symbol": BITGET_SYMBOL,
            "bitget_spot_page": BITGET_SPCX_TRADE_URL,
        }
        local_payload["window_timezone_note"] = "默认窗起点为北京时间；K 线时间戳为 Unix 秒；图表建议 Asia/Shanghai 显示"
    return local_payload


@app.get("/api/price-spread-candles")
async def api_price_spread_candles(
    tf: str = "1m",
    nocache: int = 0,
    venue: str = Query("gate", description="gate：OKX×Gate USDT 价差 K；bitget：OKX×Bitget"),
    from_ts: int = Query(
        -1,
        description="时间窗起点 unix 秒：默认 -1=北京时间2026-05-07 18:00起；0=OKX日K可溯最早；其它=自定义起点",
    ),
) -> Dict[str, Any]:
    """
    Historical OKX perpetual minus spot (Gate or Bitget), aligned K-line buckets (public REST).
    tf: 1m | 5m | 1h | 4h | 1d (1d = UTC calendar day rollup from aligned 1h spreads).
    """
    tf_norm = str(tf).lower().strip()
    if tf_norm not in {"1m", "5m", "1h", "4h", "1d"}:
        tf_norm = "1m"
    venue_norm = "bitget" if str(venue).lower().strip() == "bitget" else "gate"
    sess = requests.Session()
    sess.trust_env = False
    eff_from, _win = _spread_effective_from_sec(sess, int(from_ts))
    ckey = _spread_cache_key(tf_norm, eff_from, venue_norm)
    if int(nocache) != 0:
        with _SPREAD_CACHE_LOCK:
            _SPREAD_CACHE.pop(ckey, None)
        _spread_aligned_caches_invalidate()
    now = _now_ms()
    with _SPREAD_CACHE_LOCK:
        ent = _SPREAD_CACHE.get(ckey)
        if ent is not None:
            cached_at, payload = ent
            if now - int(cached_at) < int(_spread_cache_ttl_ms(tf_norm)) and payload.get("ok"):
                return {**payload, "cached": True, "cache_age_ms": now - int(cached_at)}
    try:
        payload = await asyncio.to_thread(_price_spread_candles_build, tf_norm, int(from_ts), venue_norm)
    except Exception as e:
        return {"ok": False, "error": repr(e), "tf": tf_norm, "venue": venue_norm, "cached": False}
    if payload.get("ok"):
        ck = str(payload.get("cache_key") or ckey)
        with _SPREAD_CACHE_LOCK:
            _SPREAD_CACHE[ck] = (int(_now_ms()), payload)
    return {**payload, "cached": False}


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
        rev_ok = last is not None and int(last.get("shares_revision") or 0) == int(QUOTE_SHARES_REVISION)
        if (
            rev_ok
            and last is not None
            and last_at is not None
            and (now - last_at) <= QUOTE_CACHE_TTL_MS
        ):
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

    mcap_block: Dict[str, Any] = {
        "okx_shares_outstanding": okx_shares,
        "spot_shares_outstanding": float(spot_shares),
        "okx_implied_usd": okx_mcap,
        "spot_implied_usd": spot_mcap,
        "diff_usd": mcap_diff,
        "diff_pct_vs_spot": mcap_diff_pct,
        "notes": (
            "固定口径：OKX=10亿股；Gate 现货总股本=1.4万亿/590 股。OKX Pre-IPO 合约为每股价口径；Spot 用固定股本推导隐含市值。"
            if venue_norm == "gate"
            else (
                "固定口径：OKX=10亿股；Bitget PRESPAX 现货股本见 main.py BITGET_SHARES_OUTSTANDING（IPO Prime 推导）。"
                "现货最新价与历史 K 来自 Bitget 公开 REST，交易品种与官网 "
                + BITGET_SPCX_TRADE_URL
                + " 一致。"
            )
        ),
        "spot_shares_formula": None,
    }
    if venue_norm == "gate":
        mcap_block["spot_shares_formula"] = f"{GATE_SHARES_NUMERATOR}/{GATE_SHARES_DENOMINATOR}"
        mcap_block["spot_shares_outstanding_exact"] = float(GATE_SHARES_OUTSTANDING)

    payload = {
        "venue": venue_norm,
        "shares_revision": int(QUOTE_SHARES_REVISION),
        "at_ms": _now_ms(),
        "latency_ms": _now_ms() - t0,
        "okx": {"instId": OKX_INST_ID, "last": okx_last, "meta": okx_meta},
        "spot": {
            "venue": venue_norm,
            "symbol": BITGET_SYMBOL if venue_norm == "bitget" else GATE_CURRENCY_PAIR,
            "last": spot_last,
            "meta": spot_meta,
            "spot_page": BITGET_SPCX_TRADE_URL if venue_norm == "bitget" else GATE_SPCX_TRADE_URL,
        },
        "spread": {"abs": spread, "pct_vs_spot": spread_pct, "mid": mid},
        "market_cap": mcap_block,
        "bark": bark,
    }

    with _cache_lock:
        _last_quote_payload_by_venue[venue_norm] = payload
        _last_quote_at_ms_by_venue[venue_norm] = int(payload.get("at_ms") or _now_ms())
    return payload

