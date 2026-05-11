import json
import subprocess
import time
from pathlib import Path

import requests

LOG_PATH = Path("/Users/ronliang/Documents/cursor/.cursor/debug-217aa0.log")
SESSION_ID = "217aa0"


def emit(run_id: str, hypothesis_id: str, location: str, message: str, data: dict) -> None:
    payload = {
        "sessionId": SESSION_ID,
        "runId": run_id,
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data,
        "timestamp": int(time.time() * 1000),
    }
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def run_cmd(command: str) -> tuple[int, str, str]:
    p = subprocess.run(command, shell=True, capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def main() -> None:
    run_id = "pre-fix-1"
    cfg_path = Path("/Users/ronliang/.cloudflared/config.yml")
    cfg_text = cfg_path.read_text(encoding="utf-8", errors="ignore") if cfg_path.exists() else ""

    # #region agent log
        run_id,
        "H1",
        "tools/tunnel_probe.py:40",
        "cloudflared config snapshot",
        {
            "exists": cfg_path.exists(),
            "has_ingress": "ingress:" in cfg_text,
            "has_hostname": "hostname:" in cfg_text,
            "has_service": "service:" in cfg_text,
            "has_protocol_http2": "protocol: http2" in cfg_text,
            "line_count": len(cfg_text.splitlines()),
        },
    )
    # #endregion

    rc, out, err = run_cmd("launchctl print gui/$(id -u)/com.cloudflare.spacex-spread 2>/dev/null")
    # #region agent log
    emit(
        run_id,
        "H2",
        "tools/tunnel_probe.py:60",
        "launchctl job state snapshot",
        {
            "rc": rc,
            "state_running": "state = running" in out,
            "uses_config_flag": "--config" in out,
            "uses_http2_flag": "--protocol\n\t\thttp2" in out or "--protocol" in out and "http2" in out,
            "last_exit_never": "last exit code = (never exited)" in out,
            "stderr_present": bool(err),
        },
    )
    # #endregion

    err_log = Path("/tmp/cloudflared-spacex-spread.err.log")
    err_tail = "\n".join(err_log.read_text(encoding="utf-8", errors="ignore").splitlines()[-80:]) if err_log.exists() else ""
    # #region agent log
    emit(
        run_id,
        "H3",
        "tools/tunnel_probe.py:80",
        "tunnel edge connectivity errors",
        {
            "err_log_exists": err_log.exists(),
            "has_tls_eof": "TLS handshake with edge error: EOF" in err_tail,
            "has_quic_timeout": "failed to dial to edge with quic" in err_tail,
            "has_registered": "Registered tunnel connection" in err_tail,
        },
    )
    # #endregion

    try:
        s = requests.Session()
        s.trust_env = False
        r = s.get("http://127.0.0.1:8767/", timeout=5)
        origin_ok = r.status_code == 200
        origin_status = r.status_code
    except Exception as ex:  # pragma: no cover
        origin_ok = False
        origin_status = str(ex)
    # #region agent log
    emit(
        run_id,
        "H4",
        "tools/tunnel_probe.py:102",
        "origin server local health",
        {"origin_ok": origin_ok, "origin_status": origin_status},
    )
    # #endregion


if __name__ == "__main__":
    main()
