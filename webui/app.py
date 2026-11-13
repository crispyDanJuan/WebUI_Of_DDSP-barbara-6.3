"""
DDSP Studio - a local, dependency-free WebUI for the DDSP-barbara-6.3 pack.

Run with:  env\\python.exe webui\\app.py --port 7890
or launch the one-click 启动WebUI.bat.
"""
from __future__ import annotations

import argparse
import json
import logging
import logging.handlers
import mimetypes
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_WEBUI_DIR = Path(__file__).resolve().parent
_ROOT_DIR = _WEBUI_DIR.parent
for _p in (str(_ROOT_DIR), str(_WEBUI_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import core
import inference
import tasks

LOG = logging.getLogger("ddsp.webui")
HTTPD = None
STATE_LOCK = threading.RLock()
STATE = {
    "tensorboard": None,  # {task_id, port, url, started}
}
TOOL_PROCS: dict[str, dict] = {}

MAX_JSON = 8 * 1024 * 1024
MAX_UPLOAD = 8 * 1024 ** 3


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
def setup_logging(console: bool = True) -> None:
    core.ensure_dirs()
    LOG.setLevel(logging.INFO)
    LOG.handlers.clear()
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    file_handler = logging.handlers.RotatingFileHandler(
        core.LOGS / "server.log", maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)
    LOG.addHandler(file_handler)
    if console and sys.stderr is not None:
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(fmt)
        LOG.addHandler(stream)
    LOG.propagate = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def qget(query: dict, key: str, default=None):
    values = query.get(key)
    return values[0] if values else default


def json_body(handler) -> dict:
    cached = getattr(handler, "_body_bytes", None)
    if cached is not None:
        if not cached:
            return {}
        try:
            data = json.loads(cached.decode("utf-8"))
        except Exception:
            raise core.ApiError("请求数据格式错误（需要 JSON）")
        if not isinstance(data, dict):
            raise core.ApiError("请求数据必须是 JSON 对象")
        return data
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        return {}
    if length > MAX_JSON:
        raise core.ApiError("请求体过大", 413)
    raw = handler.rfile.read(length)
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        raise core.ApiError("请求数据格式错误（需要 JSON）")
    if not isinstance(data, dict):
        raise core.ApiError("请求数据必须是 JSON 对象")
    return data


def ensure_no_heavy() -> None:
    active = tasks.manager.active_heavy()
    if active:
        raise core.ApiError(f"“{active.title}”正在运行，请等待完成或先取消该任务", 409)


def tool_log_path(name: str) -> Path:
    directory = core.LOGS / "tools"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{name}.log"


def start_tool_process(name: str, args: list[str]) -> dict:
    with STATE_LOCK:
        current = TOOL_PROCS.get(name)
        if current and core.is_pid_alive(current.get("pid")):
            return {"running": True, "pid": current["pid"], "already": True}
        log_path = tool_log_path(name)
        log_file = open(log_path, "a", encoding="utf-8", errors="replace")
        log_file.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} start: {' '.join(args)} ===\n")
        log_file.flush()
        env = core.job_env()
        # Nuitka one-file tools (and some Python temp users) fail if TEMP points
        # to a location this process cannot write.  Use a workspace temp dir.
        tool_tmp = core.WEBUI / "tmp" / "tools"
        tool_tmp.mkdir(parents=True, exist_ok=True)
        env["TMP"] = str(tool_tmp)
        env["TEMP"] = str(tool_tmp)
        proc = subprocess.Popen(
            [str(a) for a in args],
            cwd=str(core.ROOT),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            creationflags=0,
        )
        job = core.assign_kill_job(proc.pid)
        time.sleep(0.7)
        if proc.poll() is not None:
            try:
                log_file.close()
            except Exception:
                pass
            TOOL_PROCS.pop(name, None)
            raise core.ApiError(f"程序启动后立即退出，请查看日志：{core.rel_to_root(log_path)}")
        TOOL_PROCS[name] = {
            "proc": proc,
            "pid": proc.pid,
            "job": job,
            "started": time.time(),
            "log": core.rel_to_root(log_path),
            "log_file": log_file,
        }
        hint = {"realtime": "DDSP - GUI", "toolkit": "音频工具箱"}.get(name, "")
        if hint:
            threading.Thread(
                target=core.focus_window, args=(hint,), kwargs={"retries": 12, "delay": 0.5}, daemon=True
            ).start()
        return {"running": True, "pid": proc.pid, "already": False}


def stop_tool_process(name: str) -> None:
    with STATE_LOCK:
        current = TOOL_PROCS.get(name)
        if not current:
            return
        proc = current.get("proc")
        pid = current.get("pid")
        core.kill_tree(pid)
        core.terminate_job(current.get("job"))
        # Ask the process to exit first; this works even when taskkill is
        # restricted by the parent process environment.
        try:
            if proc is not None and proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=2)
        except Exception:
            pass
        try:
            if proc is not None and proc.poll() is None:
                proc.kill()
        except Exception:
            pass
        time.sleep(0.4)
        if core.is_pid_alive(pid):
            raise core.ApiError(
                "进程仍在运行，无法自动停止。请到任务管理器结束该程序，"
                f"或查看日志：{current.get('log')}"
            )
        try:
            current.get("log_file").close()
        except Exception:
            pass
        TOOL_PROCS.pop(name, None)


def tool_status(name: str) -> dict:
    with STATE_LOCK:
        current = TOOL_PROCS.get(name)
    if not current:
        return {"running": False, "pid": None}
    proc = current.get("proc")
    alive = core.is_pid_alive(current.get("pid"))
    if proc is not None and proc.poll() is not None:
        alive = False
    return {
        "running": bool(alive),
        "pid": current.get("pid") if alive else None,
        "started": current.get("started"),
        "log": current.get("log"),
    }


def cleanup_all() -> None:
    try:
        tasks.manager.cancel_all()
    except Exception:
        pass
    for name in list(TOOL_PROCS.keys()):
        try:
            stop_tool_process(name)
        except Exception:
            pass
    try:
        inference.engine.unload()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# API: system / settings
# ---------------------------------------------------------------------------
def api_ping(handler, query):
    return {
        "ok": True,
        "app": core.APP_NAME,
        "version": core.APP_VERSION,
        "pid": os.getpid(),
        "port": handler.server.server_port,
        "url": f"http://127.0.0.1:{handler.server.server_port}/",
    }


def api_system(handler, query):
    info = core.system_info(port=handler.server.server_port)
    info["inference"] = inference.engine.status()
    info["tasks_running"] = len([t for t in tasks.manager.list(100) if t["status"] == "running"])
    return info


def api_settings_get(handler, query):
    return {"settings": core.load_settings(), "defaults": core.DEFAULT_SETTINGS}


def api_settings_set(handler, query):
    body = json_body(handler)
    updates = body.get("settings") if isinstance(body.get("settings"), dict) else body
    settings = core.save_settings(updates or {})
    return {"ok": True, "settings": settings}


def api_shutdown(handler, query):
    def shutdown():
        time.sleep(0.4)
        LOG.info("Shutdown requested from WebUI")
        cleanup_all()
        core.clear_runtime()
        if HTTPD is not None:
            HTTPD.shutdown()

    threading.Thread(target=shutdown, daemon=True).start()
    return {"ok": True, "message": "服务正在关闭"}


def api_browse(handler, query):
    """List a project directory for the built-in folder browser."""
    body = json_body(handler)
    target = body.get("target")
    rel = body.get("path")
    mapping = {
        "root": core.ROOT,
        "raw": core.ROOT / "raw",
        "results": core.ROOT / "results",
        "exp": core.ROOT / "exp",
        "data": core.ROOT / "data",
        "logs": core.LOGS,
        "cache": core.CACHE,
        "configs": core.ROOT / "configs",
        "webui": core.WEBUI,
    }
    if rel:
        path = core.resolve_inside(rel, must_exist=True)
    elif target and target in mapping:
        path = mapping[target]
    else:
        raise core.ApiError("缺少要打开的目录")
    path.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        path = path.parent
    entries = []
    try:
        children = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError as exc:
        raise core.ApiError(f"无法读取目录：{exc}") from exc
    for child in children[:1000]:
        try:
            stat = child.stat()
            entries.append({
                "name": child.name,
                "rel": core.rel_to_root(child),
                "dir": child.is_dir(),
                "size": stat.st_size,
                "mtime": stat.st_mtime,
            })
        except OSError:
            continue
    return {
        "ok": True,
        "path": str(path),
        "rel": core.rel_to_root(path),
        "parent": core.rel_to_root(path.parent) if path != core.ROOT else None,
        "entries": entries,
    }


def api_open(handler, query):
    body = json_body(handler)
    target = body.get("target")
    rel = body.get("path")
    mapping = {
        "root": core.ROOT,
        "raw": core.ROOT / "raw",
        "results": core.ROOT / "results",
        "exp": core.ROOT / "exp",
        "data": core.ROOT / "data",
        "logs": core.LOGS,
        "cache": core.CACHE,
        "configs": core.ROOT / "configs",
        "webui": core.WEBUI,
    }
    if target and target in mapping:
        path = mapping[target]
    elif rel:
        path = core.resolve_inside(rel, must_exist=True)
    else:
        raise core.ApiError("缺少要打开的目录")
    try:
        if path.is_file():
            if os.name == "nt":
                try:
                    subprocess.Popen(
                        ["explorer", f"/select,{path}"],
                        close_fds=True,
                        creationflags=core.CREATE_BREAKAWAY_FROM_JOB,
                    )
                except Exception:
                    subprocess.Popen(["explorer", f"/select,{path}"])
            else:
                core.open_in_explorer(path.parent)
            return {"ok": True, "opened": True, "path": str(path)}
        path.mkdir(parents=True, exist_ok=True)
        core.open_in_explorer(path)
        return {"ok": True, "opened": True, "path": str(path)}
    except Exception as exc:
        # The browser side falls back to its built-in folder browser, which
        # keeps working even when Explorer is blocked by the sandbox.
        LOG.warning("explorer could not open %s: %s", path, exc)
        return {"ok": True, "opened": False, "path": str(path), "error": str(exc)}


# ---------------------------------------------------------------------------
# API: tasks
# ---------------------------------------------------------------------------
def api_tasks(handler, query):
    return {"tasks": tasks.manager.list(int(qget(query, "limit", 50) or 50))}


def api_task(handler, query):
    task = tasks.manager.get(qget(query, "id", ""))
    if not task:
        raise core.ApiError("任务不存在", 404)
    return {"task": task.to_dict(include_recent=True)}


def api_task_log(handler, query):
    task_id = qget(query, "id", "")
    offset = int(qget(query, "offset", 0) or 0)
    tail = str(qget(query, "tail", "0")) in ("1", "true", "yes")
    return tasks.read_log(task_id, offset=offset, tail=tail)


def api_task_cancel(handler, query):
    body = json_body(handler)
    task = tasks.manager.cancel(body.get("id", ""))
    if not task:
        raise core.ApiError("任务不存在", 404)
    return {"ok": True, "task": task.to_dict()}


def api_task_clear(handler, query):
    body = json_body(handler)
    task_id = body.get("id")
    with tasks.manager._lock:  # noqa: SLF001 - internal by design
        if task_id:
            task = tasks.manager._tasks.get(task_id)
            if task and task.status not in ("running", "queued"):
                tasks.manager._tasks.pop(task_id, None)
        else:
            for key, task in list(tasks.manager._tasks.items()):
                if task.status not in ("running", "queued"):
                    tasks.manager._tasks.pop(key, None)
    return {"ok": True}


# ---------------------------------------------------------------------------
# API: files / uploads
# ---------------------------------------------------------------------------
def api_upload(handler, query):
    target = (qget(query, "target", "raw") or "raw").lower()
    filename = qget(query, "name", "") or "upload.bin"
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        raise core.ApiError("没有收到文件内容")
    if length > MAX_UPLOAD:
        raise core.ApiError("文件过大（上限 8GB）", 413)
    filename = core.sanitize_filename(filename)

    warnings: list[str] = []
    if target == "raw":
        ext = Path(filename).suffix.lower()
        if ext not in core.AUDIO_EXTS:
            raise core.ApiError("不支持的音频格式，请使用 WAV / FLAC / MP3 / OGG")
        dest_dir = core.ROOT / "raw"
    elif target == "dataset":
        ext = Path(filename).suffix.lower()
        if ext not in core.DATASET_EXTS:
            raise core.ApiError("训练数据只支持 WAV / FLAC（建议 44.1kHz、16bit、单声道）")
        split = (qget(query, "split", "train") or "train").lower()
        if split not in ("train", "val"):
            raise core.ApiError("split 必须是 train 或 val")
        spk = (qget(query, "spk", "") or "").strip()
        if spk and not re.fullmatch(r"[0-9]+", spk):
            raise core.ApiError("说话人目录必须是不大于 n_spk 的正整数")
        dest_dir = core.ROOT / "data" / split / "audio"
        if spk:
            dest_dir = dest_dir / spk
    elif target == "model":
        ext = Path(filename).suffix.lower()
        if ext not in (".pt", ".ckpt", ".pth"):
            raise core.ApiError("模型文件必须是 .pt 文件")
        exp_dir = (qget(query, "exp", "reflow-test") or "reflow-test").strip().replace("\\", "/")
        if ".." in exp_dir or exp_dir.startswith("/"):
            raise core.ApiError("非法的模型目录")
        dest_dir = core.resolve_inside(f"exp/{exp_dir}")
        dest_dir.mkdir(parents=True, exist_ok=True)
    else:
        raise core.ApiError("未知的上传目标")

    dest_dir.mkdir(parents=True, exist_ok=True)
    final_path = core.unique_path(dest_dir, filename)
    part_path = final_path.with_name(final_path.name + ".part")
    received = 0
    try:
        with open(part_path, "wb") as fh:
            remaining = length
            while remaining > 0:
                chunk = handler.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise core.ApiError("上传中断，请重试")
                fh.write(chunk)
                received += len(chunk)
                remaining -= len(chunk)
        os.replace(part_path, final_path)
    except Exception:
        try:
            part_path.unlink(missing_ok=True)
        except Exception:
            pass
        if received < length:
            raise
        raise
    if received != length:
        try:
            final_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise core.ApiError("上传未完成，请重试")

    # The default training config only collects .wav files.  Normalise dataset
    # uploads so that FLAC / upper-case extensions are not silently skipped.
    if target == "dataset":
        if final_path.suffix.lower() == ".flac":
            try:
                import soundfile as sf

                audio_data, sample_rate = sf.read(str(final_path), dtype="float32", always_2d=True)
                wav_path = core.unique_path(dest_dir, final_path.stem + ".wav")
                sf.write(str(wav_path), audio_data, sample_rate, subtype="PCM_16")
                final_path.unlink()
                final_path = wav_path
                warnings.append("FLAC 已自动转换为 WAV")
            except Exception as exc:
                try:
                    final_path.unlink(missing_ok=True)
                except Exception:
                    pass
                raise core.ApiError(f"FLAC 转 WAV 失败：{exc}")
        elif final_path.suffix != ".wav" and final_path.suffix.lower() == ".wav":
            wav_path = core.unique_path(dest_dir, final_path.stem + ".wav")
            os.replace(final_path, wav_path)
            final_path = wav_path

    result = {
        "ok": True,
        "rel": core.rel_to_root(final_path),
        "name": final_path.name,
        "size": final_path.stat().st_size,
        "target": target,
    }
    if target in ("raw", "dataset"):
        info = core.audio_info(final_path)
        result["audio"] = info
        if info:
            if info.get("sample_rate") and int(info["sample_rate"]) != 44100:
                warnings.append(
                    f"采样率是 {info['sample_rate']} Hz，训练/推理建议 44100 Hz（预处理会重采样，但速度较慢）"
                )
            if info.get("channels") and int(info["channels"]) != 1:
                warnings.append("音频不是单声道，预处理时会自动转单声道")
    if target == "model":
        created, message = core.ensure_model_config(final_path)
        result["config_created"] = created
        result["config_message"] = message
    result["warnings"] = warnings
    return result


def api_file(handler, query):
    rel = qget(query, "path", "")
    if not rel:
        raise core.ApiError("缺少文件路径")
    path = core.resolve_inside(rel, must_exist=True)
    if path.is_dir():
        raise core.ApiError("这是一个目录")
    download = str(qget(query, "download", "0")) in ("1", "true", "yes")
    handler.serve_file(path, download=download)


# ---------------------------------------------------------------------------
# API: models / configs
# ---------------------------------------------------------------------------
def api_models(handler, query):
    settings = core.load_settings()
    models = core.list_models(settings)
    return {
        "models": models,
        "default_model": settings.get("default_model"),
        "exp_dirs": sorted({m["exp"] for m in models}),
    }


def api_model_config_get(handler, query):
    model_rel = qget(query, "model", "")
    model_path = core.resolve_inside(model_rel, must_exist=True)
    cfg = model_path.parent / "config.yaml"
    if not cfg.exists():
        return {"exists": False, "text": "", "path": core.rel_to_root(cfg)}
    return {"exists": True, "text": cfg.read_text(encoding="utf-8"), "path": core.rel_to_root(cfg)}


def api_model_config_save(handler, query):
    body = json_body(handler)
    model_path = core.resolve_inside(body.get("model", ""), must_exist=True)
    text = str(body.get("text") or "")
    core.validate_yaml_text(text)
    cfg = model_path.parent / "config.yaml"
    tmp = cfg.with_suffix(".yaml.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, cfg)
    return {"ok": True, "path": core.rel_to_root(cfg)}


def api_model_ensure_config(handler, query):
    body = json_body(handler)
    model_path = core.resolve_inside(body.get("model", ""), must_exist=True)
    base = str(body.get("base") or core.DEFAULT_CONFIG_FOR_MODEL)
    base_path = core.resolve_inside(base, must_exist=True)
    if base_path.parent != (core.ROOT / "configs"):
        raise core.ApiError("基础配置必须位于 configs 目录")
    created, message = core.ensure_model_config(model_path, base)
    return {"ok": True, "created": created, "message": message}


def api_model_delete(handler, query):
    ensure_no_heavy()
    body = json_body(handler)
    model_path = core.resolve_inside(body.get("model", ""), must_exist=True)
    if model_path.suffix.lower() not in (".pt", ".ckpt", ".pth"):
        raise core.ApiError("只能删除模型权重文件")
    try:
        model_path.relative_to(core.ROOT / "exp")
    except ValueError:
        raise core.ApiError("只能删除 exp 目录中的模型")
    if inference.engine.status().get("model_abs") == str(model_path):
        inference.engine.unload()
    model_path.unlink()
    core.set_model_label(core.rel_to_root(model_path), "")
    settings = core.load_settings()
    if settings.get("default_model") == core.rel_to_root(model_path):
        core.save_settings({"default_model": ""})
    return {"ok": True}


def api_model_rename(handler, query):
    ensure_no_heavy()
    body = json_body(handler)
    model_path = core.resolve_inside(body.get("model", ""), must_exist=True)
    new_name = core.sanitize_filename(body.get("new_name", ""))
    if not new_name.lower().endswith(".pt"):
        new_name += ".pt"
    dest = model_path.with_name(new_name)
    if dest.exists():
        raise core.ApiError("目标文件名已存在")
    os.replace(model_path, dest)
    core.move_model_label(core.rel_to_root(model_path), core.rel_to_root(dest))
    settings = core.load_settings()
    if settings.get("default_model") == core.rel_to_root(model_path):
        core.save_settings({"default_model": core.rel_to_root(dest)})
    return {"ok": True, "model": core.rel_to_root(dest)}


def api_model_default(handler, query):
    body = json_body(handler)
    model_rel = body.get("model", "")
    core.resolve_inside(model_rel, must_exist=True)
    core.save_settings({"default_model": model_rel})
    return {"ok": True, "default_model": model_rel}


def api_model_label(handler, query):
    body = json_body(handler)
    model_rel = str(body.get("model") or "")
    core.resolve_inside(model_rel, must_exist=True)
    label = str(body.get("label") or "").strip()
    if label:
        # Same rule as automatic naming: duplicate names get _1, _2 …
        label = core.unique_model_label(label, exclude_rel=model_rel)
    label = core.set_model_label(model_rel, label)
    return {"ok": True, "model": model_rel, "label": label}


def api_configs(handler, query):
    configs = []
    for path in sorted((core.ROOT / "configs").glob("*.yaml")):
        info = {"name": path.name, "rel": core.rel_to_root(path), "size": path.stat().st_size,
                "mtime": path.stat().st_mtime}
        try:
            data = core.load_yaml(path)
            info.update(
                {
                    "device": data.get("device"),
                    "expdir": (data.get("env") or {}).get("expdir"),
                    "batch_size": (data.get("train") or {}).get("batch_size"),
                    "epochs": (data.get("train") or {}).get("epochs"),
                    "max_steps": (data.get("train") or {}).get("max_steps", 0),
                    "interval_val": (data.get("train") or {}).get("interval_val"),
                    "interval_force_save": (data.get("train") or {}).get("interval_force_save"),
                    "sampling_rate": (data.get("data") or {}).get("sampling_rate"),
                    "n_spk": (data.get("model") or {}).get("n_spk"),
                }
            )
        except Exception as exc:
            info["error"] = str(exc)
        configs.append(info)
    return {"configs": configs}


def api_config_get(handler, query):
    name = qget(query, "name", "")
    path = core.resolve_inside(f"configs/{name}", must_exist=True)
    if path.parent != (core.ROOT / "configs"):
        raise core.ApiError("非法配置路径")
    return {"name": path.name, "text": path.read_text(encoding="utf-8"), "rel": core.rel_to_root(path)}


def api_config_save(handler, query):
    body = json_body(handler)
    name = core.sanitize_filename(body.get("name", ""))
    if not name.endswith(".yaml"):
        name += ".yaml"
    path = core.resolve_inside(f"configs/{name}")
    if path.parent != (core.ROOT / "configs"):
        raise core.ApiError("非法配置路径")
    text = str(body.get("text") or "")
    core.validate_yaml_text(text)
    tmp = path.with_suffix(".yaml.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
    return {"ok": True, "name": path.name}


def api_config_update(handler, query):
    body = json_body(handler)
    name = core.sanitize_filename(body.get("name", ""))
    if not name.endswith(".yaml"):
        name += ".yaml"
    path = core.resolve_inside(f"configs/{name}", must_exist=True)
    if path.parent != (core.ROOT / "configs"):
        raise core.ApiError("非法配置路径")
    updates = body.get("updates") or {}
    if not isinstance(updates, dict):
        raise core.ApiError("updates 必须是对象")
    text = core.update_yaml_file(path, updates)
    return {"ok": True, "text": text, "name": path.name}


# ---------------------------------------------------------------------------
# API: dataset
# ---------------------------------------------------------------------------
def dataset_stats() -> dict:
    train = core.dataset_entries("train")
    val = core.dataset_entries("val")
    train_duration = sum((e.get("duration") or 0) for e in train)
    val_duration = sum((e.get("duration") or 0) for e in val)
    speakers = sorted(
        {p.name for p in (core.ROOT / "data" / "train" / "audio").iterdir() if p.is_dir()}
    ) if (core.ROOT / "data" / "train" / "audio").exists() else []
    return {
        "train": train,
        "val": val,
        "stats": {
            "train_count": len(train),
            "val_count": len(val),
            "train_duration": round(train_duration, 1),
            "val_duration": round(val_duration, 1),
            "speakers": speakers,
        },
    }


def api_dataset(handler, query):
    data = dataset_stats()
    data["features"] = features_summary()
    return data


def features_summary() -> dict:
    result = {}
    for split in ("train", "val"):
        base = core.ROOT / "data" / split
        counts = {}
        for name in ("units", "f0", "volume", "mel", "aug_mel", "aug_vol"):
            directory = base / name
            counts[name] = len(list(directory.rglob("*.npy"))) if directory.exists() else 0
        counts["skip"] = len(list((base / "skip").glob("*"))) if (base / "skip").exists() else 0
        counts["ready"] = counts["units"] if counts["units"] else 0
        result[split] = counts
    return result


def api_features(handler, query):
    return features_summary()


def api_dataset_delete(handler, query):
    ensure_no_heavy()
    body = json_body(handler)
    split = str(body.get("split") or "train").lower()
    if split not in ("train", "val"):
        raise core.ApiError("split 必须是 train 或 val")
    rel = str(body.get("rel") or "")
    base = core.ROOT / "data" / split / "audio"
    path = (base / rel).resolve()
    try:
        path.relative_to(base)
    except ValueError:
        raise core.ApiError("非法路径")
    if not path.exists():
        raise core.ApiError("文件不存在", 404)
    path.unlink()
    removed_features = 0
    if body.get("with_features", True):
        for name in ("units", "f0", "volume", "mel", "aug_mel", "aug_vol"):
            f = core.ROOT / "data" / split / name / (rel + ".npy")
            if f.exists():
                try:
                    f.unlink()
                    removed_features += 1
                except Exception:
                    pass
        skip = core.ROOT / "data" / split / "skip" / rel
        if skip.exists():
            try:
                skip.unlink()
            except Exception:
                pass
    return {"ok": True, "removed_features": removed_features}


def api_dataset_draw(handler, query):
    ensure_no_heavy()
    body = json_body(handler)
    count = int(body.get("count") or 10)
    count = max(1, min(100, count))
    min_duration = float(body.get("min_duration") or 2.0)
    src_base = core.ROOT / "data" / "train" / "audio"
    dst_base = core.ROOT / "data" / "val" / "audio"
    files = [p for p in core.list_audio_files(src_base, core.DATASET_EXTS)]
    if not files:
        raise core.ApiError("训练集为空，请先上传音频到 data/train/audio")
    candidates = []
    for p in files:
        info = core.audio_info(p) or {}
        duration = info.get("duration")
        if duration is None or duration >= min_duration:
            candidates.append(p)
    if not candidates:
        raise core.ApiError(f"没有时长不低于 {min_duration} 秒的音频")
    random.shuffle(candidates)
    selected = candidates[:count]
    moved = []
    for src in selected:
        rel = src.relative_to(src_base)
        dst = dst_base / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            dst = core.unique_path(dst.parent, dst.name)
        shutil.move(str(src), str(dst))
        moved.append(core.rel_to_root(dst))
    return {"ok": True, "moved": moved, "count": len(moved), "candidates": len(candidates)}


def api_dataset_clear_features(handler, query):
    ensure_no_heavy()
    body = json_body(handler)
    split = str(body.get("split") or "all").lower()
    splits = ("train", "val") if split == "all" else (split,)
    if any(s not in ("train", "val") for s in splits):
        raise core.ApiError("split 参数错误")
    removed = 0
    for s in splits:
        for name in ("units", "f0", "volume", "mel", "aug_mel", "aug_vol", "skip"):
            directory = core.ROOT / "data" / s / name
            if directory.exists():
                removed += len(list(directory.rglob("*")))
                shutil.rmtree(directory, ignore_errors=True)
        pitch_aug = core.ROOT / "data" / s / "pitch_aug_dict.npy"
        if pitch_aug.exists():
            try:
                pitch_aug.unlink()
                removed += 1
            except Exception:
                pass
    return {"ok": True, "removed": removed}


def api_dataset_preprocess(handler, query):
    ensure_no_heavy()
    body = json_body(handler)
    config = str(body.get("config") or "configs/reflow-barbara.yaml")
    device = str(body.get("device") or "auto").lower()
    workers = int(body.get("workers") or 1)
    workers = max(1, min(8, workers))
    cfg_path = core.resolve_inside(config, must_exist=True)
    if cfg_path.parent != (core.ROOT / "configs"):
        raise core.ApiError("配置必须位于 configs 目录")
    if device not in ("auto", "cuda", "cpu"):
        raise core.ApiError("设备参数错误")
    train_count = len(core.dataset_entries("train"))
    val_count = len(core.dataset_entries("val"))
    if train_count == 0:
        raise core.ApiError("训练集为空，请先在“数据预处理”页面上传音频")
    if val_count == 0:
        raise core.ApiError("验证集为空，请先使用“划分验证集”功能")

    inference.engine.unload()
    task = tasks.manager.create("preprocess", f"数据预处理（{train_count}+{val_count} 个文件）")
    args = [
        core.python_exe(),
        str(core.WEBUI / "preprocess_runner.py"),
        "--config", core.rel_to_root(cfg_path),
        "--device", device,
        "--workers", str(workers),
    ]

    def on_line(t, line):
        if line.startswith("@@"):
            m = re.match(r"@@PROGRESS\s+(train|val)\s+(\d+)\s+(\d+)", line)
            if m:
                phase, done, total = m.group(1), int(m.group(2)), int(m.group(3))
                ratio = (done / total) if total else 0
                pct = ratio * 80 if phase == "train" else 80 + ratio * 20
                t.set_progress(pct, f"预处理{'训练集' if phase == 'train' else '验证集'} {done}/{total}")
            elif line.startswith("@@TOTAL"):
                parts = line.split()
                if len(parts) >= 3:
                    t.message = f"待处理 {parts[1]}：{parts[2]} 个文件"
            elif line.startswith("@@PHASE"):
                t.message = "预处理" + ("训练集" if "train" in line else "验证集")
            elif line.startswith("@@DONE"):
                t.set_progress(100, "预处理完成")
            return False
        if "worker processes" in line:
            t.message = line.strip()
        return True

    tasks.manager.run_process(task, args, cwd=core.ROOT, env=core.job_env(), on_line=on_line)
    return {"ok": True, "task": task.to_dict()}


# ---------------------------------------------------------------------------
# API: inference / results
# ---------------------------------------------------------------------------
def api_infer_inputs(handler, query):
    raw = core.ROOT / "raw"
    files = core.list_audio_files(raw)
    items = []
    for p in files[:500]:
        info = core.audio_info(p) or {}
        items.append(
            {
                "rel": p.relative_to(raw).as_posix(),
                "name": p.name,
                "size": p.stat().st_size,
                "mtime": p.stat().st_mtime,
                "duration": info.get("duration"),
                "sample_rate": info.get("sample_rate"),
                "channels": info.get("channels"),
            }
        )
    return {"items": items}


def api_infer_inputs_delete(handler, query):
    """Delete one or more input audios from raw/ (素材库)."""
    ensure_no_heavy()
    body = json_body(handler)
    rels = body.get("paths")
    if isinstance(rels, str):
        rels = [rels]
    if not isinstance(rels, list) or not rels:
        raise core.ApiError("请先选择要删除的音频")
    if len(rels) > 500:
        raise core.ApiError("一次最多删除 500 个音频")
    raw_base = (core.ROOT / "raw").resolve()
    removed, missing, failed = [], [], []
    for rel in rels:
        path = (raw_base / str(rel)).resolve()
        try:
            path.relative_to(raw_base)
        except ValueError:
            raise core.ApiError(f"非法路径：{rel}", 403)
        if path == raw_base or not path.is_file():
            missing.append(str(rel))
            continue
        try:
            path.unlink()
            removed.append(str(rel))
        except OSError as exc:
            failed.append({"rel": str(rel), "error": str(exc)})
    return {
        "ok": True,
        "count": len(removed),
        "removed": removed,
        "missing": missing,
        "failed": failed,
    }


def api_infer_status(handler, query):
    return inference.engine.status()


def _apply_inference(task: tasks.Task, inputs: list[Path], model_rel: str, device: str, params: dict):
    results = []
    errors = []
    total = len(inputs)
    template = str(params.get("output_template") or core.load_settings().get("output_template") or "")
    results_dir = core.ROOT / "results"
    meta_dir = results_dir / ".meta"
    results_dir.mkdir(parents=True, exist_ok=True)
    for index, input_path in enumerate(inputs):
        if task.cancel_event.is_set():
            break
        stem = input_path.stem
        output_name = core.render_output_name(
            template,
            stem=stem,
            model=Path(model_rel).stem,
            key=params.get("key", 0),
            v=params.get("vocal_register", 0),
            f=params.get("formant", 0),
            method=params.get("method", "euler"),
            infer_step=params.get("infer_step", 50),
            t_start=params.get("t_start", 0.7),
        )
        output_path = core.unique_path(results_dir, output_name)
        start_pct = index / total * 100

        def progress(pct, msg=None, index=index, start_pct=start_pct, input_path=input_path):
            overall = start_pct + (float(pct) / 100.0) * (100.0 / total)
            label = f"[{index + 1}/{total}] {input_path.name}"
            if msg:
                label += f" · {msg}"
            task.set_progress(overall, label)

        task.log(f"===== [{index + 1}/{total}] {input_path.name} =====")
        try:
            result = inference.engine.infer_file(
                input_path,
                output_path,
                model_rel,
                device,
                params,
                log=task.log,
                progress=progress,
                cancel_event=task.cancel_event,
            )
            model_label = core.load_model_labels().get(model_rel, "")
            result["model_label"] = model_label
            try:
                meta_dir.mkdir(parents=True, exist_ok=True)
                core.safe_json_dump(
                    meta_dir / (output_path.name + ".json"),
                    {
                        "created": core.now_iso(),
                        "input": core.rel_to_root(input_path),
                        "model": model_rel,
                        "model_label": model_label,
                        "result": result,
                    },
                )
            except Exception:
                pass
            results.append(result)
        except inference.InferenceCancelled:
            raise
        except Exception as exc:
            message = str(exc)
            errors.append({"input": core.rel_to_root(input_path), "error": message})
            task.log(f"[失败] {input_path.name}：{message}")
            if "out of memory" in message.lower():
                inference.engine.unload()
    if not results:
        if errors:
            raise inference.InferenceError(errors[0]["error"])
        raise inference.InferenceCancelled()
    return {
        "items": results,
        "errors": errors,
        "total": total,
        "ok": len(results),
        "failed": len(errors),
    }


def api_infer(handler, query):
    ensure_no_heavy()
    body = json_body(handler)
    inputs_raw = body.get("inputs") or []
    if isinstance(inputs_raw, str):
        inputs_raw = [inputs_raw]
    if not isinstance(inputs_raw, list) or not inputs_raw:
        raise core.ApiError("请先选择至少一个输入音频")
    if len(inputs_raw) > 100:
        raise core.ApiError("一次最多处理 100 个音频")
    model_rel = str(body.get("model") or "")
    if not model_rel:
        raise core.ApiError("请选择模型")
    model_path = core.resolve_inside(model_rel, must_exist=True)
    if model_path.suffix.lower() not in (".pt", ".ckpt", ".pth"):
        raise core.ApiError("模型文件格式错误")
    device = str(body.get("device") or "auto")
    params = body.get("params") or {}
    if not isinstance(params, dict):
        raise core.ApiError("参数格式错误")

    inputs = []
    raw_base = core.ROOT / "raw"
    missing = []
    for rel in inputs_raw:
        p = (raw_base / str(rel)).resolve()
        try:
            p.relative_to(raw_base)
        except ValueError:
            raise core.ApiError("输入音频必须位于 raw 目录")
        if not p.exists() or not p.is_file():
            missing.append(str(rel))
            continue
        if p.suffix.lower() not in core.AUDIO_EXTS:
            raise core.ApiError(f"不支持的音频格式：{p.name}")
        inputs.append(p)
    if missing:
        names = "、".join(missing)
        raise core.ApiError(
            f"raw 中找不到输入音频：{names}。可能上传尚未完成、文件被移动或重命名。"
            "请刷新素材库后重新选择；FLAC/WAV/MP3/OGG 均可直接推理。"
        )

    title = f"推理 {len(inputs)} 个音频"
    task = tasks.manager.create("infer", title)
    tasks.manager.run_thread(
        task,
        lambda t: _apply_inference(t, inputs, model_rel, device, params),
    )
    return {"ok": True, "task": task.to_dict()}


def api_infer_preload(handler, query):
    ensure_no_heavy()
    body = json_body(handler)
    model_rel = str(body.get("model") or "")
    device = str(body.get("device") or "auto")
    core.resolve_inside(model_rel, must_exist=True)
    task = tasks.manager.create("preload", f"预加载模型 {Path(model_rel).name}")
    tasks.manager.run_thread(
        task,
        lambda t: inference.engine.preload(model_rel, device, log=t.log),
    )
    return {"ok": True, "task": task.to_dict()}


def api_infer_unload(handler, query):
    if tasks.manager.active_heavy():
        raise core.ApiError("当前有 GPU 任务在运行，无法卸载模型", 409)
    inference.engine.unload()
    return {"ok": True, **inference.engine.status()}


def api_results(handler, query):
    results_dir = core.ROOT / "results"
    meta_dir = results_dir / ".meta"
    items = []
    if results_dir.exists():
        for p in core.list_audio_files(results_dir, {".wav", ".flac"}):
            if p.parent == meta_dir:
                continue
            info = core.audio_info(p) or {}
            rel = p.relative_to(results_dir).as_posix()
            meta = None
            try:
                meta_path = meta_dir / (p.name + ".json")
                if meta_path.exists():
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = None
            items.append(
                {
                    "rel": rel,
                    "path": core.rel_to_root(p),
                    "name": p.name,
                    "size": p.stat().st_size,
                    "mtime": p.stat().st_mtime,
                    "duration": info.get("duration"),
                    "sample_rate": info.get("sample_rate"),
                    "channels": info.get("channels"),
                    "meta": meta,
                }
            )
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return {"items": items}


def api_results_delete(handler, query):
    body = json_body(handler)
    rel = str(body.get("rel") or "")
    base = core.ROOT / "results"
    path = (base / rel).resolve()
    try:
        path.relative_to(base)
    except ValueError:
        raise core.ApiError("非法路径")
    if path.exists():
        path.unlink()
    meta = base / ".meta" / (path.name + ".json")
    if meta.exists():
        try:
            meta.unlink()
        except Exception:
            pass
    return {"ok": True}


# ---------------------------------------------------------------------------
# API: training / tensorboard / tools
# ---------------------------------------------------------------------------
def _count_features(split: str) -> int:
    directory = core.ROOT / "data" / split / "units"
    return len(list(directory.rglob("*.npy"))) if directory.exists() else 0


def api_train_start(handler, query):
    ensure_no_heavy()
    body = json_body(handler)
    config = str(body.get("config") or "configs/reflow-barbara.yaml")
    run_name = str(body.get("name") or "").strip()[:60]
    cfg_path = core.resolve_inside(config, must_exist=True)
    if cfg_path.parent != (core.ROOT / "configs"):
        raise core.ApiError("配置必须位于 configs 目录")
    base_rel = str(body.get("base_model") or "").strip()
    base_path = None
    if base_rel:
        base_path = core.resolve_inside(base_rel, must_exist=True)
        if not base_path.is_file() or base_path.suffix.lower() not in (".pt", ".pth", ".ckpt"):
            raise core.ApiError("先前模型必须是 .pt / .pth / .ckpt 文件")
    if _count_features("train") == 0:
        raise core.ApiError("训练特征尚未生成，请先到“数据预处理”页面执行预处理")
    if _count_features("val") == 0:
        raise core.ApiError("验证集特征尚未生成，请先执行预处理（需要验证集）")
    inference.engine.unload()
    task = tasks.manager.create("train", f"模型训练 · {run_name or cfg_path.name}")
    args = [core.python_exe(), "train_reflow.py", "-c", core.rel_to_root(cfg_path)]
    env = core.job_env()
    if base_path is not None:
        env["DDSP_BASE_MODEL"] = str(base_path)
        task.message = f"从模型 {base_path.name} 继续训练…"
    else:
        env["DDSP_FROM_SCRATCH"] = "1"
        task.message = "从零开始训练…"
    try:
        config_data = core.load_yaml(cfg_path)
        max_steps = int(((config_data.get("train") or {}).get("max_steps") or 0))
        expdir = str(((config_data.get("env") or {}).get("expdir") or "")).strip()
    except Exception:
        max_steps = 0
        expdir = ""

    saved_paths: list[str] = []
    deleted_paths: list[str] = []

    def on_line(t, line):
        # Only the training log line ends with "| step: N"; tqdm lines also
        # contain "sample time step: 100%" and must not be mistaken for it.
        m = re.search(r"\|\s*step:\s*(\d+)\s*$", line)
        if m:
            step = int(m.group(1))
            if max_steps > 0:
                t.set_progress(min(99.0, step / max_steps * 100.0), f"训练中 · step {step} / {max_steps}")
            else:
                t.message = f"训练中 · step {step}"
        if " --- <validation> ---" in line:
            t.message = "验证中…"
        if "start training" in line:
            t.message = "训练已启动…"
        if "reached max_steps" in line:
            t.message = "已达到设定总步数，保存最终模型…"
        # Track what the trainer really wrote / removed, so the display name is
        # applied to that exact file instead of being guessed from mtimes.
        for marker, bucket in (("model checkpoint saved:", saved_paths),
                               ("model checkpoint deleted:", deleted_paths)):
            if marker in line:
                raw = line.split(marker, 1)[1].strip()
                try:
                    path = Path(raw)
                    if not path.is_absolute():
                        path = core.ROOT / path
                    bucket.append(core.rel_to_root(path))
                except Exception:
                    pass
        if "[x]" in line or "Error" in line:
            t.log("!! " + line)

    def on_finish(t):
        # Name the checkpoint this run just wrote - and only that one.
        if t.status != "success":
            return
        try:
            for rel in deleted_paths:
                if core.load_model_labels().get(rel):
                    t.log(f"[!] 训练清理删除了已命名的检查点：{rel}")
            if not saved_paths:
                t.log("[!] 本次训练没有写出新的检查点（步数未达到保存间隔，或训练被提前停止）")
            if not run_name:
                return

            target = None
            missing = False
            for rel in reversed(saved_paths):
                if (core.ROOT / rel).exists():
                    target = rel
                    break
                missing = True
            if target is None:
                # Fall back to "newest file of this run" if the log was cut off.
                exp_rel = core.rel_to_root(Path(expdir)) if expdir else ""
                run_started = float(t.started or time.time()) - 3.0
                written = [
                    m for m in core.list_models()
                    if (not exp_rel or m.get("exp") == exp_rel)
                    and (m.get("step") or 0) > 0
                    and float(m.get("mtime") or 0) >= run_started
                ]
                if missing:
                    t.log("[!] 训练报告保存了检查点，但文件不存在；请检查磁盘空间或杀毒软件")
                if not written:
                    return
                newest = max(written, key=lambda m: (float(m.get("mtime") or 0), m.get("step") or 0))
                target = newest["rel"]

            if core.load_model_labels().get(target) and core.label_is_current(target):
                return
            label = core.unique_model_label(
                f"{run_name}_{core.model_step(target)}",
                exclude_rel=target,
                include_history=True,
            )
            applied = core.set_model_label(target, label)
            t.log(f"[*] 显示名称已设为：{applied}")
        except Exception:
            pass

    tasks.manager.run_process(task, args, cwd=core.ROOT, env=env, on_line=on_line, on_finish=on_finish)
    return {"ok": True, "task": task.to_dict()}


def api_tensorboard(handler, query):
    with STATE_LOCK:
        tb = dict(STATE["tensorboard"] or {})
    running = False
    if tb.get("task_id"):
        task = tasks.manager.get(tb["task_id"])
        running = bool(task and task.status == "running")
    tb["running"] = running
    if tb.get("port"):
        tb["alive"] = core.port_open(int(tb["port"]))
        tb["url"] = f"http://127.0.0.1:{tb['port']}/"
    return tb


def api_tensorboard_start(handler, query):
    with STATE_LOCK:
        current = STATE["tensorboard"]
    if current:
        task = tasks.manager.get(current.get("task_id"))
        if task and task.status == "running" and core.port_open(int(current["port"])):
            return {"ok": True, "already": True, **api_tensorboard(handler, query)}
        tasks.manager.cancel(current.get("task_id")) if current.get("task_id") else None
    requested = int(qget(query, "port", 6006) or 6006)
    port = core.find_free_port(requested)
    task = tasks.manager.create("tensorboard", f"TensorBoard :{port}", heavy=False)
    args = [
        core.python_exe(), "-m", "tensorboard.main",
        "--logdir", str(core.ROOT / "exp"),
        "--host", "127.0.0.1",
        "--port", str(port),
        "--reload_interval", "5",
    ]

    def on_line(t, line):
        if "TensorBoard" in line and "http" in line:
            t.message = f"TensorBoard 已启动：http://127.0.0.1:{port}/"

    tasks.manager.run_process(task, args, cwd=core.ROOT, env=core.job_env(), on_line=on_line)
    with STATE_LOCK:
        STATE["tensorboard"] = {
            "task_id": task.id,
            "port": port,
            "url": f"http://127.0.0.1:{port}/",
            "started": time.time(),
        }
    return {"ok": True, "task": task.to_dict(), "port": port, "url": f"http://127.0.0.1:{port}/"}


def api_tensorboard_stop(handler, query):
    with STATE_LOCK:
        current = STATE["tensorboard"]
        STATE["tensorboard"] = None
    if current and current.get("task_id"):
        tasks.manager.cancel(current["task_id"])
    return {"ok": True}


def api_tools(handler, query):
    tb = api_tensorboard(handler, query)
    return {
        "tensorboard": tb,
        "realtime": tool_status("realtime"),
        "toolkit": tool_status("toolkit"),
        "admin": core.is_admin(),
        "paths": {
            "raw": str(core.ROOT / "raw"),
            "results": str(core.ROOT / "results"),
            "exp": str(core.ROOT / "exp"),
            "data": str(core.ROOT / "data"),
        },
    }


def api_tool_launch(handler, query):
    body = json_body(handler)
    name = str(body.get("tool") or "").lower()
    if name == "realtime":
        ensure_no_heavy()
        status = start_tool_process("realtime", [core.pythonw_exe(), "gui_reflow.py"])
        return {"ok": True, "status": status}
    if name == "toolkit":
        exe = core.ROOT / "navigator_audio_toolkit_v0.1.2.exe"
        if not exe.exists():
            candidates = sorted(core.ROOT.glob("navigator_audio_toolkit*.exe"))
            if not candidates:
                raise core.ApiError("找不到 navigator_audio_toolkit 程序", 404)
            exe = candidates[0]
        status = start_tool_process("toolkit", [str(exe)])
        return {"ok": True, "status": status}
    raise core.ApiError("未知工具")


def api_tool_stop(handler, query):
    body = json_body(handler)
    name = str(body.get("tool") or "").lower()
    if name not in ("realtime", "toolkit"):
        raise core.ApiError("未知工具")
    stop_tool_process(name)
    return {"ok": True}


def api_tool_focus(handler, query):
    body = json_body(handler)
    name = str(body.get("tool") or "").lower()
    hint = {"realtime": "DDSP - GUI", "toolkit": "音频工具箱"}.get(name)
    if not hint:
        raise core.ApiError("未知工具")
    focused = core.focus_window(hint, retries=3, delay=0.4)
    return {"ok": True, "focused": focused}


def api_cache_clear(handler, query):
    body = json_body(handler)
    target = str(body.get("target") or "f0")
    removed = 0
    if target in ("f0", "all"):
        cache_dir = core.ROOT / "cache"
        if cache_dir.exists():
            for p in cache_dir.glob("*.npy"):
                try:
                    p.unlink()
                    removed += 1
                except Exception:
                    pass
    if target in ("logs", "all"):
        cutoff = time.time() - 7 * 86400
        for p in core.TASKS_LOG.glob("*.log"):
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
                    removed += 1
            except Exception:
                pass
    return {"ok": True, "removed": removed}


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = f"DDSPStudio/{core.APP_VERSION}"
    protocol_version = "HTTP/1.1"

    # -- response helpers ------------------------------------------------
    def send_json(self, obj, status: int = 200) -> None:
        data = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_text(self, text: str, status: int = 200, content_type: str = "text/plain; charset=utf-8") -> None:
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def serve_file(self, path: Path, download: bool = False, cache_seconds: int = 0) -> None:
        try:
            size = path.stat().st_size
        except OSError:
            raise core.ApiError("文件不存在", 404)
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix.lower() in (".js", ".mjs"):
            mime = "text/javascript; charset=utf-8"
        elif path.suffix.lower() == ".css":
            mime = "text/css; charset=utf-8"
        elif path.suffix.lower() == ".svg":
            mime = "image/svg+xml"
        elif path.suffix.lower() in (".log", ".txt", ".yaml", ".yml", ".json", ".csv"):
            mime = "text/plain; charset=utf-8"
        elif path.suffix.lower() in (".wav", ".flac", ".mp3", ".ogg"):
            mime = "audio/" + ("mpeg" if path.suffix.lower() == ".mp3" else path.suffix.lower().lstrip("."))

        start = 0
        end = size - 1
        status = 200
        range_header = self.headers.get("Range")
        if range_header:
            m = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
            if m:
                if m.group(1):
                    start = int(m.group(1))
                if m.group(2):
                    end = int(m.group(2))
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                end = min(end, size - 1)
                status = 206
        length = end - start + 1

        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if cache_seconds:
            self.send_header("Cache-Control", f"public, max-age={cache_seconds}")
        else:
            self.send_header("Cache-Control", "no-store")
        if download:
            quoted = urllib.parse.quote(path.name)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quoted}")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(path, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # -- routing ---------------------------------------------------------
    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method: str):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path.startswith("/api/"):
                # Buffer JSON bodies centrally so that every POST handler
                # consumes its request body (important for HTTP keep-alive).
                if method == "POST" and path != "/api/upload":
                    length = int(self.headers.get("Content-Length") or 0)
                    if length > MAX_JSON:
                        raise core.ApiError("请求体过大", 413)
                    self._body_bytes = self.rfile.read(length) if length > 0 else b""
                handler = None
                for route_method, pattern, fn in ROUTES:
                    if route_method != method:
                        continue
                    match = re.match(pattern, path)
                    if match:
                        handler = fn
                        break
                if handler is None:
                    raise core.ApiError("接口不存在", 404)
                result = handler(self, query)
                if result is not None:
                    self.send_json({"ok": True, **result} if isinstance(result, dict) and "ok" not in result else result)
                return
            if method in ("GET", "HEAD"):
                return self._serve_static(path)
            raise core.ApiError("不支持的请求方法", 405)
        except core.ApiError as exc:
            if method != "HEAD":
                self.send_json({"ok": False, "error": exc.message}, exc.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            LOG.error("Unhandled error on %s %s\n%s", method, path, traceback.format_exc())
            if method != "HEAD":
                self.send_json({"ok": False, "error": f"服务器错误：{exc}"}, 500)

    def _serve_static(self, path: str):
        if path in ("", "/"):
            target = core.STATIC / "index.html"
        elif path.startswith("/static/"):
            rel = path[len("/static/"):]
            target = (core.STATIC / rel).resolve()
            try:
                target.relative_to(core.STATIC)
            except ValueError:
                raise core.ApiError("非法静态资源路径", 403)
        elif path == "/favicon.ico":
            target = core.STATIC / "favicon.svg"
        else:
            # Unknown page: serve the SPA shell (hash routing keeps URLs at /)
            target = core.STATIC / "index.html"
        if not target.exists() or not target.is_file():
            raise core.ApiError("资源不存在", 404)
        cache = 0
        self.serve_file(target, cache_seconds=cache)

    def log_message(self, fmt, *args):
        # Access log is intentionally INFO: it makes "browser shows nothing"
        # support cases diagnosable from server.log without enabling a debugger.
        LOG.info("%s - %s", self.address_string(), fmt % args)

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError):
            self.close_connection = True


ROUTES = [
    ("GET", r"^/api/ping$", api_ping),
    ("GET", r"^/api/system$", api_system),
    ("GET", r"^/api/settings$", api_settings_get),
    ("POST", r"^/api/settings$", api_settings_set),
    ("POST", r"^/api/shutdown$", api_shutdown),
    ("POST", r"^/api/open$", api_open),
    ("POST", r"^/api/browse$", api_browse),
    ("GET", r"^/api/tasks$", api_tasks),
    ("GET", r"^/api/task$", api_task),
    ("GET", r"^/api/task/log$", api_task_log),
    ("POST", r"^/api/task/cancel$", api_task_cancel),
    ("POST", r"^/api/task/clear$", api_task_clear),
    ("POST", r"^/api/upload$", api_upload),
    ("GET", r"^/api/file$", api_file),
    ("GET", r"^/api/models$", api_models),
    ("GET", r"^/api/models/config$", api_model_config_get),
    ("POST", r"^/api/models/config$", api_model_config_save),
    ("POST", r"^/api/models/ensure-config$", api_model_ensure_config),
    ("POST", r"^/api/models/delete$", api_model_delete),
    ("POST", r"^/api/models/rename$", api_model_rename),
    ("POST", r"^/api/models/default$", api_model_default),
    ("POST", r"^/api/models/label$", api_model_label),
    ("GET", r"^/api/configs$", api_configs),
    ("GET", r"^/api/config$", api_config_get),
    ("POST", r"^/api/config$", api_config_save),
    ("POST", r"^/api/config/update$", api_config_update),
    ("GET", r"^/api/dataset$", api_dataset),
    ("POST", r"^/api/dataset/delete$", api_dataset_delete),
    ("POST", r"^/api/dataset/draw$", api_dataset_draw),
    ("POST", r"^/api/dataset/clear-features$", api_dataset_clear_features),
    ("POST", r"^/api/dataset/preprocess$", api_dataset_preprocess),
    ("GET", r"^/api/dataset/features$", api_features),
    ("GET", r"^/api/infer/inputs$", api_infer_inputs),
    ("POST", r"^/api/infer/inputs/delete$", api_infer_inputs_delete),
    ("GET", r"^/api/infer/status$", api_infer_status),
    ("POST", r"^/api/infer$", api_infer),
    ("POST", r"^/api/infer/preload$", api_infer_preload),
    ("POST", r"^/api/infer/unload$", api_infer_unload),
    ("GET", r"^/api/results$", api_results),
    ("POST", r"^/api/results/delete$", api_results_delete),
    ("POST", r"^/api/train/start$", api_train_start),
    ("GET", r"^/api/tensorboard$", api_tensorboard),
    ("POST", r"^/api/tensorboard/start$", api_tensorboard_start),
    ("POST", r"^/api/tensorboard/stop$", api_tensorboard_stop),
    ("GET", r"^/api/tools$", api_tools),
    ("POST", r"^/api/tools/launch$", api_tool_launch),
    ("POST", r"^/api/tools/stop$", api_tool_stop),
    ("POST", r"^/api/tools/focus$", api_tool_focus),
    ("POST", r"^/api/cache/clear$", api_cache_clear),
]


class StudioServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run(host: str = "127.0.0.1", port: int | None = None, open_browser: bool = False,
        console: bool = True) -> None:
    global HTTPD
    os.chdir(core.ROOT)
    core.ensure_dirs()
    setup_logging(console=console)
    settings = core.load_settings()
    if port is None:
        port = int(settings.get("port") or 7890)
    port = core.find_free_port(port)
    core.write_runtime(port)
    HTTPD = StudioServer((host, port), Handler)
    url = f"http://127.0.0.1:{port}/"
    LOG.info("%s %s started at %s (root=%s)", core.APP_NAME, core.APP_VERSION, url, core.ROOT)

    if os.name == "nt":
        # Closing the console window must stop the server and its child tasks.
        import ctypes
        from ctypes import wintypes

        _ctrl_ref = []

        def _on_console(event):
            if event in (0, 2, 5, 6):  # Ctrl+C, close, logoff, shutdown
                try:
                    cleanup_all()
                except Exception:
                    pass
                try:
                    core.clear_runtime()
                except Exception:
                    pass
                os._exit(0)
            return False

        _handler = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)(_on_console)
        _ctrl_ref.append(_handler)
        ctypes.windll.kernel32.SetConsoleCtrlHandler(_handler, True)

    if open_browser:
        def _open():
            time.sleep(0.8)
            try:
                if os.name == "nt" and core.is_admin():
                    subprocess.Popen(["explorer.exe", url], close_fds=True)
                elif os.name == "nt":
                    os.startfile(url)  # type: ignore[attr-defined]
                else:
                    webbrowser.open(url)
            except Exception:
                try:
                    webbrowser.open(url)
                except Exception:
                    pass
        threading.Thread(target=_open, daemon=True).start()
    try:
        HTTPD.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        cleanup_all()
        core.clear_runtime()
        try:
            HTTPD.server_close()
        except Exception:
            pass
        LOG.info("Server stopped")


def main(argv=None):
    parser = argparse.ArgumentParser(description="DDSP Studio WebUI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--console", action="store_true", help="keep console logging")
    args = parser.parse_args(argv)
    run(host=args.host, port=args.port, open_browser=not args.no_browser, console=args.console)


if __name__ == "__main__":
    main()
