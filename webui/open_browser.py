"""Wait for the local DDSP Studio server and open it in the default browser.

This helper is launched by 启动WebUI.bat together with the server.  It does not
depend on ``webbrowser`` inside pythonw, which is unreliable on some Windows
setups; on Windows it uses ``os.startfile`` (the same path as double-clicking a
URL) and falls back to ``webbrowser`` and Explorer.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

WEBUI = Path(__file__).resolve().parent
ROOT = WEBUI.parent
for _p in (str(ROOT), str(WEBUI)):
    if _p not in sys.path:
        sys.path.insert(0, _p)
LOG_PATH = ROOT / "webui" / "logs" / "browser.log"
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

if sys.stdout is None:
    sys.stdout = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
if sys.stderr is None:
    sys.stderr = sys.stdout


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def read_runtime() -> dict | None:
    try:
        path = ROOT / "webui" / "runtime.json"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("port"):
                return data
    except Exception:
        pass
    return None


def ping(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/ping", timeout=0.2
        ) as response:
            data = json.loads(response.read().decode("utf-8"))
            return bool(data.get("ok")) and "DDSP Studio" in str(data.get("app", ""))
    except Exception:
        return False


def find_url() -> str | None:
    runtime = read_runtime()
    candidates = [7890]
    if runtime and runtime.get("port") and int(runtime["port"]) not in candidates:
        candidates.append(int(runtime["port"]))
    for port in range(7891, 7906):
        if port not in candidates:
            candidates.append(port)
    for port in candidates:
        if ping(port):
            return f"http://127.0.0.1:{port}/"
    return None


def browser_candidates() -> list[str]:
    paths = []
    for env_name in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        base = os.environ.get(env_name)
        if not base:
            continue
        paths.extend(
            [
                os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
                os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
            ]
        )
    paths = [p for p in paths if os.path.isfile(p)]
    # Prefer Chrome globally: if Edge has an elevated singleton running, a
    # normal Chrome process can still start with the dedicated profile.
    unique = list(dict.fromkeys(paths))
    return sorted(unique, key=lambda p: 1 if "msedge" in p.lower() else 0)


def is_admin() -> bool:
    if os.name != "nt":
        return False
    try:
        import ctypes

        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def profile_for(browser: str) -> Path:
    # Chrome and Edge use different profile formats/features; never let one
    # browser open a profile created by the other.  The WebUI directory is
    # writable even when the launcher is running inside a restricted sandbox;
    # %LOCALAPPDATA% may reject the browser's profile creation.
    name = "browser-profile-chrome" if "chrome" in Path(browser).name.lower() else "browser-profile-edge"
    return ROOT / "webui" / name


def browser_args(browser: str, url: str) -> list[str]:
    # Fallback only: isolated profile for environments where the normal
    # profile cannot be used.
    profile = profile_for(browser)
    return [
        browser,
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--no-proxy-server",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-features=msEdgeFirstRunExperience,msEdgeSidebarV2",
        "--new-window",
        url,
    ]


def direct_browser_args(browser: str, url: str) -> list[str]:
    # Use the normal browser profile, but a fresh window.  This avoids the
    # "profile directory access denied" failure and opens in the browser the
    # user is already using.
    return [
        browser,
        "--new-window",
        "--no-first-run",
        "--no-default-browser-check",
        url,
    ]


def wait_for_webui(seconds: int = 15) -> bool:
    """Wait until a browser window titled DDSP Studio exists."""
    try:
        import core

        return bool(core.focus_window("DDSP Studio", retries=max(1, seconds * 2), delay=0.5))
    except Exception:
        return False


def open_url(url: str) -> bool:
    """Open the WebUI in a browser window.

    Chrome is tried first.  Edge then uses a separate profile, which avoids
    joining an elevated Edge singleton.  The default Edge association is not
    used as a fallback because that is exactly what triggers Windows' "existing
    instance is elevated" dialog.
    """
    if os.name == "nt" and is_admin():
        try:
            subprocess.Popen(["explorer.exe", url], close_fds=True)
            return True
        except Exception as exc:
            log(f"explorer delegation failed: {exc}")

    candidates = browser_candidates()
    chrome = next((p for p in candidates if "chrome" in Path(p).name.lower()), None)
    if chrome:
        try:
            proc = subprocess.Popen(direct_browser_args(chrome, url), close_fds=True)
            log(f"launched Chrome pid={proc.pid} url={url}")
            if wait_for_webui(12):
                return True
            log(f"Chrome did not show the WebUI (exit={proc.poll()})")
        except Exception as exc:
            log(f"Chrome launch failed: {exc}")

    edge = next((p for p in candidates if "msedge" in Path(p).name.lower()), None)
    if edge:
        try:
            profile = profile_for(edge)
            profile.mkdir(parents=True, exist_ok=True)
            (profile / "First Run").touch(exist_ok=True)
            proc = subprocess.Popen(browser_args(edge, url), close_fds=True)
            log(f"launched Edge isolated profile pid={proc.pid} url={url}")
            if wait_for_webui(25):
                return True
            # A first Edge launch can take a while to initialize its network
            # service.  Ask the same profile to open the URL once more.
            log("Edge window did not show WebUI yet; retrying navigation")
            proc2 = subprocess.Popen(browser_args(edge, url), close_fds=True)
            log(f"retried Edge pid={proc2.pid} url={url}")
            if wait_for_webui(25):
                return True
            log(f"Edge did not show the WebUI (exit={proc.poll()},{proc2.poll()})")
        except Exception as exc:
            log(f"Edge isolated profile failed: {exc}")

    # Final fallback: normal Windows URL association.  This may show Edge's
    # "existing elevated instance" dialog, but it does open the page.
    try:
        subprocess.Popen(
            ["cmd.exe", "/c", "start", "", url],
            close_fds=True,
            creationflags=0x08000000,
        )
        log("opened through Windows shell (fallback)")
        return True
    except Exception as exc:
        log(f"shell fallback failed: {exc}")

    return False


def show_error(message: str) -> None:
    log(message)
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(
            0,
            message,
            "DDSP Studio",
            0x10,
        )
    except Exception:
        pass


def main() -> int:
    deadline = time.time() + 45
    url = None
    log("waiting for DDSP Studio server...")
    while time.time() < deadline:
        url = find_url()
        if url:
            break
        time.sleep(0.6)
    if not url:
        show_error(
            "WebUI 服务启动超时。\n\n"
            "请查看日志：\n"
            f"{LOG_PATH}\n"
            f"{ROOT / 'webui' / 'logs' / 'launcher.log'}\n\n"
            "也可以手动访问 http://127.0.0.1:7890/"
        )
        return 1
    log(f"opening {url}")
    if not open_url(url):
        show_error(
            "无法自动打开浏览器。\n\n"
            f"请手动访问：{url}\n\n"
            f"服务日志：{ROOT / 'webui' / 'logs' / 'server.log'}"
        )
        return 1
    # Best-effort: raise the browser if its window title is discoverable.
    try:
        import core

        core.focus_window("DDSP Studio", retries=8, delay=0.5)
    except Exception:
        pass
    log("browser open request sent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
