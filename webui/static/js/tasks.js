import { api } from "./api.js";
import { toast, statusBadge, fmtDuration, openLogViewer } from "./ui.js";

class TaskStore {
  constructor() {
    this.tasks = [];
    this.map = new Map();
    this.subs = new Set();
    this.lastStatus = new Map();
    this.initialized = false;
    this.timer = null;
    this.refreshing = false;
    this.inflight = null;
  }

  start() {
    this.refresh();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), 1500);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.refresh();
    });
  }

  refresh() {
    // Callers such as "start training" await this to make sure the new task is
    // in the store before binding to it.  Returning early while another poll
    // is in flight used to hand back a stale snapshot, which left the training
    // page bound to an older task.
    if (this.inflight) return this.inflight;
    this.inflight = this._refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async _refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const data = await api.get("/api/tasks", { limit: 60 });
      const tasks = data.tasks || [];
      const previous = this.lastStatus;
      this.tasks = tasks;
      this.map = new Map(tasks.map((task) => [task.id, task]));
      if (this.initialized) {
        for (const task of tasks) {
          const old = previous.get(task.id);
          if (old && old !== task.status && (task.status === "success" || task.status === "failed" || task.status === "canceled")) {
            if (task.kind === "tensorboard") continue;
            if (task.status === "success") {
              toast("任务完成", task.title, "success", 4200);
            } else if (task.status === "failed") {
              toast("任务失败", task.error || task.title, "error", 8000);
            } else {
              toast("任务已取消", task.title, "warning", 4200);
            }
            window.dispatchEvent(new CustomEvent("task:done", { detail: task }));
          }
        }
      }
      this.lastStatus = new Map(tasks.map((task) => [task.id, task.status]));
      this.initialized = true;
      this.notify();
    } catch (error) {
      /* keep the UI quiet when the server is restarting */
    } finally {
      this.refreshing = false;
    }
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  notify() {
    for (const fn of this.subs) {
      try {
        fn(this.tasks);
      } catch {
        /* ignore subscriber errors */
      }
    }
  }

  get(id) {
    return this.map.get(id) || null;
  }

  get running() {
    return this.tasks.filter((task) => task.status === "running" || task.status === "queued");
  }

  get latestRunning() {
    return this.running.find((task) => task.kind !== "tensorboard") || null;
  }

  byKind(kind) {
    return this.tasks.filter((task) => task.kind === kind);
  }

  runningByKind(kind) {
    return this.byKind(kind).find((task) => task.status === "running" || task.status === "queued") || null;
  }
}

export const taskStore = new TaskStore();

export function watchTask(id, callback) {
  let last = null;
  const call = (tasks) => {
    const task = taskStore.get(id);
    if (task && task !== last) {
      last = task;
      callback(task);
    }
  };
  const unsubscribe = taskStore.subscribe(call);
  call(taskStore.tasks);
  return unsubscribe;
}

export function taskRowHtml(task) {
  const pct = task.progress === null || task.progress === undefined ? null : Math.round(task.progress);
  return `
    <div class="file-row" data-task-id="${task.id}" style="cursor:default">
      <div class="file-ico">${task.status === "running" ? '<span class="spinner dark"></span>' : "•"}</div>
      <div class="grow">
        <div class="between">
          <span class="file-name">${task.title}</span>
          ${statusBadge(task.status)}
        </div>
        <div class="file-meta" style="margin-top:3px">
          ${task.message ? `${task.message}` : ""}
          ${task.elapsed ? ` · ${fmtDuration(task.elapsed)}` : ""}
        </div>
        ${pct !== null && task.status === "running" ? `<div class="progress" style="margin-top:7px;height:5px"><i style="width:${pct}%"></i></div>` : ""}
      </div>
      <button class="btn btn-sm btn-ghost" data-task-log="${task.id}" title="日志">日志</button>
    </div>`;
}

/* --------------------------------------------------------------------------
   Global task UI (active pill + floating drawer)
   -------------------------------------------------------------------------- */
let drawerTaskId = null;
let drawerOffset = 0;
let drawerTimer = null;
let drawerDismissed = null;
let drawerCollapsed = false;
let drawerPolling = false;
let uiReady = false;

function $(id) {
  return document.getElementById(id);
}

export function initTaskUI() {
  if (uiReady) return;
  uiReady = true;

  $("active-task").addEventListener("click", () => {
    const task = taskStore.latestRunning;
    if (task) openDrawer(task.id);
  });
  $("drawer-head").addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    drawerCollapsed = !drawerCollapsed;
    $("task-drawer").classList.toggle("collapsed", drawerCollapsed);
  });
  $("drawer-close").addEventListener("click", (event) => {
    event.stopPropagation();
    $("task-drawer").classList.add("hidden");
    drawerDismissed = drawerTaskId;
    stopDrawerPolling();
  });
  $("drawer-full-log").addEventListener("click", () => {
    if (!drawerTaskId) return;
    const task = taskStore.get(drawerTaskId);
    openLogViewer(drawerTaskId, task ? task.title : "任务日志");
  });
  $("drawer-cancel").addEventListener("click", async () => {
    if (!drawerTaskId) return;
    const task = taskStore.get(drawerTaskId);
    if (!task || (task.status !== "running" && task.status !== "queued")) return;
    try {
      await api.post("/api/task/cancel", { id: drawerTaskId });
      toast("正在取消", task.title, "warning");
    } catch (error) {
      toast("取消失败", error.message, "error");
    }
  });

  taskStore.subscribe(updateGlobalTaskUI);
  updateGlobalTaskUI(taskStore.tasks);
}

function updateGlobalTaskUI(tasks) {
  const running = taskStore.latestRunning;
  const pill = $("active-task");
  if (running) {
    const pct = running.progress === null || running.progress === undefined ? "" : `${Math.round(running.progress)}%`;
    pill.classList.remove("hidden");
    pill.innerHTML = `<span class="spinner" style="width:13px;height:13px"></span><span class="truncate">${running.title}</span><span class="mono" style="opacity:.75">${pct}</span>`;
    if (drawerDismissed !== running.id) {
      const isNew = drawerTaskId !== running.id;
      const isHidden = $("task-drawer").classList.contains("hidden");
      if (isNew || isHidden) openDrawer(running.id, isNew);
    }
  } else {
    pill.classList.add("hidden");
    if (drawerTaskId) {
      const task = taskStore.get(drawerTaskId);
      if (task && task.status !== "running" && task.status !== "queued") {
        updateDrawer(task);
      }
    }
  }

  // engine badge
  const engine = $("engine-badge");
  if (engine) {
    const hasModel = window.__engineLoaded;
    engine.classList.toggle("on", Boolean(hasModel));
  }
}

function openDrawer(taskId, reset = false) {
  if (!taskId) return;
  const drawer = $("task-drawer");
  if (drawerTaskId !== taskId) {
    drawerTaskId = taskId;
    drawerOffset = 0;
    reset = true;
    $("drawer-log").textContent = "";
    drawerCollapsed = false;
    drawer.classList.remove("collapsed");
  }
  drawer.classList.remove("hidden");
  const task = taskStore.get(taskId);
  if (task) updateDrawer(task);
  if (reset || drawerOffset === 0) {
    pollDrawerLog(taskId, true);
  } else {
    pollDrawerLog(taskId, false);
  }
  startDrawerPolling();
}

function updateDrawer(task) {
  if (!task) return;
  const pct = task.progress === null || task.progress === undefined ? null : Math.round(task.progress);
  $("drawer-title").textContent = task.title;
  $("drawer-pct").textContent = task.status === "running" ? (pct === null ? "运行中" : `${pct}%`) : task.status === "success" ? "完成" : task.status === "failed" ? "失败" : task.status === "canceled" ? "已取消" : "";
  $("drawer-bar").style.width = pct === null ? "30%" : `${pct}%`;
  $("drawer-bar").parentElement.classList.toggle("indeterminate", pct === null && task.status === "running");
  $("drawer-spin").classList.toggle("hidden", task.status !== "running" && task.status !== "queued");
  $("drawer-cancel").disabled = !(task.status === "running" || task.status === "queued");
}

async function pollDrawerLog(taskId, initial = false) {
  if (drawerPolling) return;
  drawerPolling = true;
  try {
    const url = initial || !drawerOffset
      ? `/api/task/log?id=${encodeURIComponent(taskId)}&tail=1`
      : `/api/task/log?id=${encodeURIComponent(taskId)}&offset=${drawerOffset}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok || data.ok === false) return;
    if (data.text) {
      const log = $("drawer-log");
      log.textContent += data.text;
      if (log.textContent.length > 60000) log.textContent = log.textContent.slice(-60000);
      log.scrollTop = log.scrollHeight;
    }
    drawerOffset = data.offset || drawerOffset;
  } catch {
    /* ignore */
  } finally {
    drawerPolling = false;
  }
}

function startDrawerPolling() {
  stopDrawerPolling();
  drawerTimer = setInterval(() => {
    if (drawerTaskId) pollDrawerLog(drawerTaskId);
  }, 1500);
}

function stopDrawerPolling() {
  if (drawerTimer) {
    clearInterval(drawerTimer);
    drawerTimer = null;
  }
}
