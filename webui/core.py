"""Shared helpers for the DDSP Studio WebUI.

This module deliberately avoids importing torch at startup so the web server
opens instantly.  Heavy imports live inside the functions that need them.
"""
from __future__ import annotations

import ctypes
import datetime as _dt
import importlib.metadata as _metadata
import json
import math
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEBUI = ROOT / "webui"
STATIC = WEBUI / "static"
LOGS = WEBUI / "logs"
TASKS_LOG = LOGS / "tasks"
CACHE = ROOT / "cache"
RUNTIME_FILE = WEBUI / "runtime.json"
SETTINGS_FILE = WEBUI / "settings.json"
MODEL_LABELS_FILE = WEBUI / "model_labels.json"
MODEL_LABEL_META_FILE = WEBUI / "model_label_meta.json"

APP_NAME = "DDSP Studio"
APP_VERSION = "1.0.0"
START_TIME = time.time()

AUDIO_EXTS = {".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac", ".opus", ".wma"}
DATASET_EXTS = {".wav", ".flac"}

DEFAULT_SETTINGS = {
    "default_model": "",
    "default_device": "cuda",
    "default_pitch_extractor": "rmvpe",
    "default_infer_step": 50,
    "default_method": "euler",
    "default_t_start": 0.7,
    "output_template": "{stem}_{step}step_{key}key_{method}{infer_step}",
    "port": 7890,
    "auto_open_browser": True,
    "theme": "dark",
}

DEFAULT_CONFIG_FOR_MODEL = "configs/reflow-barbara.yaml"


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def ensure_dirs() -> None:
    for d in (LOGS, TASKS_LOG, CACHE):
        d.mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------
# Paths / names
# --------------------------------------------------------------------------
def resolve_inside(rel: str | os.PathLike, *, must_exist: bool = False) -> Path:
    """Resolve a user supplied path and make sure it stays inside ROOT."""
    raw = str(rel or "").replace("\\", "/").strip()
    if raw.startswith("/"):
        raw = raw.lstrip("/")
    candidate = (ROOT / raw).resolve()
    try:
        candidate.relative_to(ROOT)
    except ValueError:
        raise ApiError("非法路径：只能访问整合包目录内的文件", 403)
    if must_exist and not candidate.exists():
        raise ApiError(f"路径不存在：{raw}", 404)
    return candidate


def rel_to_root(path: Path | str) -> str:
    p = Path(path).resolve()
    try:
        return p.relative_to(ROOT).as_posix()
    except ValueError:
        return p.as_posix()


def sanitize_filename(name: str, fallback: str = "file") -> str:
    name = os.path.basename(str(name or "").replace("\\", "/"))
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip().strip(".")
    if not name:
        name = fallback
    stem, ext = os.path.splitext(name)
    reserved = {
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5",
        "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4",
        "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    }
    if stem.upper() in reserved:
        stem = "_" + stem
    stem = stem[:120] or fallback
    return stem + ext[:16]


def unique_path(directory: Path, filename: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    name = sanitize_filename(filename)
    stem, ext = os.path.splitext(name)
    candidate = directory / name
    i = 2
    while candidate.exists():
        candidate = directory / f"{stem}_{i}{ext}"
        i += 1
    return candidate


def human_size(num: float | int | None) -> str:
    if num is None:
        return "-"
    n = float(num)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} TB"


def fmt_duration(seconds: float | None) -> str:
    if seconds is None or (isinstance(seconds, float) and math.isnan(seconds)):
        return "-"
    s = int(round(float(seconds)))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{sec:02d}"
    return f"{m}:{sec:02d}"


# --------------------------------------------------------------------------
# Settings / runtime
# --------------------------------------------------------------------------
_settings_lock = threading.RLock()


def load_settings() -> dict:
    with _settings_lock:
        data = dict(DEFAULT_SETTINGS)
        try:
            if SETTINGS_FILE.exists():
                loaded = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data.update(loaded)
        except Exception:
            pass
        return data


def save_settings(updates: dict) -> dict:
    with _settings_lock:
        data = load_settings()
        for key, value in (updates or {}).items():
            if key in DEFAULT_SETTINGS:
                data[key] = value
        tmp = SETTINGS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, SETTINGS_FILE)
        return data


def write_runtime(port: int, pid: int | None = None) -> dict:
    data = {
        "app": APP_NAME,
        "version": APP_VERSION,
        "port": port,
        "pid": pid or os.getpid(),
        "url": f"http://127.0.0.1:{port}/",
        "started": _dt.datetime.now().isoformat(timespec="seconds"),
    }
    try:
        RUNTIME_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass
    return data


def read_runtime() -> dict | None:
    try:
        if RUNTIME_FILE.exists():
            data = json.loads(RUNTIME_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("port"):
                return data
    except Exception:
        pass
    return None


def clear_runtime() -> None:
    try:
        if RUNTIME_FILE.exists():
            RUNTIME_FILE.unlink()
    except Exception:
        pass


# --------------------------------------------------------------------------
# Network helpers
# --------------------------------------------------------------------------
def port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.35) -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def http_json(url: str, timeout: float = 1.0):
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def find_free_port(start: int, host: str = "127.0.0.1", tries: int = 30) -> int:
    for port in range(int(start), int(start) + tries):
        if port > 65535:
            break
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise ApiError("找不到可用端口，请关闭占用端口的程序后重试")


# --------------------------------------------------------------------------
# Process helpers
# --------------------------------------------------------------------------
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
CREATE_BREAKAWAY_FROM_JOB = 0x01000000 if os.name == "nt" else 0
CREATE_NEW_PROCESS_GROUP = 0x00000200 if os.name == "nt" else 0


def python_exe() -> str:
    exe = ROOT / "env" / "python.exe"
    return str(exe if exe.exists() else sys.executable)


def pythonw_exe() -> str:
    exe = ROOT / "env" / "pythonw.exe"
    return str(exe if exe.exists() else python_exe())


def job_env() -> dict:
    env = os.environ.copy()
    paths = [
        str(ROOT / "env" / "Scripts"),
        str(ROOT / "env" / "bin"),
        str(ROOT / "env"),
        str(ROOT / "ffmpeg" / "bin"),
    ]
    env["PATH"] = os.pathsep.join(paths + [env.get("PATH", "")])
    env["PYTHONPATH"] = os.pathsep.join([str(ROOT), env.get("PYTHONPATH", "")]).strip(os.pathsep)
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["MPLCONFIGDIR"] = str(CACHE / "matplotlib")
    env["NUMBA_CACHE_DIR"] = str(CACHE / "numba")
    env["HF_HOME"] = str(CACHE / "hf")
    env["TOKENIZERS_PARALLELISM"] = "false"
    env["KMP_DUPLICATE_LIB_OK"] = "TRUE"
    env.pop("PYTHONHOME", None)
    for d in (CACHE / "matplotlib", CACHE / "numba", CACHE / "hf"):
        try:
            d.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
    return env


def is_pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def kill_tree(pid: int | None) -> None:
    if not pid:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(int(pid)), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW,
                timeout=10,
            )
        else:
            os.kill(int(pid), 9)
    except Exception:
        pass


def is_admin() -> bool:
    """True when the current process token is elevated (administrator)."""
    if os.name != "nt":
        return False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


# --- Windows job object: kill the whole GUI tool tree reliably ------------
class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", ctypes.c_ulong),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_ulong),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_ulong),
        ("SchedulingClass", ctypes.c_ulong),
    ]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def assign_kill_job(pid: int | None):
    """Put a process in a job that kills every child when the job is closed."""
    if os.name != "nt" or not pid:
        return None
    kernel32 = ctypes.windll.kernel32
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        return None
    info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
    if not kernel32.SetInformationJobObject(
        job, 9, ctypes.byref(info), ctypes.sizeof(info)
    ):
        kernel32.CloseHandle(job)
        return None
    # PROCESS_SET_QUOTA | PROCESS_TERMINATE
    handle = kernel32.OpenProcess(0x0100 | 0x0001, False, int(pid))
    if not handle:
        kernel32.CloseHandle(job)
        return None
    ok = kernel32.AssignProcessToJobObject(job, handle)
    kernel32.CloseHandle(handle)
    if not ok:
        kernel32.CloseHandle(job)
        return None
    return job


def terminate_job(job) -> None:
    if not job:
        return
    try:
        ctypes.windll.kernel32.TerminateJobObject(job, 1)
    except Exception:
        pass
    try:
        ctypes.windll.kernel32.CloseHandle(job)
    except Exception:
        pass


def open_in_explorer(path: Path) -> None:
    """Open a directory in Explorer.

    ``os.startfile`` is the most natural API but can be blocked when the
    server was started from a restricted environment.  Launching Explorer
    directly works in both normal and restricted sessions, so try that first.
    """
    if os.name == "nt":
        try:
            subprocess.Popen(
                ["explorer.exe", str(path)],
                close_fds=True,
                creationflags=CREATE_BREAKAWAY_FROM_JOB,
            )
            return
        except Exception:
            try:
                subprocess.Popen(["explorer.exe", str(path)], close_fds=True)
                return
            except Exception:
                pass
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def focus_window(title_hint: str, retries: int = 8, delay: float = 0.5) -> bool:
    """Best-effort: restore and foreground a window whose title contains a hint.

    Runs in a background thread so a slow GUI startup never blocks the HTTP
    request that launched it.
    """
    if os.name != "nt" or not title_hint:
        return False
    import ctypes
    import time as _time

    user32 = ctypes.windll.user32
    hint = title_hint.lower()

    for _ in range(max(1, retries)):
        found = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        def callback(hwnd, _lparam):
            try:
                if not user32.IsWindowVisible(hwnd):
                    return True
                length = user32.GetWindowTextLengthW(hwnd)
                if length <= 0:
                    return True
                buffer = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buffer, length + 1)
                if hint in buffer.value.lower():
                    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                    try:
                        user32.BringWindowToTop(hwnd)
                        user32.SwitchToThisWindow(hwnd, True)
                    except Exception:
                        pass
                    try:
                        fg = user32.GetForegroundWindow()
                        fg_thread = user32.GetWindowThreadProcessId(fg, None)
                        target_thread = user32.GetWindowThreadProcessId(hwnd, None)
                        if fg_thread and target_thread and fg_thread != target_thread:
                            user32.AttachThreadInput(fg_thread, target_thread, True)
                            # A harmless Alt tap releases Windows' foreground
                            # lock in most desktop configurations.
                            user32.keybd_event(0x12, 0, 0, 0)
                            user32.keybd_event(0x12, 0, 2, 0)
                            user32.SetForegroundWindow(hwnd)
                            user32.AttachThreadInput(fg_thread, target_thread, False)
                        else:
                            user32.SetForegroundWindow(hwnd)
                    except Exception:
                        pass
                    # Windows may deny SetForegroundWindow while the browser
                    # owns the foreground lock.  Briefly raise the tool window
                    # above other windows so the user can actually see it.
                    try:
                        SWP_NOSIZE = 0x0001
                        SWP_NOMOVE = 0x0002
                        SWP_SHOWWINDOW = 0x0040
                        flags = SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW
                        user32.SetWindowPos(hwnd, ctypes.c_void_p(0), 0, 0, 0, 0, flags)  # HWND_TOP
                        user32.SetWindowPos(hwnd, ctypes.c_void_p(-1), 0, 0, 0, 0, flags)  # HWND_TOPMOST
                        _time.sleep(4.0)
                        user32.SetWindowPos(hwnd, ctypes.c_void_p(-2), 0, 0, 0, 0, flags)  # HWND_NOTOPMOST
                    except Exception:
                        pass
                    found.append(hwnd)
                    return False
            except Exception:
                pass
            return True

        user32.EnumWindows(callback, 0)
        if found:
            return True
        _time.sleep(delay)
    return False


# --------------------------------------------------------------------------
# System information
# --------------------------------------------------------------------------
def _ram_gb() -> float | None:
    try:
        if os.name == "nt":
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]
            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(stat)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return round(stat.ullTotalPhys / (1024 ** 3), 1)
    except Exception:
        pass
    return None


def _gpu_info() -> list[dict]:
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,driver_version",
                "--format=csv,noheader,nounits",
            ],
            text=True,
            timeout=4,
            creationflags=CREATE_NO_WINDOW,
            encoding="utf-8",
            errors="replace",
        )
        gpus = []
        for line in out.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 7:
                gpus.append(
                    {
                        "name": parts[0],
                        "vram_total_mb": _to_int(parts[1]),
                        "vram_used_mb": _to_int(parts[2]),
                        "vram_free_mb": _to_int(parts[3]),
                        "util_percent": _to_int(parts[4]),
                        "temp_c": _to_int(parts[5]),
                        "driver": parts[6],
                    }
                )
        return gpus
    except Exception:
        return []


def _to_int(value):
    try:
        return int(float(value))
    except Exception:
        return None


def _pkg_version(name: str) -> str | None:
    try:
        return _metadata.version(name)
    except Exception:
        return None


def system_info(port: int | None = None) -> dict:
    gpus = _gpu_info()
    disk = shutil.disk_usage(ROOT)
    return {
        "app": APP_NAME,
        "version": APP_VERSION,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "cpu_count": os.cpu_count(),
        "ram_gb": _ram_gb(),
        "gpus": gpus,
        "cuda_available": bool(gpus),
        "admin": is_admin(),
        "torch": _pkg_version("torch"),
        "torchaudio": _pkg_version("torchaudio"),
        "librosa": _pkg_version("librosa"),
        "soundfile": _pkg_version("soundfile"),
        "numpy": _pkg_version("numpy"),
        "root": str(ROOT),
        "port": port,
        "uptime_seconds": int(time.time() - START_TIME),
        "disk_total_gb": round(disk.total / (1024 ** 3), 1),
        "disk_free_gb": round(disk.free / (1024 ** 3), 1),
        "started": _dt.datetime.fromtimestamp(START_TIME).isoformat(timespec="seconds"),
    }


# --------------------------------------------------------------------------
# Audio / file metadata
# --------------------------------------------------------------------------
_audio_info_cache: dict[tuple, dict | None] = {}
_audio_cache_lock = threading.Lock()


def audio_info(path: Path) -> dict | None:
    try:
        st = path.stat()
    except OSError:
        return None
    key = (str(path), st.st_mtime_ns, st.st_size)
    with _audio_cache_lock:
        if key in _audio_info_cache:
            return _audio_info_cache[key]
    info = None
    try:
        import soundfile as sf  # local import, fast

        with sf.SoundFile(str(path)) as f:
            info = {
                "duration": round(len(f) / float(f.samplerate), 3) if f.samplerate else 0,
                "sample_rate": int(f.samplerate),
                "channels": int(f.channels),
                "frames": int(len(f)),
                "format": f.format,
                "subtype": f.subtype,
            }
    except Exception:
        try:
            import librosa

            y, sr = librosa.load(str(path), sr=None, mono=True, duration=1.0)
            info = {"duration": None, "sample_rate": int(sr), "channels": 1, "frames": None}
        except Exception:
            info = None
    with _audio_cache_lock:
        if len(_audio_info_cache) > 4096:
            _audio_info_cache.clear()
        _audio_info_cache[key] = info
    return info


def list_audio_files(directory: Path, extensions: set[str] | None = None) -> list[Path]:
    extensions = extensions or AUDIO_EXTS
    if not directory.exists():
        return []
    files = []
    for p in directory.rglob("*"):
        if p.is_file() and p.suffix.lower() in extensions:
            files.append(p)
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files


def dataset_entries(split: str) -> list[dict]:
    base = ROOT / "data" / split / "audio"
    entries = []
    for p in list_audio_files(base, DATASET_EXTS):
        info = audio_info(p) or {}
        st = p.stat()
        entries.append(
            {
                "rel": p.relative_to(base).as_posix(),
                "name": p.name,
                "size": st.st_size,
                "mtime": st.st_mtime,
                "duration": info.get("duration"),
                "sample_rate": info.get("sample_rate"),
                "channels": info.get("channels"),
            }
        )
    return entries


# --------------------------------------------------------------------------
# YAML helpers (comment preserving updates for the common parameters)
# --------------------------------------------------------------------------
def load_yaml(path: Path) -> dict:
    import yaml

    with open(path, "r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    return data or {}


def yaml_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def validate_yaml_text(text: str) -> dict:
    import yaml

    try:
        data = yaml.safe_load(text)
    except Exception as exc:
        raise ApiError(f"YAML 语法错误：{exc}")
    if not isinstance(data, dict):
        raise ApiError("配置文件内容必须是一个 YAML 字典")
    return data


def _yaml_scalar(value) -> str:
    import yaml

    dumped = yaml.safe_dump(value, allow_unicode=True, default_flow_style=True).strip()
    if dumped.endswith("\n..."):
        dumped = dumped[:-4].strip()
    if dumped.endswith("\n"):
        dumped = dumped[:-1]
    return dumped


def set_yaml_scalar(text: str, dotted: str, value) -> str:
    """Replace one scalar in a YAML document while keeping comments/order.

    Only the simple nested mapping structure used by DDSP configs is needed.
    """
    parts = str(dotted).split(".")
    lines = text.splitlines()
    idx = 0
    indent = 0
    for part in parts[:-1]:
        found = None
        for i in range(idx, len(lines)):
            m = re.match(r"^(\s*)([A-Za-z0-9_\-]+):", lines[i])
            if not m:
                continue
            cur_indent = len(m.group(1))
            if cur_indent < indent:
                break
            if cur_indent == indent and m.group(2) == part:
                found = i
                break
        if found is None:
            raise ApiError(f"配置中找不到字段：{'.'.join(parts[:-1])}")
        idx = found + 1
        indent += 2
    key = parts[-1]
    pattern = re.compile(r"^(\s*)" + re.escape(key) + r":(.*)$")
    for i in range(idx, len(lines)):
        m = pattern.match(lines[i])
        if not m:
            if lines[i].strip() and len(lines[i]) - len(lines[i].lstrip()) < indent:
                break
            continue
        cur_indent = len(m.group(1))
        if cur_indent != indent:
            continue
        rest = m.group(2)
        comment = ""
        # Keep an inline comment (good enough for the DDSP configs).
        hash_pos = None
        quote = None
        for pos, ch in enumerate(rest):
            if ch in ("'", '"'):
                if quote is None:
                    quote = ch
                elif quote == ch:
                    quote = None
            elif ch == "#" and quote is None and (pos == 0 or rest[pos - 1] in " \t"):
                hash_pos = pos
                break
        if hash_pos is not None:
            comment_start = hash_pos
            while comment_start > 0 and rest[comment_start - 1] in " \t":
                comment_start -= 1
            comment = rest[comment_start:]
        new_line = " " * indent + key + ": " + _yaml_scalar(value) + comment
        lines[i] = new_line
        out = "\n".join(lines)
        if text.endswith("\n"):
            out += "\n"
        # validate result
        import yaml

        yaml.safe_load(out)
        return out
    # Key not present (e.g. an older/custom config): append it at the end of
    # the section instead of failing the whole save.
    insert_at = len(lines)
    for i in range(idx, len(lines)):
        line = lines[i]
        if not line.strip():
            continue
        cur_indent = len(line) - len(line.lstrip())
        if cur_indent < indent:
            insert_at = i
            break
    lines.insert(insert_at, " " * indent + key + ": " + _yaml_scalar(value))
    out = "\n".join(lines)
    if text.endswith("\n"):
        out += "\n"
    import yaml

    yaml.safe_load(out)
    return out


def update_yaml_file(path: Path, updates: dict) -> str:
    text = yaml_text(path)
    for dotted, value in (updates or {}).items():
        text = set_yaml_scalar(text, dotted, value)
    validate_yaml_text(text)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
    return text


# --------------------------------------------------------------------------
# Model display labels
# --------------------------------------------------------------------------
_labels_lock = threading.RLock()


def load_model_labels() -> dict:
    with _labels_lock:
        labels: dict[str, str] = {}
        try:
            if MODEL_LABELS_FILE.exists():
                data = json.loads(MODEL_LABELS_FILE.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    labels = {str(k): str(v) for k, v in data.items() if str(v).strip()}
        except Exception:
            return {}
        if labels:
            labels = _drop_stale_labels(labels)
        return labels


def _load_label_meta() -> dict:
    try:
        if MODEL_LABEL_META_FILE.exists():
            data = json.loads(MODEL_LABEL_META_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _save_label_meta(meta: dict) -> None:
    try:
        tmp = MODEL_LABEL_META_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, MODEL_LABEL_META_FILE)
    except Exception:
        pass


def _label_record_matches(rel: str, record: dict) -> bool:
    """Does the stored name still describe the weights currently on disk?

    Size alone is not enough: two checkpoints saved at the same step have the
    exact same byte size, so a new model that re-uses a file name such as
    ``model_100.pt`` would silently inherit the old display name.  The file's
    modification time is stored next to the name and compared as well.

    Records written by older versions have no timestamp; for those the label
    file's own modification time is used as a rough "named at" marker.
    """
    path = ROOT / rel
    try:
        stat = path.stat()
    except OSError:
        # The weight file is gone: keep the name in case it comes back.
        return True
    if record.get("size") is not None:
        try:
            if int(record["size"]) != stat.st_size:
                return False
        except (TypeError, ValueError):
            pass
    recorded_mtime = record.get("mtime")
    if recorded_mtime is None:
        try:
            named_at = MODEL_LABELS_FILE.stat().st_mtime
        except OSError:
            return True
        return stat.st_mtime <= named_at + 0.01
    try:
        return abs(stat.st_mtime - float(recorded_mtime)) <= 0.01
    except (TypeError, ValueError):
        return True


def _drop_stale_labels(labels: dict) -> dict:
    """Ignore names whose weight file was replaced by a different model."""
    meta = _load_label_meta()
    if not meta:
        return labels
    valid = {}
    for rel, label in labels.items():
        record = meta.get(rel)
        if not isinstance(record, dict) or _label_record_matches(rel, record):
            valid[rel] = label
    return valid


def label_is_current(model_rel: str) -> bool:
    """True when the stored name was recorded for the file currently on disk."""
    meta = _load_label_meta()
    record = meta.get(model_rel)
    if not isinstance(record, dict):
        return False
    return _label_record_matches(model_rel, record)


def _write_labels(labels: dict, meta: dict) -> None:
    tmp = MODEL_LABELS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(labels, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, MODEL_LABELS_FILE)
    _save_label_meta(meta)


def unique_model_label(base: str, exclude_rel: str | None = None, include_history: bool = False) -> str:
    """Return a display name that no other model is using.

    A duplicate gets ``_1``, ``_2`` … appended, matching how checkpoints are
    numbered (``model_2000_2.pt``).  With ``include_history`` names of deleted
    or replaced checkpoints are reserved too, so a fresh training run never
    re-uses an old name by accident.
    """
    base = str(base or "").strip()[:60]
    if not base:
        return ""
    used = set()
    for rel, label in load_model_labels().items():
        if exclude_rel and rel == exclude_rel:
            continue
        used.add(label)
    if include_history:
        try:
            raw = json.loads(MODEL_LABELS_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                used.update(str(v) for v in raw.values() if str(v).strip())
        except Exception:
            pass
    if base not in used:
        return base
    index = 1
    while True:
        candidate = f"{base[:56]}_{index}"
        if candidate not in used:
            return candidate
        index += 1


def move_model_label(old_rel: str, new_rel: str) -> None:
    """Keep the display name when a weight file is renamed."""
    with _labels_lock:
        labels = load_model_labels()
        meta = _load_label_meta()
        if old_rel in labels:
            labels[new_rel] = labels.pop(old_rel)
        if old_rel in meta:
            meta[new_rel] = meta.pop(old_rel)
        _write_labels(labels, meta)


def set_model_label(model_rel: str, label: str) -> str:
    label = str(label or "").strip()[:60]
    with _labels_lock:
        labels = load_model_labels()
        meta = _load_label_meta()
        if label:
            labels[model_rel] = label
            path = ROOT / model_rel
            try:
                stat = path.stat()
                meta[model_rel] = {"size": stat.st_size, "mtime": round(stat.st_mtime, 3)}
            except OSError:
                meta.pop(model_rel, None)
        else:
            labels.pop(model_rel, None)
            meta.pop(model_rel, None)
        _write_labels(labels, meta)
    return label


# --------------------------------------------------------------------------
# Model helpers
# --------------------------------------------------------------------------
def ensure_model_config(model_path: Path, base_rel: str = DEFAULT_CONFIG_FOR_MODEL) -> tuple[bool, str]:
    cfg = model_path.parent / "config.yaml"
    if cfg.exists():
        return False, "配置已存在"
    base = resolve_inside(base_rel, must_exist=True)
    shutil.copyfile(base, cfg)
    return True, f"已从 {base_rel} 生成 config.yaml"


def model_config_info(model_path: Path) -> dict:
    cfg = model_path.parent / "config.yaml"
    if not cfg.exists():
        return {"has_config": False}
    try:
        data = load_yaml(cfg)
        return {
            "has_config": True,
            "sampling_rate": (data.get("data") or {}).get("sampling_rate"),
            "encoder": (data.get("data") or {}).get("encoder"),
            "n_spk": (data.get("model") or {}).get("n_spk"),
            "vocoder": (data.get("vocoder") or {}).get("ckpt"),
            "model_type": (data.get("model") or {}).get("type"),
            "t_start": (data.get("model") or {}).get("t_start"),
        }
    except Exception as exc:
        return {"has_config": True, "config_error": str(exc)}


def list_models(settings: dict | None = None) -> list[dict]:
    settings = settings or load_settings()
    default_model = settings.get("default_model") or ""
    labels = load_model_labels()
    models = []
    exp = ROOT / "exp"
    if not exp.exists():
        return models
    for p in exp.rglob("*.pt"):
        if not p.is_file():
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        rel = rel_to_root(p)
        m = re.search(r"model_(\d+)", p.stem)
        step = int(m.group(1)) if m else None
        cfg = model_config_info(p)
        models.append(
            {
                "rel": rel,
                "name": p.name,
                "exp": rel_to_root(p.parent),
                "step": step,
                "size": st.st_size,
                "mtime": st.st_mtime,
                "is_default": rel == default_model,
                "has_config": cfg.get("has_config", False),
                "label": labels.get(rel, ""),
                **cfg,
            }
        )
    models.sort(key=lambda m: (m["exp"], -(m["step"] if m["step"] is not None else -1)))
    return models


def model_step(model_rel: str) -> str:
    m = re.search(r"model_(\d+)", Path(model_rel).stem)
    return m.group(1) if m else Path(model_rel).stem


def render_output_name(template: str, *, stem: str, model: str, key, v, f, method, infer_step, t_start) -> str:
    now = _dt.datetime.now()
    values = {
        "stem": stem,
        "model": model,
        "step": model_step(model),
        "key": _compact_number(key),
        "v": _compact_number(v),
        "f": _compact_number(f),
        "method": method,
        "infer_step": str(infer_step),
        "t_start": _compact_number(t_start),
        "date": now.strftime("%Y%m%d"),
        "time": now.strftime("%H%M%S"),
    }
    name = template or DEFAULT_SETTINGS["output_template"]
    try:
        name = name.format(**values)
    except Exception:
        name = f"{stem}_{values['model']}_{values['key']}key_{method}{infer_step}"
    name = sanitize_filename(name)
    if not name.lower().endswith(".wav"):
        name += ".wav"
    return name


def _compact_number(value) -> str:
    try:
        f = float(value)
        if f.is_integer():
            return str(int(f))
        return ("%.3f" % f).rstrip("0").rstrip(".")
    except Exception:
        return str(value)


# --------------------------------------------------------------------------
# Misc
# --------------------------------------------------------------------------
def now_iso() -> str:
    return _dt.datetime.now().isoformat(timespec="seconds")


def safe_json_dump(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
