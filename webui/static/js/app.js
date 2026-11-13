import { api } from "./api.js";
import { toast, esc, icon, initGlobalAudioUI, stopAllAudio } from "./ui.js";
import { initTaskUI, taskStore } from "./tasks.js";
import { state, loadSystem, loadSettings, loadModels, loadEngine, gpuText } from "./store.js";
import * as inferPage from "./pages/infer.js";
import * as datasetPage from "./pages/dataset.js";
import * as trainPage from "./pages/train.js";
import * as modelsPage from "./pages/models.js";
import * as resultsPage from "./pages/results.js";
import * as toolsPage from "./pages/tools.js";
import * as settingsPage from "./pages/settings.js";

const routes = {
  infer: {
    title: "推理转换",
    subtitle: "上传干声，选择模型，一键完成歌声转换",
    page: inferPage,
  },
  dataset: {
    title: "数据预处理",
    subtitle: "管理数据集、划分验证集、提取训练特征",
    page: datasetPage,
  },
  train: {
    title: "模型训练",
    subtitle: "修改训练参数、实时查看 loss、从检查点继续训练",
    page: trainPage,
  },
  models: {
    title: "模型管理",
    subtitle: "查看、上传、配置和选择推理模型",
    page: modelsPage,
  },
  results: {
    title: "结果库",
    subtitle: "试听、下载和管理所有转换结果",
    page: resultsPage,
  },
  tools: {
    title: "工具中心",
    subtitle: "实时变声、音频工具箱、TensorBoard 与常用目录",
    page: toolsPage,
  },
  settings: {
    title: "设置",
    subtitle: "默认参数、运行环境与服务管理",
    page: settingsPage,
  },
};

let activePage = null;
let renderToken = 0;
let systemTimer = null;
let engineTimer = null;
let pingTimer = null;
let pingFails = 0;
let serviceDown = false;

function currentRoute() {
  const raw = (location.hash || "").replace(/^#\/?/, "").trim();
  return routes[raw] ? raw : "infer";
}

function setHeader(route) {
  const info = routes[route];
  document.getElementById("page-title").textContent = info.title;
  document.getElementById("page-subtitle").textContent = info.subtitle;
  document.title = `${info.title} · DDSP Studio`;
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.route === route);
  });
}

async function navigate() {
  const routeName = currentRoute();
  setHeader(routeName);
  const view = document.getElementById("view");
  const token = ++renderToken;
  if (activePage && activePage.destroy) {
    try {
      activePage.destroy();
    } catch {
      /* ignore */
    }
  }
  activePage = null;
  view.innerHTML = `<div class="card card-pad" style="margin-top:10px"><div class="row"><span class="spinner dark"></span><span class="muted small">正在加载…</span></div></div>`;
  try {
    const page = routes[routeName].page;
    await page.render(view);
    if (token !== renderToken) return;
    activePage = page;
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  } catch (error) {
    if (token !== renderToken) return;
    view.innerHTML = `
      <div class="card card-pad" style="margin-top:10px">
        <div class="notice danger" style="font-size:12px">${icon("alert")}<div>
          <div class="strong">页面加载失败</div>
          <div style="margin-top:4px">${esc(error.message || String(error))}</div>
          <div style="margin-top:8px"><button class="btn btn-sm" onclick="location.reload()">重新加载</button></div>
        </div></div>
      </div>`;
  }
}

function updateGpuBadge() {
  const badge = document.getElementById("gpu-badge");
  if (!badge) return;
  const gpu = (state.system?.gpus || [])[0];
  badge.innerHTML = `<span class="dot ${gpu ? "" : "off"}"></span><span>${esc(gpuText())}</span>`;
  badge.title = gpu
    ? `${gpu.name} · 驱动 ${gpu.driver || "-"} · 温度 ${gpu.temp_c ?? "-"}°C`
    : "未检测到 CUDA GPU";
}

function updateEngineBadge() {
  const engine = state.engine;
  const badge = document.getElementById("engine-badge");
  const text = document.getElementById("engine-text");
  if (badge) badge.classList.toggle("on", Boolean(engine?.loaded));
  if (text) {
    text.textContent = engine?.loaded
      ? `${(engine.model || "").split("/").pop()} 已加载`
      : "模型未加载";
  }
  window.__engineLoaded = Boolean(engine?.loaded);
}

async function refreshSystem() {
  try {
    await loadSystem();
    updateGpuBadge();
    const version = document.getElementById("version-text");
    if (version && state.system) {
      version.textContent = `DDSP Studio v${state.system.version || "1.0.0"} · 本地离线`;
    }
  } catch {
    /* server may be restarting */
  }
}

async function refreshEngine() {
  await loadEngine();
  updateEngineBadge();
  window.dispatchEvent(new CustomEvent("engine:updated", { detail: state.engine }));
}

/* --------------------------------------------------------------------------
   Service watchdog
   Closing the CMD window stops the local server.  Without this the page keeps
   the last state and looks frozen, so show an explicit error instead.
   -------------------------------------------------------------------------- */
async function checkService(tries = 1, gap = 700) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`/api/ping?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok === true) return true;
      }
    } catch {
      /* keep trying */
    }
    if (i < tries - 1) await new Promise((resolve) => setTimeout(resolve, gap));
  }
  return false;
}

function ensureServiceOverlay() {
  let el = document.getElementById("service-down");
  if (el) return el;
  el = document.createElement("div");
  el.id = "service-down";
  el.className = "modal-backdrop hidden";
  el.innerHTML = `
    <div class="card card-pad" style="max-width:520px;text-align:center">
      <div class="empty-icon" style="margin:0 auto 14px;color:#f87171">${icon("alert")}</div>
      <h2 style="margin:0 0 8px;font-size:17px">Error · WebUI 服务已停止</h2>
      <p class="muted small" style="line-height:1.8;margin:0">
        后台服务已经断开，可能是启动 WebUI 的 CMD 窗口被关闭了。<br>
        当前页面不会再更新，也无法开始新的任务。<br>
        请重新双击整合包目录中的 <span class="mono">启动WebUI.bat</span>，然后点「重新连接」。
      </p>
      <div class="row" style="justify-content:center;margin-top:16px;gap:8px">
        <button class="btn btn-primary" id="svc-retry">重新连接</button>
        <button class="btn" id="svc-dismiss">知道了</button>
      </div>
      <div class="hint" id="svc-hint" style="margin-top:10px">服务恢复后会自动刷新页面</div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector("#svc-retry").addEventListener("click", async () => {
    const hint = el.querySelector("#svc-hint");
    if (hint) hint.textContent = "正在重试…";
    const ok = await checkService(4, 800);
    if (ok) {
      location.reload();
      return;
    }
    if (hint) hint.textContent = "仍然连接不上，请确认 启动WebUI.bat 已经在运行";
    pingFails = 2;
  });
  el.querySelector("#svc-dismiss").addEventListener("click", () => el.classList.add("hidden"));
  return el;
}

function showServiceDown() {
  if (serviceDown) return;
  serviceDown = true;
  ensureServiceOverlay().classList.remove("hidden");
}

function hideServiceDown() {
  serviceDown = false;
  const el = document.getElementById("service-down");
  if (el) el.classList.add("hidden");
}

async function pingService() {
  if (window.__ddspShuttingDown) return;
  if (await checkService(1)) {
    pingFails = 0;
    if (serviceDown) {
      // The service is back: reload so every panel picks up fresh state.
      hideServiceDown();
      location.reload();
    }
    return;
  }
  pingFails += 1;
  if (pingFails >= 2) showServiceDown();
}

function bindGlobal() {
  window.addEventListener("hashchange", navigate);
  window.addEventListener("task:done", (event) => {
    refreshEngine().catch(() => {});
    refreshSystem().catch(() => {});
  });
  window.addEventListener("beforeunload", () => {
    stopAllAudio();
    if (activePage && activePage.destroy) {
      try {
        activePage.destroy();
      } catch {
        /* ignore */
      }
    }
  });
}

async function boot() {
  if (!location.hash) {
    history.replaceState(null, "", "#/infer");
  }
  initTaskUI();
  initGlobalAudioUI();
  taskStore.start();
  bindGlobal();
  updateGpuBadge();
  updateEngineBadge();
  navigate();
  refreshSystem();
  refreshEngine();
  loadSettings().catch(() => {});
  loadModels().catch(() => {});
  systemTimer = setInterval(refreshSystem, 10000);
  engineTimer = setInterval(refreshEngine, 7000);
  pingTimer = setInterval(() => pingService(), 3000);
}

boot();
