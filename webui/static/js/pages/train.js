import { api } from "../api.js";
import {
  esc, icon, toast, fmtBytes, fmtDuration, fmtDate, confirmDialog, statusBadge, openLogViewer, renderEmpty,
  openModal,
} from "../ui.js";
import { taskStore } from "../tasks.js";

let containerRef = null;
let configs = [];
let models = [];
let features = {};
let selectedConfig = "";
let configText = "";
let tb = {};
let trainTaskId = null;
let tbTimer = null;
let logText = "";
let series = [];
let metrics = {};
let currentExp = "";
let currentLogTaskId = null;
let logRenderScheduled = false;
let lastDrawnLog = "";
let tickTimer = null;
let tickBusy = false;
let tickFails = 0;
let storeUnsub = null;
const finalisedTasks = new Set();
let trainLabel = "";
let baseModel = "";
try {
  trainLabel = localStorage.getItem("ddsp.train.name") || "";
} catch {
  /* ignore */
}

export async function render(container) {
  containerRef = container;
  if (tbTimer) {
    clearInterval(tbTimer);
    tbTimer = null;
  }
  stopTicker();
  const [configsRes, modelsRes, featuresRes, tbRes] = await Promise.all([
    api.get("/api/configs").then((res) => res.configs || []).catch(() => []),
    api.get("/api/models").then((res) => res.models || []).catch(() => []),
    api.get("/api/dataset/features").catch(() => ({})),
    api.get("/api/tensorboard").catch(() => ({})),
  ]);
  configs = configsRes;
  models = modelsRes;
  features = featuresRes;
  tb = tbRes;
  if (!selectedConfig) {
    selectedConfig = configs.find((c) => c.name === "reflow-barbara.yaml")?.name || configs[0]?.name || "";
  }
  const info = configs.find((c) => c.name === selectedConfig);
  currentExp = info?.expdir || "";
  if (selectedConfig) {
    const conf = await api.get("/api/config", { name: selectedConfig });
    configText = conf.text || "";
  }
  container.innerHTML = template();
  bind(container);
  bindTask();
  refreshTensorboard();
  tbTimer = setInterval(refreshTensorboard, 2500);
}

export function destroy() {
  if (storeUnsub) {
    storeUnsub();
    storeUnsub = null;
  }
  stopTicker();
  if (tbTimer) clearInterval(tbTimer);
  tbTimer = null;
}

function template() {
  const readyTrain = features.train?.ready || 0;
  const readyVal = features.val?.ready || 0;
  const checkpoints = models
    .filter((model) => !currentExp || model.exp === currentExp)
    .sort((a, b) => (b.step || 0) - (a.step || 0));
  const device = yamlTopValue(configText, "device") || "cuda";
  const amp = yamlNestedValue(configText, "train", "amp_dtype") || "fp16";
  const batchSize = yamlNestedValue(configText, "train", "batch_size") || 48;
  const epochs = yamlNestedValue(configText, "train", "epochs") || 100000;
  const lr = yamlNestedValue(configText, "train", "lr") || 0.0001;
  const maxStepsRaw = yamlNestedValue(configText, "train", "max_steps");
  const maxSteps = maxStepsRaw === "" ? 0 : Number(maxStepsRaw) || 0;
  const intervalValRaw = yamlNestedValue(configText, "train", "interval_val");
  const intervalVal = intervalValRaw === "" ? 2000 : Number(intervalValRaw) || 2000;
  const intervalSaveRaw = yamlNestedValue(configText, "train", "interval_force_save");
  const intervalSave = intervalSaveRaw === "" ? 2000 : Number(intervalSaveRaw);
  const numWorkers = yamlNestedValue(configText, "train", "num_workers") || 2;
  const cacheAll = String(yamlNestedValue(configText, "train", "cache_all_data")).toLowerCase() === "true";
  const ready = readyTrain > 0 && readyVal > 0;

  return `
  <div class="page-grid fade-enter">
    <div class="card" id="train-status-card">
      <div class="card-head">
        <div>
          <div class="card-title">${icon("train")}训练状态</div>
          <div class="card-sub">${currentExp ? `实验目录：<span class="mono">${esc(currentExp)}</span>` : "选择配置后开始训练"}</div>
        </div>
        <div id="train-status-badge"></div>
      </div>
      <div class="card-body" id="train-status">
        <div class="empty" id="ts-empty" style="padding:20px 10px">
          <div class="empty-icon">${icon("train")}</div>
          <h4>还没有开始训练</h4>
          <p>确认数据已预处理后，点击右侧“开始 / 继续训练”。训练会从 exp 中最新的权重自动继续。</p>
        </div>
        <div class="stack-sm hidden" id="ts-panel">
          <div class="between">
            <div class="grow" style="min-width:0">
              <div class="strong truncate" id="ts-title">—</div>
              <div class="small muted" style="margin-top:3px" id="ts-msg">等待日志…</div>
            </div>
            <div class="row">
              <span class="spinner dark hidden" id="ts-spin"></span>
              <span class="mono small muted" id="ts-elapsed"></span>
            </div>
          </div>
          <div class="progress" id="ts-progress"><i id="ts-bar" style="width:0%"></i></div>
          <div class="grid-4" style="gap:10px">
            <div class="task-stat"><div class="k">STEP</div><div class="v" id="ts-step">—</div></div>
            <div class="task-stat"><div class="k">LOSS</div><div class="v" id="ts-loss">—</div></div>
            <div class="task-stat"><div class="k">LR</div><div class="v" id="ts-lr">—</div></div>
            <div class="task-stat"><div class="k">SPEED</div><div class="v" id="ts-speed">—</div></div>
          </div>
          <div class="row">
            <button class="btn btn-danger btn-sm" id="stop-train" disabled>${icon("stop")}停止训练</button>
            <button class="btn btn-sm" id="train-log-btn">${icon("log")}完整日志</button>
            <span class="tiny faint" id="ts-hint">训练开始后可在这里停止</span>
          </div>
        </div>
      </div>
    </div>

    <div class="train-grid">
      <div class="stack">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">${icon("settings")}训练配置</div>
              <div class="card-sub">常用参数修改后会保留 YAML 注释与顺序</div>
            </div>
          </div>
          <div class="card-body stack-sm">
            <div class="field">
              <label>配置文件</label>
              <select class="select" id="train-config-select">
                ${configs.map((config) => `<option value="${esc(config.name)}" ${config.name === selectedConfig ? "selected" : ""}>${esc(config.name)} · ${esc(config.device || "")} · ${esc(config.expdir || "")}</option>`).join("")}
              </select>
            </div>
            <div class="field-row-3">
              <div class="field">
                <label>训练设备</label>
                <select class="select" id="cfg-device">
                  <option value="cuda" ${device === "cuda" ? "selected" : ""}>cuda</option>
                  <option value="cpu" ${device === "cpu" ? "selected" : ""}>cpu</option>
                </select>
              </div>
              <div class="field">
                <label>AMP 精度</label>
                <select class="select" id="cfg-amp">
                  ${["fp16", "bf16", "fp32"].map((value) => `<option value="${value}" ${amp === value ? "selected" : ""}>${value}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <label>DataLoader 进程</label>
                <input class="input" type="number" id="cfg-workers" min="0" max="16" value="${numWorkers}">
                <div class="hint">受限/低权限环境建议 0；大于 0 时 Windows 可能因多进程管道权限报错。</div>
              </div>
            </div>
            <div class="field-row-3">
              <div class="field">
                <label>batch_size</label>
                <input class="input" type="number" id="cfg-batch" min="1" value="${batchSize}">
              </div>
              <div class="field">
                <label>epochs</label>
                <input class="input" type="number" id="cfg-epochs" min="1" value="${epochs}">
              </div>
              <div class="field">
                <label>学习率 lr</label>
                <input class="input" type="number" id="cfg-lr" step="0.00001" min="0" value="${lr}">
              </div>
            </div>
            <div class="field-row-3">
              <div class="field">
                <label>训练总步数 max_steps</label>
                <input class="input" type="number" id="cfg-max-steps" min="0" value="${maxSteps}">
                <div class="hint">0 = 不限制。达到此步数后自动停止，并保存最终模型。</div>
              </div>
              <div class="field">
                <label>验证 / 临时保存间隔</label>
                <input class="input" type="number" id="cfg-interval-val" min="1" value="${intervalVal}">
                <div class="hint">每隔多少步验证一次；同时保存一个可用于继续训练的临时检查点。</div>
              </div>
              <div class="field">
                <label>永久保存间隔</label>
                <input class="input" type="number" id="cfg-interval-save" min="0" value="${intervalSave}">
                <div class="hint">0 = 不保留历史检查点，只保留最新一个；已在 WebUI 里命名过的检查点不会被清理；达到总步数时仍会保存最终模型。</div>
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label>缓存全部数据</label>
                <select class="select" id="cfg-cache">
                  <option value="true" ${cacheAll ? "selected" : ""}>true</option>
                  <option value="false" ${!cacheAll ? "selected" : ""}>false</option>
                </select>
                <div class="hint">内存/显存充足时设为 true 可减少重复读取；数据很多时保持 false。</div>
              </div>
            </div>
            <div class="row">
              <button class="btn btn-primary" id="save-config">${icon("check")}保存常用参数</button>
              <span class="tiny faint">显存不足时先调小 batch_size</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">${icon("log")}YAML 编辑器</div>
              <div class="card-sub">适合修改采样率、编码器、模型结构等高级参数</div>
            </div>
          </div>
          <div class="card-body">
            <details id="yaml-details">
              <summary class="small muted" style="cursor:pointer">展开 / 收起完整配置</summary>
              <textarea class="code-editor" id="yaml-editor" spellcheck="false">${esc(configText)}</textarea>
              <div class="row" style="margin-top:8px">
                <button class="btn" id="save-yaml">${icon("check")}保存并校验</button>
                <button class="btn btn-ghost" id="reload-yaml">${icon("refresh")}重新读取</button>
                <span class="tiny faint">保存前会验证 YAML 语法</span>
              </div>
            </details>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">${icon("zap")}开始训练</div>
              <div class="card-sub">默认从零开始；也可以选择一个先前模型继续训练</div>
            </div>
          </div>
          <div class="card-body stack-sm">
            <div class="field">
              <label>模型名称 / 训练名称（可选）</label>
              <input class="input" id="train-name" maxlength="60" value="${esc(trainLabel)}" placeholder="例如：barbara 4k 柔和版">
              <div class="hint">显示在任务列表和日志标题中；训练成功后会作为最新检查点的默认名称。</div>
            </div>
            <div class="field">
              <label>先前模型（可选）</label>
              <select class="select" id="train-base-model">
                <option value="">从零开始（不加载旧权重）</option>
                ${models.map((model) => `<option value="${esc(model.rel)}" ${model.rel === baseModel ? "selected" : ""}>${esc(model.label || `model_${model.step ?? "?"}.pt`)} · step ${model.step ?? "?"}</option>`).join("")}
              </select>
              <div class="hint">不选择则从随机初始化的模型开始；选择后从该 .pt 的步数和权重继续。从零开始会写入当前实验目录，若已有同名步数模型请先备份。</div>
            </div>
            <div class="task-box" style="padding:12px">
              <div class="kv"><span class="k">训练集特征</span><span class="v ${readyTrain ? "" : "danger"}">${readyTrain}</span></div>
              <div class="kv"><span class="k">验证集特征</span><span class="v ${readyVal ? "" : "danger"}">${readyVal}</span></div>
              <div class="kv"><span class="k">计划总步数</span><span class="v">${maxSteps > 0 ? maxSteps.toLocaleString() : "不限制"}</span></div>
              <div class="kv"><span class="k">永久保存</span><span class="v">${intervalSave > 0 ? `每 ${intervalSave} 步` : "不保留历史"}</span></div>
              <div class="kv"><span class="k">显存建议</span><span class="v">4 GB+</span></div>
            </div>
            ${ready ? "" : `<div class="notice warn">${icon("alert")}<div>特征还没有准备好。请先到<a href="#/dataset" style="text-decoration:underline">数据预处理</a>页面执行预处理。</div></div>`}
            <button class="btn btn-primary btn-lg btn-block" id="start-train" ${ready ? "" : "disabled"}>${icon("train")}开始 / 继续训练</button>
            <div class="hint">不选先前模型时从零开始；选择后从该模型继续。每 ${intervalVal} 步验证一次；${maxSteps > 0 ? `达到 ${maxSteps.toLocaleString()} 步后自动停止并保存最终模型` : "总步数设为 0 时不会自动停止，需要手动停止"}。永久保存间隔为 0 时只保留最新检查点。</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">${icon("model")}检查点</div>
              <div class="card-sub">训练过程中的权重快照 · 可用于继续训练或选定阶段推理</div>
            </div>
            <button class="btn btn-sm btn-ghost" id="refresh-models">${icon("refresh")}</button>
          </div>
          <div class="card-body">
            <div class="hint" style="margin-bottom:8px">用途：训练中断后从这里继续；也可以把某一步的模型“用于推理”，比较不同训练阶段的效果。步数越高质量通常越好，但不是绝对。</div>
            <div class="stack-sm" id="checkpoint-list" style="max-height:290px;overflow:auto">
              ${checkpoints.length ? checkpoints.map(checkpointRow).join("") : renderEmpty("model", "还没有检查点", "训练开始并完成第一次验证后会生成")}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">${icon("infer")}TensorBoard</div>
              <div class="card-sub">实时查看 loss、验证音频和频谱</div>
            </div>
            <span id="tb-badge"></span>
          </div>
          <div class="card-body stack-sm">
            <div class="row">
              <button class="btn btn-primary" id="tb-start">${icon("play")}启动 TensorBoard</button>
              <button class="btn" id="tb-stop">${icon("stop")}停止</button>
              <a class="btn btn-ghost" id="tb-open" target="_blank" rel="noopener">${icon("external")}新窗口</a>
            </div>
            <div class="hint" id="tb-url"></div>
            <div id="tb-frame-wrap"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">${icon("log")}训练日志与曲线</div>
          <div class="card-sub">实时输出（每 1.5 秒刷新）</div>
        </div>
        <div class="row">
          <button class="btn btn-sm btn-ghost" id="train-full-log">${icon("log")}完整日志</button>
        </div>
      </div>
      <div class="card-body">
        <div class="chart-wrap" style="margin-bottom:6px">
          <canvas id="loss-chart"></canvas>
        </div>
        <div class="tiny faint" style="margin-bottom:10px">纵轴：loss（训练损失，越低越好） · 横轴：全局训练 step</div>
        <div class="log" id="train-log">等待训练开始…</div>
      </div>
    </div>
  </div>`;
}

function checkpointRow(model) {
  const display = model.label ? `${model.label} · model_${model.step ?? "?"}.pt` : model.name;
  return `
    <div class="checkpoint-row">
      <span class="cp-step">${model.step ?? "?"} 步</span>
      <div class="cp-meta">
        <div>${esc(display)} · ${fmtBytes(model.size)}</div>
        <div>${fmtDate(model.mtime)}</div>
      </div>
      <div class="cp-actions">
        <button class="btn btn-sm btn-ghost" data-label-model="${esc(model.rel)}">${icon("pencil")}命名</button>
        <button class="btn btn-sm" data-use-model="${esc(model.rel)}">用于推理</button>
      </div>
    </div>`;
}

function bind(container) {
  container.querySelector("#train-config-select").addEventListener("change", (event) => {
    selectedConfig = event.target.value;
    trainTaskId = null;
    currentLogTaskId = null;
    logText = "";
    series = [];
    metrics = {};
    render(container);
  });
  container.querySelector("#save-config").addEventListener("click", saveQuickConfig);
  const nameInput = container.querySelector("#train-name");
  if (nameInput) {
    nameInput.addEventListener("input", () => {
      trainLabel = nameInput.value.trim();
      try {
        localStorage.setItem("ddsp.train.name", trainLabel);
      } catch {
        /* ignore */
      }
    });
  }
  const baseSelect = container.querySelector("#train-base-model");
  if (baseSelect) {
    baseSelect.addEventListener("change", () => {
      baseModel = baseSelect.value;
    });
  }
  container.querySelector("#save-yaml").addEventListener("click", saveYaml);
  container.querySelector("#reload-yaml").addEventListener("click", async () => {
    try {
      const conf = await api.get("/api/config", { name: selectedConfig });
      configText = conf.text || "";
      container.querySelector("#yaml-editor").value = configText;
      toast("已重新读取配置", "", "success", 1800);
    } catch (error) {
      toast("读取失败", error.message, "error");
    }
  });
  container.querySelector("#start-train").addEventListener("click", startTraining);
  container.querySelector("#refresh-models").addEventListener("click", refreshModels);
  container.querySelector("#checkpoint-list").addEventListener("click", (event) => {
    const labelButton = event.target.closest("[data-label-model]");
    if (labelButton) {
      renameCheckpoint(labelButton.dataset.labelModel);
      return;
    }
    const button = event.target.closest("[data-use-model]");
    if (!button) return;
    useModel(button.dataset.useModel);
  });
  container.querySelector("#tb-start").addEventListener("click", startTensorboard);
  container.querySelector("#tb-stop").addEventListener("click", stopTensorboard);
  container.querySelector("#tb-open").addEventListener("click", (event) => {
    if (!tb.url) {
      event.preventDefault();
      toast("TensorBoard 尚未启动", "", "warning");
    }
  });
  container.querySelector("#train-full-log").addEventListener("click", () => {
    const task = trainTaskId ? taskStore.get(trainTaskId) : taskStore.byKind("train")[0];
    if (!task) {
      toast("暂无训练日志", "", "warning");
      return;
    }
    openLogViewer(task.id, "训练日志");
  });
  container.querySelector("#stop-train").addEventListener("click", stopTraining);
  container.querySelector("#train-log-btn").addEventListener("click", () => {
    if (!trainTaskId) {
      toast("暂无训练日志", "", "warning");
      return;
    }
    const task = taskStore.get(trainTaskId);
    openLogViewer(trainTaskId, task ? task.title : "训练日志");
  });

  const chart = container.querySelector("#loss-chart");
  if (chart) {
    const observer = new ResizeObserver(() => drawChart());
    observer.observe(chart);
  }
}

function yamlTopValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*([^#\\n]+)`, "m"));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : "";
}

function yamlNestedValue(text, section, key) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (/^[A-Za-z0-9_]+:/.test(line)) {
      inSection = line.startsWith(`${section}:`);
      continue;
    }
    if (!inSection) continue;
    const match = line.match(new RegExp(`^\\s{2}${key}:\\s*([^#\\n]*)`));
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, "");
  }
  return "";
}

function quickUpdates() {
  const maxStepsValue = Math.max(0, Math.floor(Number(document.getElementById("cfg-max-steps").value) || 0));
  const intervalValValue = Math.max(1, Math.floor(Number(document.getElementById("cfg-interval-val").value) || 2000));
  const intervalSaveValue = Math.max(0, Math.floor(Number(document.getElementById("cfg-interval-save").value) || 0));
  return {
    device: document.getElementById("cfg-device").value,
    "train.amp_dtype": document.getElementById("cfg-amp").value,
    "train.batch_size": Number(document.getElementById("cfg-batch").value) || 1,
    "train.epochs": Number(document.getElementById("cfg-epochs").value) || 1,
    "train.max_steps": maxStepsValue,
    "train.lr": Number(document.getElementById("cfg-lr").value) || 0.0001,
    "train.interval_val": intervalValValue,
    "train.interval_force_save": intervalSaveValue,
    "train.num_workers": Number(document.getElementById("cfg-workers").value) || 0,
    "train.cache_all_data": document.getElementById("cfg-cache").value === "true",
  };
}

async function saveQuickConfig() {
  try {
    const response = await api.post("/api/config/update", { name: selectedConfig, updates: quickUpdates() });
    configText = response.text || configText;
    const editor = document.getElementById("yaml-editor");
    if (editor) editor.value = configText;
    toast("配置已保存", "常用参数已更新；开始训练时生效", "success");
    if (containerRef) render(containerRef);
  } catch (error) {
    toast("保存失败", error.message, "error", 7000);
  }
}

async function saveYaml() {
  const text = document.getElementById("yaml-editor").value;
  try {
    await api.post("/api/config", { name: selectedConfig, text });
    configText = text;
    toast("配置已保存", "YAML 校验通过", "success");
    render(containerRef);
  } catch (error) {
    toast("保存失败", error.message, "error", 7000);
  }
}

async function startTraining() {
  const confirmed = await confirmDialog({
    title: "开始训练",
    message: `使用 ${selectedConfig} 开始 / 继续训练？`,
    detail: "训练会占用显卡并持续运行。如果 exp 目录中已有权重，会自动从最新检查点继续。",
    confirmText: "开始训练",
  });
  if (!confirmed) return;
  try {
    const nameInput = document.getElementById("train-name");
    trainLabel = (nameInput?.value || "").trim();
    baseModel = document.getElementById("train-base-model")?.value || "";
    try {
      localStorage.setItem("ddsp.train.name", trainLabel);
    } catch {
      /* ignore */
    }
    // Apply the visible quick parameters first so "总步数" takes effect even
    // if the user did not explicitly click the save button.
    const saved = await api.post("/api/config/update", { name: selectedConfig, updates: quickUpdates() });
    configText = saved.text || configText;
    const response = await api.post("/api/train/start", { config: `configs/${selectedConfig}`, name: trainLabel, base_model: baseModel });
    adoptTask(response.task.id, response.task);
    toast("训练已启动", "正在加载模型和数据…", "info");
    await taskStore.refresh();
    bindTask();
  } catch (error) {
    toast("无法开始训练", error.message, "error", 8000);
  }
}

/* --------------------------------------------------------------------------
   Live updates
   One ticker drives the status card, the log and the loss curve.  It is bound
   to an explicit task id and never silently re-binds to an older task, which
   used to make the page look frozen until a manual refresh.
   -------------------------------------------------------------------------- */
function adoptTask(taskId, task) {
  trainTaskId = taskId;
  currentLogTaskId = taskId;
  tickFails = 0;
  resetLogState();
  renderStatus(task || { id: taskId, title: "模型训练", status: "queued", message: "任务已提交，等待日志…", progress: null, elapsed: 0 });
  startTicker();
}

function resetLogState() {
  logText = "";
  lastDrawnLog = "";
  series = [];
  metrics = {};
}

function bindTask() {
  if (storeUnsub) {
    storeUnsub();
    storeUnsub = null;
  }
  if (!trainTaskId) {
    const latest = taskStore.byKind("train")[0];
    if (latest) {
      trainTaskId = latest.id;
      currentLogTaskId = latest.id;
      resetLogState();
    }
  }
  storeUnsub = taskStore.subscribe(onStoreUpdate);
  renderStatus(currentTask());
  if (trainTaskId) startTicker();
  else stopTicker();
  scheduleLogRender();
}

function currentTask() {
  if (!trainTaskId) return null;
  const task = taskStore.get(trainTaskId);
  if (task) return task;
  return {
    id: trainTaskId,
    title: "模型训练",
    status: "queued",
    message: "任务已提交，等待日志…",
    progress: null,
    elapsed: 0,
  };
}

function onStoreUpdate() {
  const newest = taskStore.byKind("train")[0] || null;
  if (!trainTaskId) {
    if (newest) adoptTask(newest.id, newest);
    return;
  }
  if (!newest || newest.id === trainTaskId) return;
  const current = taskStore.get(trainTaskId);
  const currentRunning = Boolean(current && (current.status === "running" || current.status === "queued"));
  const newestRunning = newest.status === "running" || newest.status === "queued";
  // Only follow a newer task when it is actually running and the shown one is
  // finished, so a stale store snapshot can never steal the view.
  if (newestRunning && !currentRunning) adoptTask(newest.id, newest);
}

function startTicker() {
  if (tickTimer) {
    tick();
    return;
  }
  tick();
  tickTimer = setInterval(tick, 1000);
}

function stopTicker() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  tickBusy = false;
}

async function tick() {
  if (tickBusy || !trainTaskId) return;
  const taskId = trainTaskId;
  tickBusy = true;
  try {
    const data = await api.get("/api/task", { id: taskId });
    if (taskId !== trainTaskId) return;
    tickFails = 0;
    const task = data.task;
    if (task) {
      const running = task.status === "running" || task.status === "queued";
      if (!running) {
        if (!finalisedTasks.has(task.id)) {
          finalisedTasks.add(task.id);
          await pullLog(taskId);
          renderStatus(task);
          stopTicker();
          await refreshModels();
          return;
        }
        stopTicker();
        renderStatus(task);
        return;
      }
      renderStatus(task);
    }
    await pullLog(taskId);
  } catch (error) {
    tickFails += 1;
    if (tickFails >= 3) {
      setText("#ts-msg", "无法获取训练状态，正在重试…");
      const spin = containerRef?.querySelector("#ts-spin");
      if (spin) spin.classList.add("hidden");
    }
  } finally {
    tickBusy = false;
  }
}

async function pullLog(taskId) {
  let data = null;
  try {
    const response = await fetch(`/api/task/log?id=${encodeURIComponent(taskId)}&tail=1`, { cache: "no-store" });
    data = await response.json();
  } catch {
    return;
  }
  if (!data || data.ok === false || typeof data.text !== "string") return;
  if (data.text === logText) return;
  logText = data.text;
  parseMetrics(logText);
  scheduleLogRender();
}

function stopTraining() {
  const task = trainTaskId ? taskStore.get(trainTaskId) : taskStore.byKind("train")[0];
  if (!task) return;
  confirmDialog({
    title: "停止训练",
    message: "确定要停止当前训练吗？",
    detail: "停止后不会丢失最近一次验证保存的检查点，下次“开始训练”会从该检查点继续。",
    confirmText: "停止训练",
    danger: true,
  }).then(async (confirmed) => {
    if (!confirmed) return;
    try {
      await api.post("/api/task/cancel", { id: task.id });
      toast("正在停止训练", "等待进程退出…", "warning");
    } catch (error) {
      toast("停止失败", error.message, "error");
    }
  });
}

function setText(selector, value) {
  const el = containerRef?.querySelector(selector);
  if (el && el.textContent !== value) el.textContent = value;
}

function renderStatus(task) {
  if (!containerRef) return;
  const empty = containerRef.querySelector("#ts-empty");
  const panel = containerRef.querySelector("#ts-panel");
  const badge = containerRef.querySelector("#train-status-badge");
  if (!empty || !panel || !badge) return;
  if (!task) {
    empty.classList.remove("hidden");
    panel.classList.add("hidden");
    badge.innerHTML = "";
    return;
  }
  empty.classList.add("hidden");
  panel.classList.remove("hidden");
  badge.innerHTML = statusBadge(task.status);

  const running = task.status === "running" || task.status === "queued";
  setText("#ts-title", task.title || "模型训练");
  setText("#ts-msg", task.message || (running ? "等待日志…" : "—"));
  setText("#ts-elapsed", task.elapsed ? fmtDuration(task.elapsed) : "");
  const spin = containerRef.querySelector("#ts-spin");
  if (spin) spin.classList.toggle("hidden", !running);

  const pct = task.progress === null || task.progress === undefined
    ? null
    : Math.max(0, Math.min(100, Number(task.progress)));
  const progress = containerRef.querySelector("#ts-progress");
  const bar = containerRef.querySelector("#ts-bar");
  if (progress) progress.classList.toggle("indeterminate", running && pct === null);
  if (bar) bar.style.width = `${pct === null ? 30 : pct}%`;

  let targetSteps = 0;
  try {
    targetSteps = Number(yamlNestedValue(configText, "train", "max_steps") || 0);
  } catch {
    targetSteps = 0;
  }
  setText("#ts-step", metrics.step !== undefined ? `${metrics.step}${targetSteps > 0 ? ` / ${targetSteps}` : ""}` : "—");
  setText("#ts-loss", metrics.loss !== undefined ? Number(metrics.loss).toFixed(3) : "—");
  setText("#ts-lr", metrics.lr !== undefined ? formatLR(metrics.lr) : "—");
  setText("#ts-speed", metrics.speed !== undefined ? `${Number(metrics.speed).toFixed(1)} batch/s` : "—");

  const stop = containerRef.querySelector("#stop-train");
  if (stop) stop.disabled = !running;
  setText("#ts-hint", running ? "停止后可再次点击开始继续训练；达到总步数会自动停止" : "训练已结束");
}

function parseMetrics(text) {
  series = [];
  metrics = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.includes("--- <validation> ---")) {
      metrics.validating = true;
      continue;
    }
    const match = line.match(
      /epoch:\s*(\d+)\s*\|\s*(\d+)\s*\/\s*(\d+)\s*\|.*?batch\/s:\s*([\d.]+)\s*\|.*?lr:\s*([\d.eE+\-]+)\s*\|.*?loss:\s*([\d.]+)\s*\|.*?step:\s*(\d+)/
    );
    if (!match) continue;
    metrics.epoch = Number(match[1]);
    metrics.batch = Number(match[2]);
    metrics.totalBatches = Number(match[3]);
    metrics.speed = Number(match[4]);
    metrics.lr = match[5];
    metrics.loss = Number(match[6]);
    metrics.step = Number(match[7]);
    metrics.validating = false;
    const step = metrics.step;
    if (!series.length || series[series.length - 1].step !== step) {
      series.push({ step, loss: metrics.loss });
      if (series.length > 600) series.splice(0, series.length - 600);
    }
  }
}

function formatLR(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n < 0.001) return n.toExponential(2);
  return n.toFixed(5);
}

function scheduleLogRender() {
  if (logRenderScheduled) return;
  logRenderScheduled = true;
  // Do not use requestAnimationFrame: background browser tabs throttle or
  // suspend it, which used to leave the training log frozen until a refresh.
  setTimeout(() => {
    logRenderScheduled = false;
    try {
      const log = containerRef?.querySelector("#train-log");
      if (log) {
        const text = logText || "等待训练开始…";
        if (text !== lastDrawnLog) {
          const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
          log.textContent = text.length > 200000 ? text.slice(-200000) : text;
          lastDrawnLog = text;
          if (atBottom) log.scrollTop = log.scrollHeight;
        }
      }
    } catch (error) {
      console.error("log render failed", error);
    }
    try {
      drawChart();
    } catch (error) {
      console.error("chart render failed", error);
    }
  }, 30);
}


function drawChart() {
  const canvas = containerRef?.querySelector("#loss-chart");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = rect.width;
  const height = rect.height;
  ctx.clearRect(0, 0, width, height);
  if (series.length < 2) {
    ctx.fillStyle = "rgba(148,163,184,0.45)";
    ctx.font = "11px " + getComputedStyle(document.body).fontFamily;
    ctx.fillText("loss 曲线会在训练开始后显示", 14, height / 2);
    return;
  }
  const padding = { top: 10, right: 12, bottom: 18, left: 46 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const values = series.map((point) => point.loss);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 1e-6) {
    max += 0.5;
    min -= 0.5;
  }
  const pad = (max - min) * 0.12;
  min -= pad;
  max += pad;
  const steps = series.map((point) => point.step);
  const minStep = Math.min(...steps);
  const maxStep = Math.max(...steps);
  const x = (step) => padding.left + ((step - minStep) / Math.max(1, maxStep - minStep)) * plotW;
  const y = (value) => padding.top + (1 - (value - min) / (max - min)) * plotH;

  ctx.strokeStyle = "rgba(148,163,184,0.12)";
  ctx.lineWidth = 1;
  ctx.font = "9px " + getComputedStyle(document.body).fontFamily;
  ctx.fillStyle = "rgba(148,163,184,0.6)";
  for (let i = 0; i <= 4; i += 1) {
    const value = min + ((max - min) * i) / 4;
    const yy = y(value);
    ctx.beginPath();
    ctx.moveTo(padding.left, yy);
    ctx.lineTo(width - padding.right, yy);
    ctx.stroke();
    ctx.fillText(value.toFixed(2), 4, yy + 3);
  }

  const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  gradient.addColorStop(0, "rgba(139,92,246,0.35)");
  gradient.addColorStop(1, "rgba(34,211,238,0.02)");
  ctx.beginPath();
  series.forEach((point, index) => {
    const xx = x(point.step);
    const yy = y(point.loss);
    if (index === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  ctx.lineTo(x(series[series.length - 1].step), height - padding.bottom);
  ctx.lineTo(x(series[0].step), height - padding.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  series.forEach((point, index) => {
    const xx = x(point.step);
    const yy = y(point.loss);
    if (index === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  ctx.strokeStyle = "#a78bfa";
  ctx.lineWidth = 2;
  ctx.stroke();

  const last = series[series.length - 1];
  ctx.beginPath();
  ctx.arc(x(last.step), y(last.loss), 3.2, 0, Math.PI * 2);
  ctx.fillStyle = "#22d3ee";
  ctx.fill();
  ctx.fillStyle = "rgba(148,163,184,0.7)";
  ctx.fillText(`step ${last.step}`, width - padding.right - 58, height - 3);
}

async function refreshModels() {
  try {
    const data = await api.get("/api/models");
    models = data.models || [];
    const list = containerRef.querySelector("#checkpoint-list");
    if (list) {
      const checkpoints = models
        .filter((model) => !currentExp || model.exp === currentExp)
        .sort((a, b) => (b.step || 0) - (a.step || 0));
      list.innerHTML = checkpoints.length
        ? checkpoints.map(checkpointRow).join("")
        : renderEmpty("model", "还没有检查点", "训练开始并完成第一次验证后会生成");
    }
  } catch {
    /* ignore */
  }
}

function renameCheckpoint(rel) {
  const model = models.find((item) => item.rel === rel);
  const current = model?.label || "";
  openModal({
    title: "检查点显示名称",
    body: `
      <div class="stack-sm">
        <div class="notice">${icon("info")}<div>名称只用于 WebUI 显示，不会修改权重文件或训练配置。适合区分不同角色、数据集和训练阶段。</div></div>
        <div class="field">
          <label>名称 / 备注</label>
          <input class="input" id="cp-label-input" maxlength="60" value="${esc(current)}" placeholder="例如：角色A · 4000步 · 柔和版">
          <div class="hint">留空可恢复为文件名。</div>
        </div>
      </div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="cp-label-ok">保存名称</button>`,
    onMount: ({ root, close }) => {
      const input = root.querySelector("#cp-label-input");
      input.focus();
      input.select();
      const save = async () => {
        try {
          const res = await api.post("/api/models/label", { model: rel, label: input.value.trim() });
          const saved = res.label || input.value.trim();
          toast("检查点名称已保存", saved || "已恢复文件名", "success");
          close();
          await refreshModels();
        } catch (error) {
          toast("保存失败", error.message, "error");
        }
      };
      root.querySelector("#cp-label-ok").addEventListener("click", save);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") save();
      });
    },
  });
}

function useModel(rel) {
  try {
    const key = "ddsp.infer.form.v2";
    const stored = JSON.parse(localStorage.getItem(key) || "{}");
    stored.model = rel;
    localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    /* ignore */
  }
  location.hash = "#/infer";
}

async function startTensorboard() {
  try {
    const response = await api.post("/api/tensorboard/start", {});
    toast("TensorBoard 正在启动", `端口 ${response.port}`, "info");
    tb = await api.get("/api/tensorboard");
    refreshTensorboard();
  } catch (error) {
    toast("启动失败", error.message, "error", 7000);
  }
}

async function stopTensorboard() {
  try {
    await api.post("/api/tensorboard/stop", {});
    tb = {};
    refreshTensorboard();
    toast("TensorBoard 已停止", "", "success", 2200);
  } catch (error) {
    toast("停止失败", error.message, "error");
  }
}

function refreshTensorboard() {
  if (!containerRef) return;
  api.get("/api/tensorboard").then((data) => {
    tb = data || {};
    const badge = containerRef.querySelector("#tb-badge");
    const urlEl = containerRef.querySelector("#tb-url");
    const frameWrap = containerRef.querySelector("#tb-frame-wrap");
    const open = containerRef.querySelector("#tb-open");
    if (!badge || !urlEl || !frameWrap || !open) return;
    if (tb.running && tb.alive) {
      badge.innerHTML = `<span class="badge success"><span class="dot"></span>运行中</span>`;
      urlEl.innerHTML = `地址：<a class="mono" href="${esc(tb.url)}" target="_blank" rel="noopener" style="text-decoration:underline">${esc(tb.url)}</a>`;
      open.href = tb.url;
      if (!frameWrap.querySelector("iframe")) {
        frameWrap.innerHTML = `
          <div class="row between" style="margin-bottom:6px">
            <span class="tiny faint">内嵌预览（如空白请点“新窗口”）</span>
            <button class="btn btn-sm btn-ghost" id="tb-toggle-frame">显示</button>
          </div>
          <iframe class="tensorboard-frame hidden" id="tb-frame" title="TensorBoard"></iframe>`;
        const toggle = frameWrap.querySelector("#tb-toggle-frame");
        toggle.addEventListener("click", () => {
          const frame = frameWrap.querySelector("#tb-frame");
          frame.classList.toggle("hidden");
          if (!frame.src && tb.url) frame.src = tb.url;
          toggle.textContent = frame.classList.contains("hidden") ? "显示" : "隐藏";
        });
      }
    } else if (tb.running) {
      badge.innerHTML = `<span class="badge warn"><span class="dot"></span>启动中</span>`;
      urlEl.textContent = `端口 ${tb.port}，等待服务就绪…`;
    } else {
      badge.innerHTML = `<span class="badge"><span class="dot"></span>未启动</span>`;
      urlEl.textContent = "TensorBoard 未启动。训练开始后建议打开，查看 loss 和验证音频。";
      open.removeAttribute("href");
      frameWrap.innerHTML = "";
    }
  }).catch(() => {});
}
