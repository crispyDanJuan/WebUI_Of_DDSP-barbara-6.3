"""Background task manager (subprocess + in-process threads)."""
from __future__ import annotations

import codecs
import os
import re
import subprocess
import threading
import time
import traceback
import uuid
from collections import OrderedDict, deque
from pathlib import Path

import core

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
HEAVY_KINDS = {"infer", "preprocess", "train", "preload"}


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


class Task:
    def __init__(self, task_id: str, kind: str, title: str, heavy: bool | None = None):
        self.id = task_id
        self.kind = kind
        self.title = title
        self.heavy = HEAVY_KINDS.__contains__(kind) if heavy is None else bool(heavy)
        self.status = "queued"
        self.created = time.time()
        self.started = None
        self.finished = None
        self.progress = None
        self.message = "等待中…"
        self.result = None
        self.error = None
        self.exit_code = None
        self.cancel_requested = False
        self.cancel_event = threading.Event()
        self.proc: subprocess.Popen | None = None
        self.worker: threading.Thread | None = None
        self.log_path = core.TASKS_LOG / f"{task_id}.log"
        self._log_lock = threading.Lock()
        self._recent = deque(maxlen=400)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.log_path.write_text("", encoding="utf-8")
        except Exception:
            pass
        self.log(f"[{time.strftime('%H:%M:%S')}] {title}")

    # -- logging ---------------------------------------------------------
    def log(self, line: str) -> None:
        line = strip_ansi(str(line)).replace("\x00", "")
        if not line.strip():
            return
        stamp = time.strftime("%H:%M:%S")
        with self._log_lock:
            self._recent.append((stamp, line))
            try:
                with open(self.log_path, "a", encoding="utf-8", errors="replace") as fh:
                    fh.write(line.rstrip("\r\n") + "\n")
                    fh.flush()
            except Exception:
                pass

    def recent(self, n: int = 12) -> list[str]:
        with self._log_lock:
            items = list(self._recent)[-n:]
        return [f"[{stamp}] {line}" for stamp, line in items]

    def log_size(self) -> int:
        try:
            return self.log_path.stat().st_size
        except OSError:
            return 0

    # -- state -----------------------------------------------------------
    def set_progress(self, percent: float | None, message: str | None = None) -> None:
        if percent is not None:
            try:
                self.progress = max(0.0, min(100.0, round(float(percent), 1)))
            except Exception:
                pass
        if message is not None:
            self.message = str(message)

    def start(self) -> None:
        self.status = "running"
        self.started = time.time()
        self.message = "运行中…"

    def finish(self, status: str, result=None, error: str | None = None) -> None:
        self.status = status
        self.finished = time.time()
        self.result = result
        if error:
            self.error = error
            self.log("[错误] " + error)
        if status == "success":
            self.progress = 100.0
            if (
                not self.message
                or self.message == "运行中…"
                or self.message.startswith("训练中")
                or self.message.startswith("合成中")
                or (self.kind == "train" and self.message in ("验证中…", "训练已启动…"))
            ):
                self.message = "训练完成" if self.kind == "train" else "已完成"
        elif status == "canceled":
            self.message = "已取消"
        elif status == "failed":
            self.message = "失败"
        if self.proc is not None and self.proc.poll() is not None:
            self.exit_code = self.proc.returncode

    @property
    def elapsed(self) -> float | None:
        if self.started is None:
            return None
        end = self.finished or time.time()
        return round(end - self.started, 2)

    def to_dict(self, include_recent: bool = False) -> dict:
        data = {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "heavy": self.heavy,
            "status": self.status,
            "created": self.created,
            "started": self.started,
            "finished": self.finished,
            "elapsed": self.elapsed,
            "progress": self.progress,
            "message": self.message,
            "result": self.result,
            "error": self.error,
            "exit_code": self.exit_code,
            "cancel_requested": self.cancel_requested,
            "log_size": self.log_size(),
            "log_url": f"/api/task/log?id={self.id}",
        }
        if include_recent:
            data["recent"] = self.recent(16)
        return data


class TaskManager:
    def __init__(self, max_tasks: int = 120):
        self._tasks: "OrderedDict[str, Task]" = OrderedDict()
        self._lock = threading.RLock()
        self._max_tasks = max_tasks

    # -- creation --------------------------------------------------------
    def create(self, kind: str, title: str, heavy: bool | None = None) -> Task:
        task_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        task = Task(task_id, kind, title, heavy=heavy)
        with self._lock:
            self._tasks[task_id] = task
            while len(self._tasks) > self._max_tasks:
                old_id, old = next(iter(self._tasks.items()))
                if old.status == "running":
                    break
                self._tasks.pop(old_id, None)
        return task

    def get(self, task_id: str) -> Task | None:
        with self._lock:
            return self._tasks.get(task_id)

    def list(self, limit: int = 40) -> list[dict]:
        with self._lock:
            tasks = list(self._tasks.values())
        tasks.sort(key=lambda t: t.created, reverse=True)
        return [t.to_dict() for t in tasks[:limit]]

    def active_heavy(self, exclude: str | None = None) -> Task | None:
        with self._lock:
            tasks = list(self._tasks.values())
        for task in tasks:
            if task.heavy and task.status in ("queued", "running") and task.id != exclude:
                return task
        return None

    def has_running(self, kind: str) -> Task | None:
        with self._lock:
            tasks = list(self._tasks.values())
        for task in tasks:
            if task.kind == kind and task.status in ("queued", "running"):
                return task
        return None

    # -- execution -------------------------------------------------------
    def run_process(self, task: Task, args: list[str], cwd: Path | None = None, env: dict | None = None,
                    on_line=None, title: str | None = None, on_finish=None) -> Task:
        if title:
            task.title = title

        def worker():
            task.start()
            task.log("$ " + " ".join(str(a) for a in args))
            creationflags = core.CREATE_NO_WINDOW | core.CREATE_NEW_PROCESS_GROUP
            try:
                proc = subprocess.Popen(
                    [str(a) for a in args],
                    cwd=str(cwd or core.ROOT),
                    env=env or core.job_env(),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    bufsize=0,
                    creationflags=creationflags,
                )
                task.proc = proc
                self._pump_output(task, proc, on_line)
                rc = proc.wait()
                task.exit_code = rc
                if task.cancel_requested:
                    task.finish("canceled")
                elif rc == 0:
                    task.finish("success")
                else:
                    task.finish("failed", error=f"进程退出码 {rc}")
            except Exception as exc:
                task.log(traceback.format_exc())
                task.finish("failed", error=str(exc))
            finally:
                if on_finish is not None:
                    try:
                        on_finish(task)
                    except Exception:
                        task.log(traceback.format_exc())

        thread = threading.Thread(target=worker, name=f"task-{task.id}", daemon=True)
        task.worker = thread
        thread.start()
        return task

    def _pump_output(self, task: Task, proc: subprocess.Popen, on_line) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        buffer = ""
        fd = proc.stdout.fileno() if proc.stdout is not None else None
        while True:
            try:
                chunk = os.read(fd, 8192) if fd is not None else b""
            except OSError:
                break
            if not chunk:
                tail = decoder.decode(b"", final=True)
                buffer += tail
                break
            buffer += decoder.decode(chunk)
            # tqdm uses \r, normal logs use \n: split on both.
            parts = re.split(r"[\r\n]", buffer)
            buffer = parts.pop()
            for raw_line in parts:
                line = strip_ansi(raw_line).rstrip()
                if not line:
                    continue
                keep = True
                if on_line is not None:
                    try:
                        keep = on_line(task, line)
                    except Exception:
                        keep = True
                if keep is not False:
                    task.log(line)
        if buffer.strip():
            line = strip_ansi(buffer).rstrip()
            keep = True
            if on_line is not None:
                try:
                    keep = on_line(task, line)
                except Exception:
                    keep = True
            if keep is not False:
                task.log(line)

    def run_thread(self, task: Task, fn, title: str | None = None) -> Task:
        if title:
            task.title = title

        def worker():
            task.start()
            try:
                result = fn(task)
                if task.cancel_requested or task.cancel_event.is_set():
                    task.finish("canceled", result=result)
                else:
                    task.finish("success", result=result)
            except Exception as exc:
                # A cancellation exception can be raised by the worker.
                if task.cancel_requested or task.cancel_event.is_set() or exc.__class__.__name__ in (
                    "InferenceCancelled", "CancelledError",
                ):
                    task.log("任务已取消")
                    task.finish("canceled")
                else:
                    task.log(traceback.format_exc())
                    task.finish("failed", error=str(exc))

        thread = threading.Thread(target=worker, name=f"task-{task.id}", daemon=True)
        task.worker = thread
        thread.start()
        return task

    # -- control ---------------------------------------------------------
    def cancel(self, task_id: str) -> Task | None:
        task = self.get(task_id)
        if not task:
            return None
        if task.status not in ("queued", "running"):
            return task
        task.cancel_requested = True
        task.cancel_event.set()
        task.log("正在取消任务…")
        if task.proc is not None:
            # taskkill can be denied for a process started inside a restricted
            # job.  The parent still owns the Popen handle, so terminate it
            # directly as well.
            try:
                task.proc.terminate()
            except Exception:
                pass
            try:
                task.proc.wait(timeout=2)
            except Exception:
                try:
                    task.proc.kill()
                except Exception:
                    pass
            core.kill_tree(task.proc.pid)
        return task

    def cancel_all(self) -> None:
        with self._lock:
            tasks = list(self._tasks.values())
        for task in tasks:
            if task.status in ("queued", "running"):
                self.cancel(task.id)


manager = TaskManager()


def read_log(task_id: str, offset: int = 0, tail: bool = False, tail_bytes: int = 96 * 1024) -> dict:
    task = manager.get(task_id)
    if not task:
        raise core.ApiError("任务不存在", 404)
    path = task.log_path
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    if tail:
        start = max(0, size - int(tail_bytes))
        with open(path, "rb") as fh:
            fh.seek(start)
            data = fh.read()
        text = data.decode("utf-8", errors="replace")
        if start > 0:
            nl = text.find("\n")
            if nl >= 0:
                text = text[nl + 1:]
        return {"offset": size, "size": size, "text": text, "eof": True}
    offset = max(0, int(offset or 0))
    if offset > size:
        offset = 0
    with open(path, "rb") as fh:
        fh.seek(offset)
        data = fh.read()
    return {
        "offset": offset + len(data),
        "size": size,
        "text": data.decode("utf-8", errors="replace"),
        "eof": True,
    }
