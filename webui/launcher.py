"""One-click launcher for the DDSP Studio WebUI.

Designed to be started with pythonw.exe so no console window appears.
If the server is already running, it simply opens the browser again.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

WEBUI = Path(__file__).resolve().parent
ROOT = WEBUI.parent
for _p in (str(ROOT), str(WEBUI)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

(ROOT / "webui" / "logs").mkdir(parents=True, exist_ok=True)
_LOG_PATH = ROOT / "webui" / "logs" / "launcher.log"

# pythonw.exe gives us None for stdout/stderr; libraries like torch print a lot.
if sys.stdout is None:
    sys.stdout = open(_LOG_PATH, "a", encoding="utf-8", buffering=1)
if sys.stderr is None:
    sys.stderr = sys.stdout


def open_url(url: str) -> bool:
    """Open a URL reliably, including from pythonw.exe.

    An elevated process cannot start Edge/Chrome (Chromium blocks elevated
    runs), so delegate to Explorer in that case.
    """
    try:
        import ctypes

        if os.name == "nt" and ctypes.windll.shell32.IsUserAnAdmin():
            subprocess.Popen(["explorer.exe", url], close_fds=True)
            return True
    except Exception:
        pass
    try:
        if os.name == "nt":
            os.startfile(url)  # type: ignore[attr-defined]
            return True
    except Exception:
        pass
    try:
        return bool(webbrowser.open(url, new=2))
    except Exception:
        return False


def existing_server_url() -> str | None:
    try:
        import core

        runtime = core.read_runtime()
        if not runtime:
            return None
        port = int(runtime.get("port") or 0)
        if not port:
            return None
        try:
            ping = core.http_json(f"http://127.0.0.1:{port}/api/ping", timeout=1.2)
        except Exception:
            return None
        if ping.get("app") and ping.get("ok"):
            return f"http://127.0.0.1:{port}/"
    except Exception:
        return None
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--console", action="store_true")
    args = parser.parse_args()

    import core

    url = existing_server_url()
    if url:
        print(f"已在运行：{url}")
        if not args.no_browser:
            open_url(url)
        return 0

    # Remove a stale runtime file before starting.
    core.clear_runtime()

    import app

    print(f"启动 {core.APP_NAME}… 日志：{_LOG_PATH}")
    app.run(
        host="127.0.0.1",
        port=args.port,
        open_browser=not args.no_browser,
        console=args.console,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        import traceback

        traceback.print_exc()
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(
                0,
                f"DDSP Studio 启动失败：\n{exc}\n\n详细日志：\n{_LOG_PATH}",
                "DDSP Studio",
                0x10,
            )
        except Exception:
            pass
        time.sleep(2)
        raise SystemExit(1)
