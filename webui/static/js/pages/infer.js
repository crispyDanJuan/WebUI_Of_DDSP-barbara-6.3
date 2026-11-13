import { api, fileUrl, uploadFile, uploadUrl } from "../api.js";
import {
  esc, icon, toast, fmtBytes, fmtDuration, fmtDate, mountPlayer, openLogViewer, confirmDialog,
  renderEmpty, statusBadge, bindRange, playAudio,
} from "../ui.js";
import { taskStore, watchTask } from "../tasks.js";
import { loadSettings, loadEngine } from "../store.js";

const LS_KEY = "ddsp.infer.form.v2";
const PAGE_LIMIT = 500;

const els = {};
let models = [];
let rawItems = [];
let selected = new Set();
const checked = new Set();
let libManage = false;
let currentTaskId = null;
let currentTask = null;
let unwatch = null;
let settings = {};
let engine = null;
let uploadBusy = false;
let previewAudio = null;
let recentResults = [];
let engineListener = null;
let taskDoneListener = null;

export async function render(container) {
  [models, rawItems, settings, engine] = await Promise.all([
    api.get("/api/models").then((data) => data.models || []).catch(() => []),
    api.get("/api/infer/inputs").then((data) => data.items || []).catch(() => []),
    loadSettings().catch(() => ({})),
    loadEngine().catch(() => null),
  ]);
  recentResults = await api.get("/api/results").then((data) => (data.items || []).slice(0, 4)).catch(() => []);

  container.innerHTML = template();
  cacheEls(container);
  restoreForm();
  renderModelOptions();
  bindEvents();
  applyPendingInputs();
  renderLibrary();
  renderSelected();
  renderEngine();
  renderRecentResults();
  bindGlobalEvents();

  const latest = taskStore.byKind("infer")[0] || taskStore.byKind("preload")[0];
  if (latest) {
    currentTaskId = latest.id;
    currentTask = latest;
    renderTask(latest);
    if (latest.status === "running" || latest.status === "queued") {
      watch(latest.id);
    } else if (latest.result) {
      renderTaskResults(latest);
    }
  } else {
    renderTask(null);
  }
}

export function destroy() {
  exitLibManage();
  if (unwatch) {
    unwatch();
    unwatch = null;
  }
  if (engineListener) {
    window.removeEventListener("engine:updated", engineListener);
    engineListener = null;
  }
  if (taskDoneListener) {
    window.removeEventListener("task:done", taskDoneListener);
    taskDoneListener = null;
  }
}

function bindGlobalEvents() {
  if (engineListener) window.removeEventListener("engine:updated", engineListener);
  if (taskDoneListener) window.removeEventListener("task:done", taskDoneListener);
  engineListener = (event) => {
    engine = event.detail || null;
    renderEngine();
  };
  taskDoneListener = (event) => {
    const task = event.detail;
    if (!task || task.kind !== "infer") return;
    currentTaskId = task.id;
    currentTask = task;
    renderTask(task);
    if (task.result?.items?.length) renderTaskResults(task);
    refreshRecentResults();
    loadEngine().then((value) => {
      engine = value;
      renderEngine();
    });
  };
  window.addEventListener("engine:updated", engineListener);
  window.addEventListener("task:done", taskDoneListener);
}

function template() {
  return `
  <div class="infer-grid fade-enter">
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("upload")}输入音频</div>
            <div class="card-sub">支持 WAV / FLAC / MP3 / OGG，可一次选择多个文件批量转换</div>
          </div>
          <span class="badge accent" id="sel-count">0 个已选</span>
        </div>
        <div class="card-body">
          <div class="tabs" id="input-tabs">
            <button class="active" data-tab="upload">上传文件</button>
            <button data-tab="library">从素材库选择</button>
          </div>
          <div data-panel="upload" style="margin-top:14px">
            <div class="dropzone" id="dropzone">
              <div class="dz-icon">${icon("upload")}</div>
              <div class="dz-title">拖拽音频到这里，或点击选择</div>
              <div class="dz-sub">支持 WAV / FLAC / MP3 / OGG / M4A；FLAC 可直接推理，无需转换。上传完成后才能开始转换。</div>
            </div>
            <input type="file" id="file-input" accept=".wav,.flac,.mp3,.ogg,.m4a,.aac,.opus,.wma" multiple hidden>
            <div id="upload-status" class="stack-sm" style="margin-top:10px"></div>
          </div>
          <div data-panel="library" class="hidden" style="margin-top:14px">
            <div class="row" style="margin-bottom:8px">
              <div class="grow" style="position:relative">
                <input class="input input-sm" id="lib-search" placeholder="搜索 raw 中的音频…" style="padding-left:32px">
                <span class="input-icon">${icon("search")}</span>
              </div>
              <button class="btn btn-sm" id="lib-manage" title="多选并删除素材">${icon("trash")}管理</button>
              <button class="btn btn-sm btn-icon" id="lib-refresh" title="刷新">${icon("refresh")}</button>
            </div>
            <div class="row row-wrap hidden" id="lib-bulk" style="margin-bottom:8px">
              <button class="btn btn-sm" id="lib-check-all">全选当前列表</button>
              <button class="btn btn-sm btn-ghost" id="lib-check-clear">清空勾选</button>
              <button class="btn btn-sm btn-danger" id="lib-delete-checked">${icon("trash")}删除勾选</button>
              <span class="tiny faint" id="lib-check-hint">删除只影响 raw 中的音频文件</span>
            </div>
            <div class="file-list" id="lib-list"></div>
          </div>
          <div id="selected-wrap" style="margin-top:14px"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("model")}模型与设备</div>
            <div class="card-sub">首次推理会自动加载模型，通常需要几秒钟</div>
          </div>
          <a class="btn btn-sm btn-ghost" href="#/models">${icon("settings")}管理</a>
        </div>
        <div class="card-body stack-sm">
          <div class="field">
            <label>推理模型</label>
            <select class="select" id="model-select"></select>
            <div class="hint" id="model-info"></div>
          </div>
          <div class="field">
            <label>运行设备</label>
            <div class="segmented wide" id="device-seg">
              <button data-device="auto" class="active">自动</button>
              <button data-device="cuda">GPU (CUDA)</button>
              <button data-device="cpu">CPU</button>
            </div>
          </div>
          <div class="task-box" style="padding:11px 12px">
            <div class="between">
              <div class="row small">
                <span class="status-dot ${engine && engine.loaded ? "on" : ""}" id="engine-dot"></span>
                <span id="engine-label">${engine && engine.loaded ? "模型已加载" : "模型未加载"}</span>
              </div>
              <div class="row" style="gap:5px">
                <button class="btn btn-sm" id="preload-btn" ${engine && engine.loaded ? "disabled" : ""} title="把当前模型加载到显存">${icon("zap")}加载模型</button>
                <button class="btn btn-sm btn-ghost" id="unload-btn" ${engine && engine.loaded ? "" : "disabled"} title="卸载模型并释放显存">${icon("close")}卸载模型</button>
              </div>
            </div>
            <div class="hint" id="engine-detail" style="margin-top:4px"></div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>说话人 ID</label>
              <input class="input" type="number" id="spk-id" min="1" step="1" value="1">
            </div>
            <div class="field">
              <label>混合音色</label>
              <label class="switch" style="height:38px"><input type="checkbox" id="use-mix"><span class="track"></span><span class="small muted">启用</span></label>
            </div>
          </div>
          <div class="field hidden" id="mix-field">
            <label>混合权重</label>
            <input class="input mono" id="mix-text" placeholder="{1:0.7, 2:0.3}">
            <div class="hint">格式如 <span class="mono">{1:0.7, 2:0.3}</span>，权重之和需大于 0</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("tools")}转换参数</div>
            <div class="card-sub">默认值适合大多数场景，音高不合适时再调整</div>
          </div>
          <button class="btn btn-sm btn-ghost" id="reset-params">${icon("refresh")}重置</button>
        </div>
        <div class="card-body stack-sm">
          <div class="field-row">
            <div class="field">
              <label>采样方法</label>
              <div class="segmented wide" id="method-seg">
                <button data-method="euler" class="active">Euler</button>
                <button data-method="rk4">RK4</button>
              </div>
              <div class="hint">Euler 更快，适合日常试听；RK4 更精细但耗时更长。</div>
            </div>
            <div class="field">
              <label>音高提取器</label>
              <select class="select" id="pitch-extractor">
                <option value="rmvpe">RMVPE（推荐）</option>
                <option value="fcpe">FCPE（更快）</option>
                <option value="crepe">CREPE</option>
                <option value="harvest">Harvest</option>
                <option value="dio">DIO</option>
                <option value="parselmouth">Parselmouth</option>
              </select>
              <div class="hint">RMVPE 音高更稳；FCPE 速度更快；Harvest/DIO 适合低资源或特殊音色。</div>
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <label>推理步数 <span class="badge accent" id="step-badge">50</span></label>
              <div class="range-row">
                <input type="range" id="step-range" min="1" max="100" step="1" value="50">
                <input class="input number-input" type="number" id="step-num" min="1" max="300" value="50">
              </div>
              <div class="hint">步数越多，细节和稳定性通常更好，但耗时线性增加；GPU 建议 50，CPU 可先试 20。</div>
            </div>
            <div class="field">
              <label>t_start <span class="badge accent" id="ts-badge">0.70</span></label>
              <div class="range-row">
                <input type="range" id="ts-range" min="0" max="1" step="0.05" value="0.7">
                <input class="input number-input" type="number" id="ts-num" min="0" max="1" step="0.05" value="0.7">
              </div>
              <div class="hint">控制整流流起始时间；0 更接近纯扩散，1 更接近前级输出。默认 0.7。</div>
            </div>
          </div>

          <div class="field">
            <label>变调 Key <span class="badge" id="key-badge">0</span><span class="hint">半音，向上为正</span></label>
            <div class="range-row">
              <input type="range" id="key-range" min="-24" max="24" step="1" value="0">
              <input class="input number-input" type="number" id="key-num" min="-24" max="24" step="1" value="0">
            </div>
            <div class="hint">男转女常用 +12 左右，女转男常用 -12 左右；先小范围试听，避免过度变调。</div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>音区偏移 v <span class="badge" id="v-badge">0</span></label>
              <div class="range-row">
                <input type="range" id="v-range" min="-12" max="12" step="1" value="0">
                <input class="input number-input" type="number" id="v-num" min="-12" max="12" step="1" value="0">
              </div>
              <div class="hint">pc 声码器共振峰变调，±3 内效果较好</div>
            </div>
            <div class="field">
              <label>共振峰 f <span class="badge" id="f-badge">0</span></label>
              <div class="range-row">
                <input type="range" id="f-range" min="-12" max="12" step="1" value="0">
                <input class="input number-input" type="number" id="f-num" min="-12" max="12" step="1" value="0">
              </div>
              <div class="hint">仅对启用音高增强的模型生效</div>
            </div>
          </div>

          <details id="advanced">
            <summary class="small muted" style="cursor:pointer;user-select:none">高级设置</summary>
            <div class="stack-sm" style="margin-top:10px">
              <div class="field-row-3">
                <div class="field"><label>f0 最小值</label><input class="input" type="number" id="f0-min" value="50" min="1"><div class="hint">低于此值的音高会被忽略；男声可设 50–70。</div></div>
                <div class="field"><label>f0 最大值</label><input class="input" type="number" id="f0-max" value="1100" min="1"><div class="hint">高于此值的音高会被忽略；女声/高音可适当提高。</div></div>
                <div class="field"><label>响应阈值 (dB)</label><input class="input" type="number" id="threshold" value="-60" step="1"><div class="hint">静音/噪声门限；越接近 0 越严格，默认 -60。</div></div>
              </div>
              <div class="field">
                <label>输出文件名模板</label>
                <input class="input mono" id="out-template" placeholder="{stem}_{step}step_{key}key_{method}{infer_step}">
                <div class="hint">可用变量：{stem} {step} {key} {v} {f} {method} {infer_step} {t_start} {date} {time}</div>
              </div>
            </div>
          </details>
        </div>
      </div>

      <div class="card card-pad" style="background:linear-gradient(110deg,rgba(139,92,246,.16),rgba(34,211,238,.07)),rgba(15,23,38,.9);border-color:rgba(139,92,246,.28)">
        <div class="between">
          <div>
            <div class="strong" id="ready-label">准备转换</div>
            <div class="small muted" id="ready-sub">选择音频和模型后开始</div>
          </div>
          <button class="btn btn-primary btn-lg" id="start-btn">${icon("spark")}开始转换</button>
        </div>
      </div>
    </div>

    <div class="stack">
      <div class="card" id="task-card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("zap")}转换任务</div>
            <div class="card-sub">进度、日志与输出都会显示在这里</div>
          </div>
          <span id="task-status"></span>
        </div>
        <div class="card-body" id="task-panel"></div>
      </div>

      <div class="card" id="outputs-card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("music")}输出结果</div>
            <div class="card-sub">输出保存在 results 文件夹</div>
          </div>
          <a class="btn btn-sm btn-ghost" href="#/results">${icon("arrow")}结果库</a>
        </div>
        <div class="card-body" id="outputs-panel"></div>
      </div>

      <div class="card card-pad">
        <div class="row" style="align-items:flex-start">
          <div class="stat-icon cyan">${icon("info")}</div>
          <div class="stack-sm" style="gap:4px">
            <div class="strong small">参数Tips</div>
            <div class="small muted" style="line-height:1.7">
              <div>• <b>采样方法</b>：Euler 快，RK4 细。</div>
              <div>• <b>推理步数</b>：越大越细，越慢。</div>
              <div>• <b>t_start</b>：0 偏扩散，1 偏前级。</div>
              <div>• <b>变调 Key</b>：半音；男转女约 +12，女转男约 -12。</div>
              <div>• <b>音区偏移 v</b>：±3 内调整共振峰，过大易失真。</div>
              <div>• <b>共振峰 f</b>：仅音高增强模型有效。</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function cacheEls(container) {
  els.container = container;
  els.tabs = container.querySelector("#input-tabs");
  els.dropzone = container.querySelector("#dropzone");
  els.fileInput = container.querySelector("#file-input");
  els.uploadStatus = container.querySelector("#upload-status");
  els.libSearch = container.querySelector("#lib-search");
  els.libList = container.querySelector("#lib-list");
  els.libRefresh = container.querySelector("#lib-refresh");
  els.libManage = container.querySelector("#lib-manage");
  els.libBulk = container.querySelector("#lib-bulk");
  els.libDeleteChecked = container.querySelector("#lib-delete-checked");
  els.libCheckHint = container.querySelector("#lib-check-hint");
  els.selectedWrap = container.querySelector("#selected-wrap");
  els.selCount = container.querySelector("#sel-count");
  els.modelSelect = container.querySelector("#model-select");
  els.modelInfo = container.querySelector("#model-info");
  els.deviceSeg = container.querySelector("#device-seg");
  els.engineDot = container.querySelector("#engine-dot");
  els.engineLabel = container.querySelector("#engine-label");
  els.engineDetail = container.querySelector("#engine-detail");
  els.preloadBtn = container.querySelector("#preload-btn");
  els.unloadBtn = container.querySelector("#unload-btn");
  els.spkId = container.querySelector("#spk-id");
  els.useMix = container.querySelector("#use-mix");
  els.mixField = container.querySelector("#mix-field");
  els.mixText = container.querySelector("#mix-text");
  els.methodSeg = container.querySelector("#method-seg");
  els.pitchExtractor = container.querySelector("#pitch-extractor");
  els.startBtn = container.querySelector("#start-btn");
  els.taskPanel = container.querySelector("#task-panel");
  els.taskStatus = container.querySelector("#task-status");
  els.outputsPanel = container.querySelector("#outputs-panel");
  els.readyLabel = container.querySelector("#ready-label");
  els.readySub = container.querySelector("#ready-sub");
  els.advanced = container.querySelector("#advanced");
  els.outTemplate = container.querySelector("#out-template");

  els.stepRange = container.querySelector("#step-range");
  els.stepNum = container.querySelector("#step-num");
  els.stepBadge = container.querySelector("#step-badge");
  els.tsRange = container.querySelector("#ts-range");
  els.tsNum = container.querySelector("#ts-num");
  els.tsBadge = container.querySelector("#ts-badge");
  els.keyRange = container.querySelector("#key-range");
  els.keyNum = container.querySelector("#key-num");
  els.keyBadge = container.querySelector("#key-badge");
  els.vRange = container.querySelector("#v-range");
  els.vNum = container.querySelector("#v-num");
  els.vBadge = container.querySelector("#v-badge");
  els.fRange = container.querySelector("#f-range");
  els.fNum = container.querySelector("#f-num");
  els.fBadge = container.querySelector("#f-badge");
}

function bindEvents() {
  if (libManage) {
    els.libManage.classList.add("btn-primary");
    els.libBulk.classList.remove("hidden");
  }
  els.tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    els.tabs.querySelectorAll("button").forEach((btn) => btn.classList.toggle("active", btn === button));
    els.container.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.panel !== button.dataset.tab);
    });
    // Switching tabs always ends 管理模式, so a half-finished selection can
    // never leak into another tab or page.
    exitLibManage();
    if (button.dataset.tab === "library") renderLibrary();
  });

  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    if (els.fileInput.files && els.fileInput.files.length) {
      handleFiles(Array.from(els.fileInput.files));
      els.fileInput.value = "";
    }
  });
  ["dragenter", "dragover"].forEach((name) => {
    els.dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      els.dropzone.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    els.dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove("drag");
    });
  });
  els.dropzone.addEventListener("drop", (event) => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) handleFiles(files);
  });

  els.libSearch.addEventListener("input", renderLibrary);
  els.libRefresh.addEventListener("click", async () => {
    els.libRefresh.disabled = true;
    try {
      const data = await api.get("/api/infer/inputs");
      rawItems = data.items || [];
      renderLibrary();
      toast("素材库已刷新", "", "success", 1800);
    } catch (error) {
      toast("刷新失败", error.message, "error");
    } finally {
      els.libRefresh.disabled = false;
    }
  });
  els.libList.addEventListener("click", (event) => {
    const playBtn = event.target.closest("[data-play]");
    if (playBtn) {
      event.stopPropagation();
      previewAudioFile(playBtn.dataset.play);
      return;
    }
    const delBtn = event.target.closest("[data-del]");
    if (delBtn) {
      event.stopPropagation();
      deleteInputs([delBtn.dataset.del]);
      return;
    }
    if (event.target.closest("[data-check]")) return;
    const row = event.target.closest("[data-rel]");
    if (!row) return;
    toggleSelection(row.dataset.rel);
  });
  els.libList.addEventListener("change", (event) => {
    const box = event.target.closest("[data-check]");
    if (!box) return;
    if (box.checked) checked.add(box.dataset.check);
    else checked.delete(box.dataset.check);
    updateBulkBar();
  });

  els.libManage.addEventListener("click", () => {
    libManage = !libManage;
    if (!libManage) checked.clear();
    els.libManage.classList.toggle("btn-primary", libManage);
    els.libBulk.classList.toggle("hidden", !libManage);
    renderLibrary();
    updateBulkBar();
  });
  els.libCheckAll = els.container.querySelector("#lib-check-all");
  els.libCheckAll.addEventListener("click", () => {
    for (const item of filteredLibrary()) checked.add(item.rel);
    renderLibrary();
    updateBulkBar();
  });
  els.container.querySelector("#lib-check-clear").addEventListener("click", () => {
    checked.clear();
    renderLibrary();
    updateBulkBar();
  });
  els.libDeleteChecked.addEventListener("click", () => {
    const list = Array.from(checked);
    if (!list.length) {
      toast("还没有勾选音频", "先勾选要删除的文件，或点击“全选当前列表”", "warning");
      return;
    }
    deleteInputs(list);
  });

  els.modelSelect.addEventListener("change", () => {
    saveForm();
    updateModelInfo();
  });
  els.deviceSeg.addEventListener("click", (event) => {
    const button = event.target.closest("[data-device]");
    if (!button) return;
    els.deviceSeg.querySelectorAll("button").forEach((btn) => btn.classList.toggle("active", btn === button));
    saveForm();
  });
  els.methodSeg.addEventListener("click", (event) => {
    const button = event.target.closest("[data-method]");
    if (!button) return;
    els.methodSeg.querySelectorAll("button").forEach((btn) => btn.classList.toggle("active", btn === button));
    saveForm();
  });
  els.pitchExtractor.addEventListener("change", saveForm);

  els.preloadBtn.addEventListener("click", preloadModel);
  els.unloadBtn.addEventListener("click", unloadModel);
  els.useMix.addEventListener("change", () => {
    els.mixField.classList.toggle("hidden", !els.useMix.checked);
    els.spkId.disabled = els.useMix.checked;
    saveForm();
  });
  els.startBtn.addEventListener("click", startInference);

  bindPair(els.stepRange, els.stepNum, els.stepBadge, (value) => String(value));
  bindPair(els.tsRange, els.tsNum, els.tsBadge, (value) => Number(value).toFixed(2));
  bindPair(els.keyRange, els.keyNum, els.keyBadge, (value) => (value > 0 ? `+${value}` : String(value)));
  bindPair(els.vRange, els.vNum, els.vBadge, (value) => (value > 0 ? `+${value}` : String(value)));
  bindPair(els.fRange, els.fNum, els.fBadge, (value) => (value > 0 ? `+${value}` : String(value)));

  els.container.querySelector("#reset-params").addEventListener("click", () => {
    applyForm(defaultForm());
    saveForm();
    toast("已恢复默认参数", "", "success", 1800);
  });

  [els.spkId, els.mixText, els.outTemplate].forEach((el) => el.addEventListener("change", saveForm));
  ["f0-min", "f0-max", "threshold"].forEach((id) => {
    els.container.querySelector(`#${id}`).addEventListener("change", saveForm);
  });
  els.container.querySelectorAll("input").forEach((input) => input.addEventListener("change", saveForm));
}

function bindPair(range, number, badge, formatter) {
  const syncFromRange = () => {
    number.value = range.value;
    if (badge) badge.textContent = formatter(Number(range.value));
    range.style.setProperty(
      "--fill",
      `${((Number(range.value) - Number(range.min)) / (Number(range.max) - Number(range.min))) * 100}%`
    );
    saveForm();
  };
  const syncFromNumber = () => {
    let value = Number(number.value);
    if (isNaN(value)) value = Number(range.min);
    value = Math.max(Number(range.min), Math.min(Number(range.max), value));
    range.value = String(value);
    if (badge) badge.textContent = formatter(value);
    range.style.setProperty(
      "--fill",
      `${((value - Number(range.min)) / (Number(range.max) - Number(range.min))) * 100}%`
    );
    saveForm();
  };
  range.addEventListener("input", syncFromRange);
  number.addEventListener("input", syncFromNumber);
  syncFromRange();
}

function defaultForm() {
  return {
    model: preferredModel(),
    device: "auto",
    method: "euler",
    pitch_extractor: settings.default_pitch_extractor || "rmvpe",
    step: settings.default_infer_step || 50,
    t_start: settings.default_t_start ?? 0.7,
    key: 0,
    v: 0,
    f: 0,
    spk_id: 1,
    use_mix: false,
    mix: "",
    f0_min: 50,
    f0_max: 1100,
    threshold: -60,
    out_template: settings.output_template || "{stem}_{step}step_{key}key_{method}{infer_step}",
  };
}

function restoreForm() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(LS_KEY) || "null");
  } catch {
    stored = null;
  }
  const form = { ...defaultForm(), ...(stored || {}) };
  applyForm(form);
}

function applyForm(form) {
  if (form.model && models.some((model) => model.rel === form.model)) els.modelSelect.value = form.model;
  const device = form.device || "auto";
  els.deviceSeg.querySelectorAll("button").forEach((btn) => btn.classList.toggle("active", btn.dataset.device === device));
  const method = form.method || "euler";
  els.methodSeg.querySelectorAll("button").forEach((btn) => btn.classList.toggle("active", btn.dataset.method === method));
  els.pitchExtractor.value = form.pitch_extractor || "rmvpe";
  setPair(els.stepRange, els.stepNum, els.stepBadge, form.step, (v) => String(v));
  setPair(els.tsRange, els.tsNum, els.tsBadge, form.t_start, (v) => Number(v).toFixed(2));
  setPair(els.keyRange, els.keyNum, els.keyBadge, form.key, (v) => (v > 0 ? `+${v}` : String(v)));
  setPair(els.vRange, els.vNum, els.vBadge, form.v, (v) => (v > 0 ? `+${v}` : String(v)));
  setPair(els.fRange, els.fNum, els.fBadge, form.f, (v) => (v > 0 ? `+${v}` : String(v)));
  els.spkId.value = form.spk_id ?? 1;
  els.useMix.checked = Boolean(form.use_mix);
  els.mixField.classList.toggle("hidden", !els.useMix.checked);
  els.spkId.disabled = els.useMix.checked;
  els.mixText.value = form.mix || "";
  els.container.querySelector("#f0-min").value = form.f0_min ?? 50;
  els.container.querySelector("#f0-max").value = form.f0_max ?? 1100;
  els.container.querySelector("#threshold").value = form.threshold ?? -60;
  els.outTemplate.value = form.out_template || defaultForm().out_template;
  updateModelInfo();
}

function setPair(range, number, badge, value, formatter) {
  if (value === undefined || value === null || isNaN(Number(value))) return;
  const clamped = Math.max(Number(range.min), Math.min(Number(range.max), Number(value)));
  range.value = String(clamped);
  number.value = String(clamped);
  if (badge) badge.textContent = formatter(clamped);
  range.style.setProperty(
    "--fill",
    `${((clamped - Number(range.min)) / (Number(range.max) - Number(range.min))) * 100}%`
  );
}

function currentForm() {
  return {
    model: els.modelSelect.value,
    device: els.deviceSeg.querySelector("button.active")?.dataset.device || "auto",
    method: els.methodSeg.querySelector("button.active")?.dataset.method || "euler",
    pitch_extractor: els.pitchExtractor.value,
    step: Number(els.stepNum.value),
    t_start: Number(els.tsNum.value),
    key: Number(els.keyNum.value),
    v: Number(els.vNum.value),
    f: Number(els.fNum.value),
    spk_id: Number(els.spkId.value) || 1,
    use_mix: els.useMix.checked,
    mix: els.mixText.value.trim(),
    f0_min: Number(els.container.querySelector("#f0-min").value) || 50,
    f0_max: Number(els.container.querySelector("#f0-max").value) || 1100,
    threshold: Number(els.container.querySelector("#threshold").value) || -60,
    out_template: els.outTemplate.value.trim(),
  };
}

function saveForm() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(currentForm()));
  } catch {
    /* ignore */
  }
  updateReady();
}

function renderModelOptions() {
  if (!models.length) {
    els.modelSelect.innerHTML = `<option value="">未找到模型</option>`;
    updateModelInfo();
    return;
  }
  els.modelSelect.innerHTML = models
    .map((model) => {
      const step = model.step === null || model.step === undefined ? "?" : model.step;
      const size = fmtBytes(model.size);
      const warn = model.has_config ? "" : " · 缺配置";
      const base = `${model.exp} / model_${step}`;
      const label = model.label ? `${model.label} · ${base}` : base;
      return `<option value="${esc(model.rel)}">${esc(label)} (${size})${warn}</option>`;
    })
    .join("");
  const preferred = currentModelValue() || preferredModel();
  if (preferred) els.modelSelect.value = preferred;
  updateModelInfo();
}

function preferredModel() {
  const wanted = settings.default_model || "";
  const found = models.find((model) => model.rel === wanted && model.has_config);
  if (found) return found.rel;
  const withConfig = models.filter((model) => model.has_config);
  if (withConfig.length) {
    return withConfig.sort((a, b) => (b.step || 0) - (a.step || 0))[0].rel;
  }
  return models[0]?.rel || "";
}

function currentModelValue() {
  try {
    const stored = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    return stored?.model || "";
  } catch {
    return "";
  }
}

function selectedModel() {
  return models.find((model) => model.rel === els.modelSelect.value) || null;
}

function updateModelInfo() {
  const model = selectedModel();
  if (!model) {
    els.modelInfo.textContent = "请先在模型管理页面上传或训练一个模型。";
    return;
  }
  const parts = [];
  if (model.label) parts.push(`名称：${model.label}`);
  if (model.sampling_rate) parts.push(`${model.sampling_rate} Hz`);
  if (model.n_spk) parts.push(`${model.n_spk} 说话人`);
  if (model.encoder) parts.push(model.encoder);
  if (model.has_config === false) parts.push("缺少 config.yaml（推理时会自动生成）");
  els.modelInfo.textContent = parts.join(" · ") || model.rel;
  if (model.n_spk && Number(els.spkId.value) > Number(model.n_spk)) {
    els.spkId.value = 1;
  }
  updateReady();
}

function renderEngine() {
  const loaded = Boolean(engine && engine.loaded);
  window.__engineLoaded = loaded;
  els.engineDot.classList.toggle("on", loaded);
  els.engineLabel.textContent = loaded ? "模型已加载" : "模型未加载";
  if (els.preloadBtn) els.preloadBtn.disabled = loaded;
  if (els.unloadBtn) els.unloadBtn.disabled = !loaded;
  if (loaded) {
    const name = (engine.model || "").split("/").pop();
    const device = (engine.device || "").toUpperCase();
    els.engineDetail.textContent = `${name} · ${device}${engine.sampling_rate ? ` · ${engine.sampling_rate} Hz` : ""}`;
  } else {
    els.engineDetail.textContent = "首次推理会自动加载模型，也可以点“加载模型”提前载入";
  }
  const badge = document.getElementById("engine-badge");
  if (badge) badge.classList.toggle("on", loaded);
  const text = document.getElementById("engine-text");
  if (text) text.textContent = loaded ? `${(engine.model || "").split("/").pop()} 已加载` : "模型未加载";
}

function renderSelected() {
  const count = selected.size;
  els.selCount.textContent = `${count} 个已选`;
  if (!count) {
    els.selectedWrap.innerHTML = `<div class="tiny faint">尚未选择音频。可以上传，或从素材库中勾选。</div>`;
  } else {
    const items = Array.from(selected).map((rel) => {
      const item = rawItems.find((entry) => entry.rel === rel);
      const name = item ? item.name : rel.split("/").pop();
      const duration = item?.duration ? ` · ${fmtDuration(item.duration)}` : "";
      return `
        <span class="chip" title="${esc(rel)}${duration}">
          ${esc(name)}
          <button data-remove="${esc(rel)}" title="移除">${icon("close")}</button>
        </span>`;
    });
    els.selectedWrap.innerHTML = `
      <div class="between" style="margin-bottom:7px">
        <span class="tiny faint">已选择</span>
        <button class="btn btn-sm btn-ghost" id="clear-selected">清空</button>
      </div>
      <div class="selected-chips">${items.join("")}</div>`;
    els.selectedWrap.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => toggleSelection(btn.dataset.remove, false));
    });
    els.selectedWrap.querySelector("#clear-selected").addEventListener("click", () => {
      selected.clear();
      renderSelected();
      renderLibrary();
    });
  }
  updateReady();
}

function filteredLibrary() {
  const query = (els.libSearch.value || "").trim().toLowerCase();
  if (!query) return rawItems;
  return rawItems.filter(
    (item) => item.rel.toLowerCase().includes(query) || item.name.toLowerCase().includes(query)
  );
}

function renderLibrary() {
  const items = filteredLibrary();
  if (!items.length) {
    els.libList.innerHTML = rawItems.length
      ? renderEmpty("file-audio", "没有匹配的音频", "换个关键词试试")
      : renderEmpty("file-audio", "素材库为空", "上传音频后会出现在这里");
    updateBulkBar();
    return;
  }
  els.libList.innerHTML = items
    .slice(0, PAGE_LIMIT)
    .map((item) => {
      const isSelected = selected.has(item.rel);
      const isChecked = checked.has(item.rel);
      return `
        <div class="file-row ${isSelected ? "selected" : ""}" data-rel="${esc(item.rel)}">
          ${libManage ? `<input type="checkbox" class="file-check" data-check="${esc(item.rel)}" ${isChecked ? "checked" : ""} aria-label="选择">` : ""}
          <div class="file-ico">${icon("file-audio")}</div>
          <div class="grow">
            <div class="file-name">${esc(item.name)}</div>
            <div class="file-meta">${item.duration ? fmtDuration(item.duration) : "-"} · ${item.sample_rate || "?"} Hz · ${fmtBytes(item.size)}</div>
          </div>
          <div class="file-actions">
            <button class="btn btn-icon btn-ghost" data-play="${esc(item.rel)}" title="试听">${icon("play")}</button>
            ${libManage
              ? `<button class="btn btn-icon btn-ghost" data-del="${esc(item.rel)}" title="删除这个音频">${icon("trash")}</button>`
              : `<span class="badge ${isSelected ? "accent" : ""}">${isSelected ? "已选" : "选择"}</span>`}
          </div>
        </div>`;
    })
    .join("");
  updateBulkBar();
}

function exitLibManage() {
  if (!libManage && checked.size === 0) return;
  libManage = false;
  checked.clear();
  if (els.libManage) els.libManage.classList.remove("btn-primary");
  if (els.libBulk) els.libBulk.classList.add("hidden");
  if (els.libDeleteChecked) {
    els.libDeleteChecked.innerHTML = `${icon("trash")}删除勾选`;
    els.libDeleteChecked.disabled = true;
  }
  if (els.libCheckHint) els.libCheckHint.textContent = "删除只影响 raw 中的音频文件";
  if (els.libList && els.libList.isConnected) renderLibrary();
}

function updateBulkBar() {
  if (!els.libDeleteChecked) return;
  // Drop checked entries that no longer exist.
  for (const rel of Array.from(checked)) {
    if (!rawItems.some((item) => item.rel === rel)) checked.delete(rel);
  }
  const count = checked.size;
  els.libDeleteChecked.innerHTML = `${icon("trash")}删除勾选${count ? `（${count}）` : ""}`;
  els.libDeleteChecked.disabled = count === 0;
  if (els.libCheckHint) els.libCheckHint.textContent = `${count} 个已勾选 · 删除只影响 raw 中的音频文件`;
}

async function deleteInputs(paths) {
  const list = paths.filter(Boolean);
  if (!list.length) return;
  const names = list.map((rel) => rel.split("/").pop());
  const shown = names.slice(0, 20).join("、");
  const more = names.length > 20 ? ` … 等共 ${names.length} 个` : "";
  const confirmed = await confirmDialog({
    title: list.length > 1 ? "批量删除音频" : "删除音频",
    message: list.length > 1 ? `确定删除这 ${list.length} 个音频吗？` : `确定删除 ${names[0]} 吗？`,
    detail: `${shown}${more}<br>只删除 raw 中的音频文件，已生成的结果和模型不受影响，删除后无法恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (!confirmed) return;
  if (list.length >= 5) {
    const again = await confirmDialog({
      title: "再次确认删除",
      message: `真的要删除这 ${list.length} 个音频吗？`,
      detail: "删除后无法恢复，需要重新上传。",
      confirmText: "确认删除",
      danger: true,
    });
    if (!again) return;
  }
  try {
    const result = await api.post("/api/infer/inputs/delete", { paths: list });
    const removed = new Set(result.removed || []);
    for (const rel of removed) {
      selected.delete(rel);
      checked.delete(rel);
    }
    rawItems = rawItems.filter((item) => !removed.has(item.rel));
    renderLibrary();
    renderSelected();
    const failed = (result.failed || []).length + (result.missing || []).length;
    if (failed) {
      toast("部分删除失败", `成功 ${removed.size} 个，失败 ${failed} 个`, "warning", 6000);
    } else {
      toast("已删除", `${removed.size} 个音频已从素材库移除`, "success");
    }
  } catch (error) {
    toast("删除失败", error.message, "error", 7000);
  }
}

function toggleSelection(rel, force) {
  const shouldSelect = force === undefined ? !selected.has(rel) : force;
  if (shouldSelect) selected.add(rel);
  else selected.delete(rel);
  renderSelected();
  renderLibrary();
}

function previewAudioFile(rel) {
  try {
    playAudio(fileUrl(rel), rel.split("/").pop()).catch(() => toast("无法试听", "浏览器拒绝了播放", "error"));
  } catch {
    /* ignore */
  }
}

function applyPendingInputs() {
  try {
    const pending = JSON.parse(localStorage.getItem("ddsp.infer.pending") || "null");
    if (!Array.isArray(pending) || !pending.length) return;
    for (const rel of pending) {
      if (rawItems.some((item) => item.rel === rel)) selected.add(rel);
    }
    localStorage.removeItem("ddsp.infer.pending");
  } catch {
    /* ignore */
  }
}

async function handleFiles(files) {
  if (uploadBusy) {
    toast("请稍候", "正在上传上一批文件", "warning");
    return;
  }
  const audioFiles = files.filter((file) => /\.(wav|flac|mp3|ogg|m4a|aac|opus|wma)$/i.test(file.name));
  if (!audioFiles.length) {
    toast("没有可上传的音频", "请选择 WAV / FLAC / MP3 / OGG 文件", "warning");
    return;
  }
  uploadBusy = true;
  if (els.startBtn) els.startBtn.disabled = true;
  els.dropzone.classList.add("hidden");
  els.uploadStatus.innerHTML = "";
  let ok = 0;
  for (const file of audioFiles) {
    const row = document.createElement("div");
    row.className = "task-box";
    row.style.padding = "11px 12px";
    row.innerHTML = `
      <div class="between">
        <span class="small strong truncate">${esc(file.name)}</span>
        <span class="tiny mono muted">0%</span>
      </div>
      <div class="progress" style="margin-top:8px;height:6px"><i style="width:0%"></i></div>`;
    els.uploadStatus.appendChild(row);
    const pctEl = row.querySelector(".mono");
    const bar = row.querySelector(".progress > i");
    try {
      const result = await uploadFile(uploadUrl("raw", { name: file.name }), file, (ratio) => {
        const pct = Math.round(ratio * 100);
        bar.style.width = `${pct}%`;
        pctEl.textContent = `${pct}%`;
      });
      bar.style.width = "100%";
      pctEl.textContent = "完成";
      await sleep(240);
      row.remove();
      ok += 1;
      if (!rawItems.some((item) => item.rel === result.rel)) {
        rawItems.unshift({
          rel: result.rel,
          name: result.name,
          size: result.size,
          duration: result.audio?.duration ?? null,
          sample_rate: result.audio?.sample_rate ?? null,
          channels: result.audio?.channels ?? null,
        });
      }
      selected.add(result.rel);
      if (result.warnings?.length) {
        toast("上传提示", result.warnings.join("；"), "warning", 6000);
      }
    } catch (error) {
      bar.style.background = "#f87171";
      pctEl.textContent = "失败";
      toast("上传失败", `${file.name}：${error.message}`, "error", 7000);
    }
  }
  uploadBusy = false;
  if (els.startBtn) els.startBtn.disabled = false;
  els.dropzone.classList.remove("hidden");
  if (ok) {
    toast("上传完成", `${ok} 个音频已加入 raw 并选中`, "success");
    renderLibrary();
    renderSelected();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateReady() {
  if (!els.readyLabel) return;
  const count = selected.size;
  const model = selectedModel();
  els.readyLabel.textContent = count ? `准备转换 ${count} 个音频` : "准备转换";
  if (!count) els.readySub.textContent = "请先选择或上传音频";
  else if (!model) els.readySub.textContent = "请选择模型";
  else els.readySub.textContent = `${model.exp.split("/").pop()} · model_${model.step ?? "?"} · ${els.deviceSeg.querySelector("button.active")?.textContent || "自动"}`;
}

async function preloadModel() {
  const model = els.modelSelect.value;
  if (!model) {
    toast("请先选择模型", "", "warning");
    return;
  }
  els.preloadBtn.disabled = true;
  let started = false;
  try {
    const response = await api.post("/api/infer/preload", {
      model,
      device: els.deviceSeg.querySelector("button.active")?.dataset.device || "auto",
    });
    watch(response.task.id);
    currentTaskId = response.task.id;
    started = true;
    toast("正在加载模型", "首次加载通常需要几秒", "info");
  } catch (error) {
    toast("加载失败", error.message, "error", 7000);
  } finally {
    if (!started) els.preloadBtn.disabled = false;
  }
}

async function unloadModel() {
  try {
    await api.post("/api/infer/unload", {});
    engine = await loadEngine();
    renderEngine();
    toast("已释放模型", "显存已清空", "success", 2200);
  } catch (error) {
    toast("无法释放", error.message, "error");
  }
}

function watch(taskId) {
  if (unwatch) unwatch();
  unwatch = watchTask(taskId, (task) => {
    currentTaskId = task.id;
    currentTask = task;
    renderTask(task);
    if (task.status === "success" || task.status === "failed" || task.status === "canceled") {
      if (task.status === "success" && task.result?.items?.length) renderTaskResults(task);
      loadEngine().then((value) => {
        engine = value;
        renderEngine();
      });
      if (task.status === "success") refreshRecentResults();
      if (unwatch) {
        unwatch();
        unwatch = null;
      }
    }
  });
  const task = taskStore.get(taskId);
  if (task) renderTask(task);
}

function renderTask(task) {
  if (!task) {
    els.taskStatus.innerHTML = "";
    els.taskPanel.innerHTML = `
      <div class="empty" style="padding:26px 10px">
        <div class="empty-icon">${icon("zap")}</div>
        <h4>等待开始</h4>
        <p>选择音频后点击“开始转换”，这里会显示实时进度和日志。</p>
      </div>`;
    return;
  }
  els.taskStatus.innerHTML = statusBadge(task.status);
  const pct = task.progress === null || task.progress === undefined ? null : Math.round(task.progress);
  const result = task.result || {};
  const items = result.items || [];
  const device = items[0]?.device ? items[0].device.toUpperCase() : "";
  const total = result.total || selected.size || 0;
  const isRunning = task.status === "running" || task.status === "queued";
  const statusText = {
    queued: "排队中…",
    running: "正在合成…",
    success: "全部完成",
    failed: "任务失败",
    canceled: "已取消",
  }[task.status] || task.status;

  els.taskPanel.innerHTML = `
    <div class="stack-sm">
      <div class="task-box">
        <div class="between">
          <div class="grow" style="min-width:0">
            <div class="task-title truncate">${esc(task.title)}</div>
            <div class="task-msg">${esc(task.message || statusText)}</div>
          </div>
          <div class="row" style="gap:6px">
            ${isRunning ? `<span class="spinner dark"></span>` : ""}
            <span class="mono small muted">${pct === null ? "" : `${pct}%`}</span>
          </div>
        </div>
        <div class="progress ${pct === null && isRunning ? "indeterminate" : ""}" style="margin-top:10px">
          <i style="width:${pct === null ? 30 : pct}%"></i>
        </div>
        <div class="task-stats">
          <div class="task-stat"><div class="k">文件</div><div class="v">${items.length || (isRunning ? "—" : 0)}${total ? ` / ${total}` : ""}</div></div>
          <div class="task-stat"><div class="k">设备</div><div class="v">${device || (isRunning ? "…" : "—")}</div></div>
          <div class="task-stat"><div class="k">耗时</div><div class="v">${task.elapsed ? fmtDuration(task.elapsed) : "—"}</div></div>
        </div>
        <div class="row" style="margin-top:10px;gap:7px">
          <button class="btn btn-sm" id="task-log-btn">${icon("log")}查看日志</button>
          ${isRunning ? `<button class="btn btn-sm btn-danger" id="task-cancel-btn">${icon("stop")}取消</button>` : ""}
          ${isRunning ? `<span class="tiny faint">关闭页面不会中断任务</span>` : ""}
        </div>
      </div>
      ${task.error ? `<div class="notice danger">${icon("alert")}<div>${esc(task.error)}</div></div>` : ""}
      ${result.errors && result.errors.length ? `
        <div class="notice warn">${icon("alert")}<div>
          ${result.errors.length} 个文件失败：<br>
          ${result.errors.map((error) => esc(error.error)).join("<br>")}
        </div></div>` : ""}
    </div>`;

  const logBtn = els.taskPanel.querySelector("#task-log-btn");
  if (logBtn) logBtn.addEventListener("click", () => openLogViewer(task.id, task.title));
  const cancelBtn = els.taskPanel.querySelector("#task-cancel-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", async () => {
      try {
        await api.post("/api/task/cancel", { id: task.id });
        toast("正在取消任务", "", "warning");
      } catch (error) {
        toast("取消失败", error.message, "error");
      }
    });
  }
}

function renderTaskResults(task) {
  const items = task.result?.items || [];
  if (!items.length) {
    renderNoTaskResults(task);
    return;
  }
  els.outputsPanel.innerHTML = `
    <div class="stack-sm">
      ${items.map((item, index) => `
        <div class="result-card">
          <div class="rc-top">
            <div style="min-width:0">
              <div class="rc-name">${esc(item.name)}</div>
              <div class="rc-meta">
                <span class="badge accent">${esc(item.model_label || (item.model || "").split("/").pop() || "model")}</span>
                <span class="badge">${item.params?.key > 0 ? "+" : ""}${item.params?.key ?? 0} key</span>
                <span class="badge">${item.params?.method || "euler"} · ${item.params?.infer_step ?? "-"} 步</span>
                ${item.rtf ? `<span class="badge cyan">RTF ${item.rtf}</span>` : ""}
                <span class="badge">${fmtDuration(item.duration)}</span>
              </div>
            </div>
            <a class="btn btn-sm" href="${fileUrl(item.path, true)}" download>${icon("download")}下载</a>
          </div>
          <div data-player="${index}"></div>
          <div class="row between">
            <span class="tiny faint mono">${esc(item.path)}</span>
            <button class="btn btn-sm btn-ghost" data-reveal="${esc(item.path)}">${icon("folder")}所在文件夹</button>
          </div>
        </div>`).join("")}
      ${task.result.failed ? `<div class="notice warn">${icon("alert")}<div>${task.result.failed} 个文件失败，详见任务日志。</div></div>` : ""}
      <div class="notice success">${icon("check")}<div>输出已保存到 results 文件夹，可以直接试听或下载。</div></div>
    </div>`;

  items.forEach((item, index) => {
    const host = els.outputsPanel.querySelector(`[data-player="${index}"]`);
    if (host) {
      mountPlayer(host, {
        src: fileUrl(item.path),
        name: item.name,
        download: fileUrl(item.path, true),
        autoWave: index < 2,
      });
    }
  });
  els.outputsPanel.querySelectorAll("[data-reveal]").forEach((btn) => {
    btn.addEventListener("click", () => reveal(btn.dataset.reveal));
  });
}

function renderNoTaskResults(task) {
  if (task && task.status === "failed") {
    els.outputsPanel.innerHTML = `<div class="notice danger">${icon("alert")}<div>${esc(task.error || "任务失败")}</div></div>`;
  } else {
    els.outputsPanel.innerHTML = renderEmpty("music", "还没有输出", "完成一次转换后，结果会显示在这里");
  }
}

function renderRecentResults() {
  if (currentTask && currentTask.result?.items?.length) return;
  if (!recentResults.length) {
    renderNoTaskResults(null);
    return;
  }
  els.outputsPanel.innerHTML = `
    <div class="stack-sm">
      ${recentResults.map((item, index) => `
        <div class="task-box" style="padding:10px 11px">
          <div class="between" style="margin-bottom:8px">
            <span class="small strong truncate">${esc(item.name)}</span>
            <span class="tiny faint">${item.duration ? fmtDuration(item.duration) : ""}</span>
          </div>
          <div data-recent-player="${index}"></div>
        </div>`).join("")}
      <a class="btn btn-sm btn-ghost" href="#/results" style="align-self:flex-start">${icon("arrow")}查看全部结果</a>
    </div>`;
  recentResults.forEach((item, index) => {
    const host = els.outputsPanel.querySelector(`[data-recent-player="${index}"]`);
    if (host) {
      const path = item.path || `results/${item.rel}`;
      mountPlayer(host, {
        src: fileUrl(path),
        name: item.name,
        download: fileUrl(path, true),
        mini: true,
      });
    }
  });
}

async function refreshRecentResults() {
  try {
    const data = await api.get("/api/results");
    recentResults = (data.items || []).slice(0, 4);
  } catch {
    /* ignore */
  }
}

async function reveal(rel) {
  try {
    const response = await fetch(`/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: rel }),
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || "打开失败");
  } catch (error) {
    toast("无法打开文件夹", error.message, "error");
  }
}

async function startInference() {
  if (uploadBusy) {
    toast("音频仍在上传", "请等待上传完成后再开始转换", "warning");
    return;
  }
  const inputs = Array.from(selected);
  if (!inputs.length) {
    toast("请先选择音频", "可以上传文件或从素材库勾选", "warning");
    return;
  }
  const model = els.modelSelect.value;
  if (!model) {
    toast("请先选择模型", "可以到模型管理页面上传模型", "warning");
    return;
  }
  const form = currentForm();
  if (form.use_mix && !form.mix) {
    toast("请输入混合权重", '例如 {1:0.7, 2:0.3}', "warning");
    return;
  }
  els.startBtn.disabled = true;
  els.startBtn.innerHTML = `<span class="spinner"></span>提交中…`;
  try {
    const response = await api.post("/api/infer", {
      inputs,
      model,
      device: form.device,
      params: {
        key: form.key,
        formant: form.f,
        vocal_register: form.v,
        spk_id: form.spk_id,
        spk_mix: form.use_mix ? form.mix : "",
        pitch_extractor: form.pitch_extractor,
        f0_min: form.f0_min,
        f0_max: form.f0_max,
        threshold: form.threshold,
        infer_step: form.step,
        method: form.method,
        t_start: form.t_start,
        output_template: form.out_template,
      },
    });
    currentTaskId = response.task.id;
    watch(response.task.id);
    toast("任务已开始", `正在处理 ${inputs.length} 个音频`, "info");
    els.taskPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    toast("无法开始转换", error.message, "error", 8000);
    if (String(error.message || "").includes("raw 中找不到")) {
      try {
        const data = await api.get("/api/infer/inputs");
        rawItems = data.items || [];
        const available = new Set(rawItems.map((item) => item.rel));
        for (const rel of Array.from(selected)) {
          if (!available.has(rel)) selected.delete(rel);
        }
        renderLibrary();
        renderSelected();
        toast("素材库已刷新", "已移除失效的选择，请重新选择音频后重试", "info", 6000);
      } catch {
        /* ignore */
      }
    }
  } finally {
    els.startBtn.disabled = false;
    els.startBtn.innerHTML = `${icon("spark")}开始转换`;
  }
}
