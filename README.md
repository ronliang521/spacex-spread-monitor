## SPACEX / SPCX 价差监控（OKX 合约 vs Gate 现货）

监控：
- OKX 永续：`SPACEX-USDT-SWAP`
- Gate 现货：`SPCX_USDT`

### 本地启动

确保已安装依赖（根目录 `requirements.txt` 已包含 `fastapi` / `uvicorn` / `requests` / `jinja2`）。

在仓库根目录执行：

```bash
python3 -m uvicorn spacex_spread_monitor.main:app --app-dir "spacex-spread-monitor" --reload --port 8766
```

打开：
- `http://localhost:8766/`

### Cloudflare Workers 托管（推荐用于公网）

本仓库在根目录提供 `wrangler.toml`：`main` 为 `cloudflare/src/index.ts`，静态资源目录为 `cloudflare/public/`（含 `index.html` 与 `static/*`）。`npx wrangler deploy` 会同时上传 Worker 与静态资源，不再出现「找不到静态文件目录」的错误。

前置：本机已安装 Node.js 18+（含 `npm`）。

```bash
cd spacex-spread-monitor
npm install
npm run cf:deploy
```

本地预览 Worker + 静态资源（需本机有 `npm`）：

```bash
npm run cf:dev
```

说明：

- `/api/quote`、`/api/config`、`/api/candles`、`/api/bark/test` 由 Worker 实现，逻辑与 `spacex_spread_monitor/main.py` 对齐（同一套交易所 HTTP 接口与市值口径）。
- Bark 与 K 线历史、配置保存在 **Worker 进程内存** 中；冷启动或多实例时可能重置。若需要跨重启持久化，可后续在 `wrangler.toml` 中绑定 KV 并改 Worker 读写（当前为零配置部署）。
- 若你修改了 `spacex_spread_monitor/static/` 下的前端文件，请同步到 Cloudflare 目录后再部署：

```bash
npm run sync:static
```

### Bark 提醒

页面右上角点 **Bark 设置**：
- 填 `Bark Key`
- 打开“启用 Bark 提醒”
- 设定阈值（%）与冷却（秒）
- 可点“发送测试”验证推送

配置会写入：`spacex-spread-monitor/spacex_spread_monitor/config.json`

