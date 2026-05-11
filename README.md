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

### Bark 提醒

页面右上角点 **Bark 设置**：
- 填 `Bark Key`
- 打开“启用 Bark 提醒”
- 设定阈值（%）与冷却（秒）
- 可点“发送测试”验证推送

配置会写入：`spacex-spread-monitor/spacex_spread_monitor/config.json`

