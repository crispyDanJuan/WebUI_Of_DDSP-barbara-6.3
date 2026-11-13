import { api, fileUrl, uploadFile, uploadUrl } from "../api.js";
import {
  esc, icon, toast, fmtBytes, fmtDuration, confirmDialog, renderEmpty, statusBadge, openLogViewer,
  playAudio,
} from "../ui.js";
import { taskStore, watchTask } from "../tasks.js";

let containerRef = null;
let data = { train: [], val: [], stats: {}, features: {} };
let configs = [];
let currentSplit = "train";
let searchText = "";
let selectedConfig = "";
let device = "auto";
let workers = 1;
let uploadBusy = false;
let unwatch = null;
let activeTask = null;
let selectionMode = false;
const selected = new Set();

export async function render(container) {
  containerRef = container;
  [data, configs] = await Promise.all([
    api.get("/api/dataset"),
    api.get("/api/configs").then((res) => res.configs || []).catch(() => []),
  ]);
  if (!selectedConfig) {
    selectedConfig = configs.find((c) => c.name === "reflow-barbara.yaml")?.name || configs[0]?.name || "";
  }
  container.innerHTML = template();
  bind(container);
  renderTaskPanel();
  bindTask();
}

export function destroy() {
  if (unwatch) {
    unwatch();
    unwatch = null;
  }
}

function template() {
  const stats = data.stats || {};
  const features = data.features || {};
  const trainReady = features.train?.ready || 0;
  const valReady = features.val?.ready || 0;
  const audioTrain = stats.train_count || 0;
  const audioVal = stats.val_count || 0;
  const splitItems = currentSplit === "train" ? data.train : data.val;
  const filtered = splitItems.filter((item) => !searchText || item.name.toLowerCase().includes(searchText));

  return `
  <div class="page-grid fade-enter">
    <div class="grid-4">
      ${statCard("data", "训练集音频", audioTrain, `${fmtDuration(stats.train_duration || 0)} 总时长`, "cyan")}
      ${statCard("check", "验证集音频", audioVal, `${fmtDuration(stats.val_duration || 0)} 总时长`, "green")}
      ${statCard("cpu", "特征就绪", trainReady, `训练集 ${trainReady}/${audioTrain}`, "amber")}
      ${statCard("model", "说话人目录", (stats.speakers || []).length || 1, (stats.speakers || []).join(" / ") || "单说话人", "")}
    </div>

    <div class="notice">
      ${icon("info")}
      <div>数据要求：44.1kHz、16bit、单声道 WAV；每个切片不少于 2 秒。建议训练集约 1000 个切片，验证集约 10 个。</div>
    </div>

    <div class="grid-2" style="align-items:start">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("data")}数据集管理</div>
            <div class="card-sub">上传、试听和删除训练/验证音频</div>
          </div>
          <button class="btn btn-sm btn-ghost" id="refresh-data">${icon("refresh")}刷新</button>
        </div>
        <div class="card-body">
          <div class="tabs" id="split-tabs">
            <button data-split="train" class="${currentSplit === "train" ? "active" : ""}">训练集 · ${audioTrain}</button>
            <button data-split="val" class="${currentSplit === "val" ? "active" : ""}">验证集 · ${audioVal}</button>
          </div>
          <div class="stack-sm" style="margin-top:14px">
            <div class="dropzone" id="data-dropzone">
              <div class="dz-icon">${icon("upload")}</div>
              <div class="dz-title">拖拽 WAV / FLAC 到这里，或点击上传</div>
              <div class="dz-sub">上传到${currentSplit === "train" ? "训练集" : "验证集"}，可一次选择多个文件；FLAC 会自动转换为 WAV</div>
            </div>
            <input type="file" id="data-file" accept=".wav,.flac" multiple hidden>
            <div class="field-row">
              <div class="field">
                <label>说话人目录（可选）</label>
                <input class="input input-sm" id="spk-dir" placeholder="单说话人留空；多说话人填 1、2…">
              </div>
              <div class="field">
                <label>操作</label>
                <button class="btn btn-sm" id="pick-data-file">${icon("plus")}选择文件</button>
              </div>
            </div>
            <div id="data-upload-status" class="stack-sm"></div>
          </div>
          <hr class="hr" style="margin:14px 0">
          <div class="row" style="margin-bottom:8px">
            <input class="input input-sm grow" id="data-search" placeholder="搜索文件名…" value="${esc(searchText)}">
            <button class="btn btn-sm ${selectionMode ? "btn-primary" : ""}" id="toggle-select">${icon("check")}${selectionMode ? "多选中" : "多选"}</button>
          </div>
          <div class="row row-wrap" id="selection-actions" style="margin-bottom:8px;${selectionMode ? "" : "display:none"}">
            <button class="btn btn-sm" id="select-all">全选当前列表</button>
            <button class="btn btn-sm" id="clear-selected">清空选择</button>
            <button class="btn btn-sm btn-danger" id="delete-selected">删除选中（${selected.size}）</button>
            <button class="btn btn-sm btn-danger" id="delete-all">全部删除当前数据集</button>
          </div>
          <div class="file-list" id="data-list" style="max-height:360px">
            ${filtered.length ? filtered.map((item) => dataRow(item, currentSplit)).join("") : renderEmpty("file-audio", "暂无音频", "上传或切换数据集查看")}
          </div>
          <div class="tiny faint" style="margin-top:8px">显示 ${Math.min(filtered.length, 500)} / ${filtered.length} 个文件</div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">${icon("spark")}划分验证集</div>
              <div class="card-sub">从训练集随机移动一部分音频到验证集</div>
            </div>
          </div>
          <div class="card-body stack-sm">
            <div class="field-row">
              <div class="field">
                <label>抽取数量</label>
                <input class="input" type="number" id="draw-count" min="1" max="100" value="10">
              </div>
              <div class="field">
                <label>最短时长（秒）</label>
                <input class="input" type="number" id="draw-min" min="0" step="0.5" value="2">
              </div>
            </div>
            <button class="btn" id="draw-btn">${icon("spark")}随机划分验证集</button>
            <div class="hint">会直接移动文件（不是复制）。建议验证集 10 个左右。移动后请重新执行预处理，让训练/验证特征与音频保持一致。</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">${icon("cpu")}执行预处理</div>
              <div class="card-sub">提取 units / f0 / volume / mel 特征</div>
            </div>
          </div>
          <div class="card-body stack-sm">
            <div class="field">
              <label>配置文件</label>
              <select class="select" id="pre-config">
                ${configs.map((config) => `<option value="${esc(config.name)}" ${config.name === selectedConfig ? "selected" : ""}>${esc(config.name)} · ${esc(config.expdir || "")}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>运行设备</label>
              <div class="segmented wide" id="pre-device">
                <button data-device="auto" class="${device === "auto" ? "active" : ""}">自动</button>
                <button data-device="cuda" class="${device === "cuda" ? "active" : ""}">GPU</button>
                <button data-device="cpu" class="${device === "cpu" ? "active" : ""}">CPU</button>
              </div>
            </div>
            <div class="field">
              <label>并行进程数</label>
              <input class="input" type="number" id="pre-workers" min="1" max="8" value="${workers}">
              <div class="hint">每个进程都会加载一份提取器；显存有限时建议 1–2。</div>
            </div>
            ${audioTrain === 0 || audioVal === 0 ? `<div class="notice warn">${icon("alert")}<div>需要同时存在训练集和验证集音频才能预处理。</div></div>` : ""}
            <button class="btn btn-primary" id="pre-start" ${audioTrain === 0 || audioVal === 0 ? "disabled" : ""}>${icon("zap")}开始预处理</button>
            <div id="pre-task"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">${icon("check")}特征状态</div>
              <div class="card-sub">预处理完成后的文件计数</div>
            </div>
            <button class="btn btn-sm btn-danger" id="clear-features">${icon("trash")}清理</button>
          </div>
          <div class="card-body">
            <div class="grid-2" style="gap:10px">
              ${featureBlock("训练集", features.train)}
              ${featureBlock("验证集", features.val)}
            </div>
            <div class="hint" style="margin-top:10px">修改数据集后需要重新预处理；训练会读取这里的特征。</div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function statCard(iconName, label, value, foot, tone) {
  return `
    <div class="card stat">
      <div class="between">
        <div class="stat-label">${esc(label)}</div>
        <div class="stat-icon ${tone}">${icon(iconName)}</div>
      </div>
      <div class="stat-value">${value}<small>个</small></div>
      <div class="stat-foot">${esc(foot)}</div>
    </div>`;
}

function dataRow(item, split) {
  const key = `${split}/${item.rel}`;
  return `
    <div class="file-row" data-file="${esc(item.rel)}">
      ${selectionMode ? `<input type="checkbox" class="file-check" data-select="${esc(key)}" ${selected.has(key) ? "checked" : ""} aria-label="选择">` : ""}
      <div class="file-ico">${icon("file-audio")}</div>
      <div class="grow">
        <div class="file-name">${esc(item.rel)}</div>
        <div class="file-meta">${item.duration ? fmtDuration(item.duration) : "-"} · ${item.sample_rate || "?"} Hz · ${item.channels || "?"} ch · ${fmtBytes(item.size)}</div>
      </div>
      <div class="file-actions">
        <button class="btn btn-icon btn-ghost" data-play="${esc(item.rel)}" title="试听">${icon("play")}</button>
        <button class="btn btn-icon btn-ghost" data-del="${esc(item.rel)}" data-split="${split}" title="删除">${icon("trash")}</button>
      </div>
    </div>`;
}

function featureBlock(label, info = {}) {
  const rows = [
    ["units", info.units || 0],
    ["f0", info.f0 || 0],
    ["volume", info.volume || 0],
    ["mel", info.mel || 0],
  ];
  return `
    <div class="task-box" style="padding:11px 12px">
      <div class="between" style="margin-bottom:6px">
        <span class="small strong">${esc(label)}</span>
        <span class="badge ${info.ready ? "success" : ""}">${info.ready ? "就绪" : "未处理"}</span>
      </div>
      ${rows.map(([key, value]) => `<div class="kv" style="padding:3px 0;font-size:11px"><span class="k">${key}</span><span class="v">${value}</span></div>`).join("")}
    </div>`;
}

function bind(container) {
  container.querySelector("#refresh-data").addEventListener("click", refresh);
  container.querySelector("#split-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-split]");
    if (!button) return;
    currentSplit = button.dataset.split;
    searchText = "";
    selected.clear();
    refresh();
  });
  container.querySelector("#data-search").addEventListener("input", (event) => {
    searchText = event.target.value.trim().toLowerCase();
    // Re-render only the list to keep focus in the input.
    const filtered = (currentSplit === "train" ? data.train : data.val).filter(
      (item) => !searchText || item.name.toLowerCase().includes(searchText)
    );
    const list = container.querySelector("#data-list");
    list.innerHTML = filtered.length
      ? filtered.slice(0, 500).map((item) => dataRow(item, currentSplit)).join("")
      : renderEmpty("file-audio", "没有匹配的文件", "换个关键词试试");
    bindList(list);
  });

  container.querySelector("#pick-data-file").addEventListener("click", () => container.querySelector("#data-file").click());
  container.querySelector("#data-dropzone").addEventListener("click", () => container.querySelector("#data-file").click());
  container.querySelector("#data-file").addEventListener("change", (event) => {
    if (event.target.files?.length) uploadFiles(Array.from(event.target.files));
    event.target.value = "";
  });
  ["dragenter", "dragover"].forEach((name) => {
    container.querySelector("#data-dropzone").addEventListener(name, (event) => {
      event.preventDefault();
      container.querySelector("#data-dropzone").classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    container.querySelector("#data-dropzone").addEventListener(name, (event) => {
      event.preventDefault();
      container.querySelector("#data-dropzone").classList.remove("drag");
    });
  });
  container.querySelector("#data-dropzone").addEventListener("drop", (event) => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) uploadFiles(files);
  });

  bindList(container.querySelector("#data-list"));

  container.querySelector("#toggle-select").addEventListener("click", () => {
    selectionMode = !selectionMode;
    if (!selectionMode) selected.clear();
    refresh();
  });
  container.querySelector("#select-all").addEventListener("click", () => {
    const items = currentSplit === "train" ? data.train : data.val;
    const filtered = items.filter((item) => !searchText || item.name.toLowerCase().includes(searchText));
    filtered.forEach((item) => selected.add(`${currentSplit}/${item.rel}`));
    refresh();
  });
  container.querySelector("#clear-selected").addEventListener("click", () => {
    selected.clear();
    refresh();
  });
  container.querySelector("#delete-selected").addEventListener("click", () => deleteSelected(false));
  container.querySelector("#delete-all").addEventListener("click", () => deleteSelected(true));

  container.querySelector("#draw-btn").addEventListener("click", drawValidation);
  container.querySelector("#pre-config").addEventListener("change", (event) => {
    selectedConfig = event.target.value;
  });
  container.querySelector("#pre-device").addEventListener("click", (event) => {
    const button = event.target.closest("[data-device]");
    if (!button) return;
    device = button.dataset.device;
    container.querySelectorAll("#pre-device button").forEach((btn) => btn.classList.toggle("active", btn === button));
  });
  container.querySelector("#pre-workers").addEventListener("change", (event) => {
    workers = Math.max(1, Math.min(8, Number(event.target.value) || 1));
    event.target.value = workers;
  });
  container.querySelector("#pre-start").addEventListener("click", startPreprocess);
  container.querySelector("#clear-features").addEventListener("click", clearFeatures);
}

function bindList(list) {
  list.querySelectorAll("[data-select]").forEach((box) => {
    box.addEventListener("change", () => {
      if (box.checked) selected.add(box.dataset.select);
      else selected.delete(box.dataset.select);
      const button = containerRef.querySelector("#delete-selected");
      if (button) button.textContent = `删除选中（${selected.size}）`;
    });
  });
  list.querySelectorAll("[data-play]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const split = currentSplit;
      playAudio(fileUrl(`data/${split}/audio/${btn.dataset.play}`), btn.dataset.play)
        .catch(() => toast("无法试听", "浏览器拒绝播放", "error"));
    });
  });
  list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const rel = btn.dataset.del;
      const split = btn.dataset.split;
      const confirmed = await confirmDialog({
        title: "删除音频",
        message: `确定删除 ${rel} 吗？`,
        detail: "同时会删除该文件已生成的特征（units / f0 / volume / mel）。",
        confirmText: "删除",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api.post("/api/dataset/delete", { split, rel, with_features: true });
        toast("已删除", rel, "success", 2500);
        refresh();
      } catch (error) {
        toast("删除失败", error.message, "error");
      }
    });
  });
}

async function deleteSelected(all) {
  const items = currentSplit === "train" ? data.train : data.val;
  const targets = all
    ? items.map((item) => `${currentSplit}/${item.rel}`)
    : [...selected];
  if (!targets.length) {
    toast(all ? "当前数据集没有文件" : "还没有选择文件", "请先勾选要删除的音频", "warning");
    return;
  }
  const names = targets.map((key) => key.split("/").slice(1).join("/"));
  const shown = names.slice(0, 25).join("、");
  const more = names.length > 25 ? ` … 等共 ${names.length} 个` : "";
  const confirmed = await confirmDialog({
    title: all ? "全部删除" : "删除选中的音频",
    message: all ? `确定删除当前${currentSplit === "train" ? "训练集" : "验证集"}全部 ${names.length} 个音频吗？` : `确定删除选中的 ${names.length} 个音频吗？`,
    detail: `即将删除：${shown}${more}。同时会删除对应的 units / f0 / volume / mel 特征，删除后不可恢复。`,
    confirmText: "确认删除",
    danger: true,
  });
  if (!confirmed) return;
  let ok = 0;
  let failed = 0;
  for (const key of targets) {
    const [split, ...rest] = key.split("/");
    try {
      await api.post("/api/dataset/delete", { split, rel: rest.join("/"), with_features: true });
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  selected.clear();
  selectionMode = false;
  toast("删除完成", failed ? `成功 ${ok} 个，失败 ${failed} 个` : `已删除 ${ok} 个文件`, failed ? "warning" : "success", 4000);
  await refresh();
}


async function uploadFiles(files) {
  if (uploadBusy) {
    toast("请稍候", "正在上传上一批文件", "warning");
    return;
  }
  const audio = files.filter((file) => /\.(wav|flac)$/i.test(file.name));
  if (!audio.length) {
    toast("没有可上传的音频", "训练数据只支持 WAV / FLAC", "warning");
    return;
  }
  const spk = containerRef.querySelector("#spk-dir").value.trim();
  if (spk && !/^\d+$/.test(spk)) {
    toast("说话人目录无效", "请填写正整数，例如 1、2", "warning");
    return;
  }
  uploadBusy = true;
  const status = containerRef.querySelector("#data-upload-status");
  status.innerHTML = "";
  let ok = 0;
  for (const file of audio) {
    const row = document.createElement("div");
    row.className = "task-box";
    row.style.padding = "10px 11px";
    row.innerHTML = `
      <div class="between"><span class="small strong truncate">${esc(file.name)}</span><span class="tiny mono muted">0%</span></div>
      <div class="progress" style="margin-top:7px;height:5px"><i style="width:0%"></i></div>`;
    status.appendChild(row);
    const pctEl = row.querySelector(".mono");
    const bar = row.querySelector(".progress > i");
    try {
      const result = await uploadFile(
        uploadUrl("dataset", { name: file.name, split: currentSplit, spk }),
        file,
        (ratio) => {
          const pct = Math.round(ratio * 100);
          bar.style.width = `${pct}%`;
          pctEl.textContent = `${pct}%`;
        }
      );
      bar.style.width = "100%";
      pctEl.textContent = "完成";
      ok += 1;
      if (result.warnings?.length) toast("上传提示", result.warnings.join("；"), "warning", 6000);
      await sleep(180);
      row.remove();
    } catch (error) {
      bar.style.background = "#f87171";
      pctEl.textContent = "失败";
      toast("上传失败", `${file.name}：${error.message}`, "error", 7000);
    }
  }
  uploadBusy = false;
  if (ok) {
    toast("上传完成", `${ok} 个文件已加入${currentSplit === "train" ? "训练集" : "验证集"}`, "success");
    refresh();
  }
}

async function drawValidation() {
  const count = Math.max(1, Number(containerRef.querySelector("#draw-count").value) || 10);
  const minDuration = Number(containerRef.querySelector("#draw-min").value) || 2;
  const confirmed = await confirmDialog({
    title: "划分验证集",
    message: `从训练集随机移动 ${count} 个音频到验证集？`,
    detail: "文件会被移动（不是复制）。如果目标目录已有同名文件，会自动改名。",
    confirmText: "开始划分",
  });
  if (!confirmed) return;
  try {
    const result = await api.post("/api/dataset/draw", { count, min_duration: minDuration });
    toast("划分完成", `移动了 ${result.count} 个文件到验证集`, "success");
    refresh();
  } catch (error) {
    toast("划分失败", error.message, "error");
  }
}

async function startPreprocess() {
  if (!selectedConfig) {
    toast("请选择配置文件", "", "warning");
    return;
  }
  try {
    const response = await api.post("/api/dataset/preprocess", {
      config: `configs/${selectedConfig}`,
      device,
      workers,
    });
    activeTask = response.task;
    toast("预处理已开始", "完成后特征会显示在右侧", "info");
    renderTaskPanel();
    bindTask();
  } catch (error) {
    toast("无法开始预处理", error.message, "error", 7000);
  }
}

function renderTaskPanel() {
  if (!containerRef) return;
  const panel = containerRef.querySelector("#pre-task");
  if (!panel) return;
  const task = activeTask && taskStore.get(activeTask.id) ? taskStore.get(activeTask.id) : taskStore.byKind("preprocess")[0];
  if (!task) {
    panel.innerHTML = "";
    return;
  }
  const pct = task.progress === null || task.progress === undefined ? null : Math.round(task.progress);
  panel.innerHTML = `
    <div class="task-box" style="margin-top:4px">
      <div class="between">
        <span class="small strong truncate">${esc(task.title)}</span>
        ${statusBadge(task.status)}
      </div>
      <div class="task-msg">${esc(task.message || "")}</div>
      <div class="progress ${pct === null && task.status === "running" ? "indeterminate" : ""}" style="margin-top:9px;height:6px">
        <i style="width:${pct === null ? 30 : pct}%"></i>
      </div>
      <div class="row" style="margin-top:8px;gap:6px">
        <button class="btn btn-sm" id="pre-log">${icon("log")}日志</button>
        ${task.status === "running" ? `<button class="btn btn-sm btn-danger" id="pre-cancel">${icon("stop")}取消</button>` : ""}
        <span class="tiny faint">${task.elapsed ? fmtDuration(task.elapsed) : ""}</span>
      </div>
    </div>`;
  panel.querySelector("#pre-log").addEventListener("click", () => openLogViewer(task.id, task.title));
  const cancel = panel.querySelector("#pre-cancel");
  if (cancel) {
    cancel.addEventListener("click", async () => {
      try {
        await api.post("/api/task/cancel", { id: task.id });
        toast("正在取消预处理", "", "warning");
      } catch (error) {
        toast("取消失败", error.message, "error");
      }
    });
  }
}

function bindTask() {
  if (unwatch) unwatch();
  const task = activeTask || taskStore.byKind("preprocess")[0];
  if (!task) return;
  let reloaded = false;
  let wasRunning = task.status === "running" || task.status === "queued";
  unwatch = watchTask(task.id, (updated) => {
    activeTask = updated;
    renderTaskPanel();
    if (updated.status === "running" || updated.status === "queued") wasRunning = true;
    if ((updated.status === "success" || updated.status === "failed" || updated.status === "canceled") && wasRunning && !reloaded) {
      reloaded = true;
      setTimeout(refresh, 600);
    }
  });
}

async function clearFeatures() {
  const confirmed = await confirmDialog({
    title: "清理特征文件",
    message: "删除所有已生成的 units / f0 / volume / mel 特征？",
    detail: "音频文件不会被删除，但下次训练前必须重新执行预处理。",
    confirmText: "清理",
    danger: true,
  });
  if (!confirmed) return;
  try {
    const result = await api.post("/api/dataset/clear-features", { split: "all" });
    toast("已清理", `删除了 ${result.removed} 个文件/目录`, "success");
    refresh();
  } catch (error) {
    toast("清理失败", error.message, "error");
  }
}

async function refresh() {
  if (containerRef) await render(containerRef);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
