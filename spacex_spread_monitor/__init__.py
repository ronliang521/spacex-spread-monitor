launchctl stop com.cloudflare.spacex-spread 2>/dev/null || true
launchctl start com.cloudflare.spacex-spread
tail -n 60 /tmp/cloudflared-spacex-spread.err.log
tail -n 60 /tmp/cloudflared-spacex-spread.out.log__all__ = ["main"]

