/** Shared with cloudflare/src/index.ts remote quote paths — single source for REST K 聚合 */
export const OKX_INST_ID = "SPACEX-USDT-SWAP";
export const GATE_CURRENCY_PAIR = "SPCX_USDT";
export const BITGET_SYMBOL = "PRESPAXUSDT";

export const OKX_SHARES_OUTSTANDING = 1_000_000_000;
export const GATE_SHARES_NUMERATOR = 1_400_000_000_000;
export const GATE_SHARES_DENOMINATOR = 590;
export const GATE_SHARES_OUTSTANDING = GATE_SHARES_NUMERATOR / GATE_SHARES_DENOMINATOR;
/** 与 FastAPI main.py BITGET_SHARES_OUTSTANDING 一致（IPO Prime 口径） */
export const BITGET_SHARES_OUTSTANDING = 2_307_692_308;

export const BITGET_REST_HISTORY_CANDLES = "https://api.bitget.com/api/v2/spot/market/history-candles";
/** Bitget 官网现货页（与公开 REST 品种同源） */
export const BITGET_SPOT_PAGE_URL = "https://www.bitget.com/zh-CN/spot/PRESPAXUSDT";
