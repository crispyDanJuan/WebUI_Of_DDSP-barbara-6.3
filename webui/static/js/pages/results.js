import { api, fileUrl } from "../api.js";
import {
  esc, icon, toast, fmtBytes, fmtDuration, fmtDate, mountPlayer, confirmDialog, renderEmpty, debounce,
} from "../ui.js";

let containerRef = null;
let items = [];
let search = "";
let sortBy = "new";
let listeners = [];

export async function render(container) {
  containerRef = container;
  const data = await api.get("/api/results");
  items = data.items || [];
  container.innerHTML = template();
  bind(container);
  renderList();
}

function template() {
  return `
  <div class="page-grid fade-enter">
    <div class="card hero list-hero">
      <div class="lh-icon">${icon("results")}</div>
      <div class="grow">
        <h2>结果库</h2>
        <p>共 ${items.length} 个输出文件，保存在 results 文件夹。点击播放即可试听。</p>
      </div>
      <div class="row">
        <button class="btn btn-ghost" id="open-results">${icon("folder")}打开文件夹</button>
        <button class="btn" id="refresh-results">${icon("refresh")}刷新</button>
      </div>
    </div>

    <div class="card">
      <div class="card-body" style="padding:14px 16px">
        <div class="row-wrap">
          <div class="grow" style="position:relative;min-width:220px">
            <input class="input input-sm" id="result-search" placeholder="搜索输出文件名…" style="padding-left:32px" value="${esc(search)}">
            <span class="input-icon">${icon("search")}</span>
          </div>
          <div class="segmented" id="result-sort">
            <button data-sort="new" class="${sortBy === "new" ? "active" : ""}">最新</button>
            <button data-sort="old" class="${sortBy === "old" ? "active" : ""}">最早</button>
            <button data-sort="size" class="${sortBy === "size" ? "active" : ""}">文件大小</button>
            <button data-sort="duration" class="${sortBy === "duration" ? "active" : ""}">时长</button>
          </div>
          <span class="badge" id="result-count">${items.length} 个</span>
        </div>
      </div>
    </div>

    <div class="grid-2" id="result-grid"></div>
  </div>`;
}

function bind(container) {
  container.querySelector("#open-results").addEventListener("click", openResults);
  container.querySelector("#refresh-results").addEventListener("click", async () => {
    await render(containerRef);
    toast("已刷新", "", "success", 1600);
  });
  const doSearch = debounce(() => {
    search = container.querySelector("#result-search").value.trim().toLowerCase();
    renderList();
  }, 180);
  container.querySelector("#result-search").addEventListener("input", doSearch);
  container.querySelector("#result-sort").addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort]");
    if (!button) return;
    sortBy = button.dataset.sort;
    container.querySelectorAll("#result-sort button").forEach((btn) => btn.classList.toggle("active", btn === button));
    renderList();
  });
}

function filteredItems() {
  let list = items.filter((item) => !search || item.name.toLowerCase().includes(search));
  if (sortBy === "new") list = list.sort((a, b) => b.mtime - a.mtime);
  else if (sortBy === "old") list = list.sort((a, b) => a.mtime - b.mtime);
  else if (sortBy === "size") list = list.sort((a, b) => b.size - a.size);
  else if (sortBy === "duration") list = list.sort((a, b) => (b.duration || 0) - (a.duration || 0));
  return list;
}

function renderList() {
  if (!containerRef) return;
  const grid = containerRef.querySelector("#result-grid");
  const count = containerRef.querySelector("#result-count");
  const list = filteredItems();
  count.textContent = `${list.length} 个`;
  for (const player of listeners) {
    try {
      player.destroy();
    } catch {
      /* ignore */
    }
  }
  listeners = [];
  if (!list.length) {
    grid.innerHTML = `<div class="card card-pad" style="grid-column:1/-1">${renderEmpty(
      "results",
      search ? "没有匹配的结果" : "还没有转换结果",
      search ? "换个关键词试试" : "在“推理转换”页面完成一次转换后，输出会出现在这里"
    )}</div>`;
    return;
  }
  grid.innerHTML = list.map((item, index) => resultCard(item, index)).join("");
  list.forEach((item, index) => {
    const host = grid.querySelector(`[data-player="${index}"]`);
    if (host) {
      const path = item.path || `results/${item.rel}`;
      const player = mountPlayer(host, {
        src: fileUrl(path),
        name: item.name,
        download: fileUrl(path, true),
        autoWave: index < 3,
      });
      listeners.push(player);
    }
    const replay = grid.querySelector(`[data-replay="${index}"]`);
    if (replay) replay.addEventListener("click", () => replayItem(item));
    const del = grid.querySelector(`[data-delete="${index}"]`);
    if (del) del.addEventListener("click", () => deleteItem(item));
  });
}

function resultCard(item, index) {
  const meta = item.meta || {};
  const params = meta.result?.params || {};
  const model = meta.model_label || (meta.model || meta.result?.model || "").split("/").pop();
  const path = item.path || `results/${item.rel}`;
  return `
    <div class="card result-card">
      <div class="rc-top">
        <div style="min-width:0">
          <div class="rc-name">${esc(item.name)}</div>
          <div class="rc-meta">
            ${item.duration ? `<span class="badge">${fmtDuration(item.duration)}</span>` : ""}
            <span class="badge">${fmtBytes(item.size)}</span>
            <span class="badge">${fmtDate(item.mtime)}</span>
            ${model ? `<span class="badge accent">${esc(model)}</span>` : ""}
            ${params.key !== undefined ? `<span class="badge">${params.key > 0 ? "+" : ""}${params.key} key</span>` : ""}
            ${params.infer_step ? `<span class="badge">${params.method || "euler"} · ${params.infer_step} 步</span>` : ""}
            ${meta.result?.rtf ? `<span class="badge cyan">RTF ${meta.result.rtf}</span>` : ""}
          </div>
        </div>
        <div class="row" style="gap:4px">
          <a class="btn btn-icon btn-ghost" href="${fileUrl(path, true)}" download title="下载">${icon("download")}</a>
          <button class="btn btn-icon btn-ghost" data-delete="${index}" title="删除">${icon("trash")}</button>
        </div>
      </div>
      <div data-player="${index}"></div>
      <div class="row between">
        <span class="tiny faint mono truncate" title="${esc(item.rel)}">${esc(item.rel)}</span>
        ${meta.input ? `<button class="btn btn-sm" data-replay="${index}">${icon("refresh")}再次推理</button>` : ""}
      </div>
    </div>`;
}

async function deleteItem(item) {
  const confirmed = await confirmDialog({
    title: "删除结果",
    message: `确定删除 ${item.name} 吗？`,
    detail: "音频文件和对应的参数记录都会被删除，无法恢复。",
    confirmText: "删除",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.post("/api/results/delete", { rel: item.rel });
    toast("已删除", item.name, "success", 2200);
    await render(containerRef);
  } catch (error) {
    toast("删除失败", error.message, "error");
  }
}

function replayItem(item) {
  const meta = item.meta || {};
  const params = meta.result?.params || {};
  const model = meta.model || meta.result?.model || "";
  const form = {};
  if (model) form.model = model;
  if (params.key !== undefined) form.key = params.key;
  if (params.vocal_register !== undefined) form.v = params.vocal_register;
  if (params.formant !== undefined) form.f = params.formant;
  if (params.infer_step !== undefined) form.step = params.infer_step;
  if (params.method) form.method = params.method;
  if (params.t_start !== undefined) form.t_start = params.t_start;
  if (params.pitch_extractor) form.pitch_extractor = params.pitch_extractor;
  if (params.spk_id !== undefined) form.spk_id = params.spk_id;
  if (params.spk_mix) {
    form.use_mix = true;
    form.mix = JSON.stringify(params.spk_mix).replaceAll('"', "");
  }
  try {
    localStorage.setItem("ddsp.infer.form.v2", JSON.stringify(form));
    if (meta.input) {
      const rel = meta.input.startsWith("raw/") ? meta.input.slice(4) : meta.input;
      localStorage.setItem("ddsp.infer.pending", JSON.stringify([rel]));
    }
  } catch {
    /* ignore */
  }
  location.hash = "#/infer";
}

async function openResults() {
  try {
    await api.post("/api/open", { target: "results" });
  } catch (error) {
    toast("无法打开", error.message, "error");
  }
}
