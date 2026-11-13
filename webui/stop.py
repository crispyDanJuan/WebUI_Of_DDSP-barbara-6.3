"""Stop the running DDSP Studio WebUI (called by 停止WebUI.bat)."""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

WEBUI = Path(__file__).resolve().parent
ROOT = WEBUI.parent
if str(WEBUI) not in sys.path:
    sys.path.insert(0, str(WEBUI))
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def post_shutdown(port: int) -> bool:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/shutdown",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            resp.read()
        return True
    except Exception:
        return False


def main() -> int:
    import core

    runtime = core.read_runtime()
    if not runtime:
        print("DDSP WebUI 没有在运行（未找到 runtime.json）。")
        return 0
    port = int(runtime.get("port") or 0)
    if not port:
        print("runtime.json 中没有端口信息。")
        return 1
    print(f"正在关闭 DDSP WebUI（端口 {port}）…")
    if post_shutdown(port):
        # Wait for the process to exit.
        for _ in range(20):
            time.sleep(0.2)
            if not core.port_open(port):
                print("已关闭。")
                return 0
        print("关闭请求已发送。")
        return 0
    pid = runtime.get("pid")
    if pid:
        print("接口无响应，尝试直接结束进程…")
        core.kill_tree(int(pid))
        try:
            core.clear_runtime()
        except Exception:
            pass
        print("已结束。")
        return 0
    print("无法关闭服务，请打开任务管理器结束 pythonw.exe。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
