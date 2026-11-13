import { api, fileUrl, uploadFile, uploadUrl } from "../api.js";
import {
  esc, icon, toast, fmtBytes, fmtDate, confirmDialog, openModal, renderEmpty,
} from "../ui.js";

let containerRef = null;
let models = [];
let configs = [];
let defaultModel = "";
let uploadBusy = false;

export async function render(container) {
  containerRef = container;
  [models, configs] = await Promise.all([
    api.get("/api/models").then((res) => res.models || []).catch(() => []),
    api.get("/api/configs").then((res) => res.configs || []).catch(() => []),
  ]);
  const data = await api.get("/api/models").catch(() => ({}));
  defaultModel = data.default_model || "";
  container.innerHTML = template();
  bind(container);
}

function template() {
  const withConfig = models.filter((model) => model.has_config).length;
  return `
  <div class="page-grid fade-enter">
    <div class="card hero list-hero">
      <div class="lh-icon">${icon("model")}</div>
      <div class="grow">
        <h2>模型管理</h2>
        <p>共 ${models.length} 个权重，${withConfig} 个包含推理配置。模型放在 exp 目录中，训练会自动生成新检查点。</p>
      </div>
      <div class="row">
        <button class="btn btn-ghost" id="open-exp">${icon("folder")}打开 exp</button>
        <button class="btn btn-primary" id="focus-upload">${icon("upload")}上传模型</button>
      </div>
    </div>

    <div class="card" id="upload-card">
      <div class="card-head">
        <div>
          <div class="card-title">${icon("upload")}上传模型权重</div>
          <div class="card-sub">支持 .pt / .ckpt / .pth；缺失 config.yaml 时会自动从基础配置生成</div>
        </div>
      </div>
      <div class="card-body">
        <div class="grid-2">
          <div class="field">
            <label>实验目录</label>
            <input class="input" id="upload-exp" list="exp-list" value="reflow-test" placeholder="reflow-test">
            <datalist id="exp-list">
              ${[...new Set(models.map((model) => model.exp.split("/").pop()))].map((name) => `<option value="${esc(name)}">`).join("")}
            </datalist>
            <div class="hint">会保存到 exp/&lt;实验目录&gt;/ 下</div>
          </div>
          <div class="field">
            <label>模型文件</label>
            <input class="input" type="file" id="model-file" accept=".pt,.ckpt,.pth">
          </div>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn btn-primary" id="upload-model-btn">${icon("upload")}上传</button>
          <span class="tiny faint" id="upload-note"></span>
        </div>
        <div class="progress hidden" id="upload-progress" style="margin-top:10px;height:6px"><i style="width:0%"></i></div>
      </div>
    </div>

    <div class="grid-3" id="model-grid">
      ${models.length ? models.map(modelCard).join("") : `<div class="card card-pad">${renderEmpty("model", "还没有模型", "训练完成后会自动出现在这里，也可以手动上传 .pt 权重")}</div>`}
    </div>
  </div>`;
}

function modelCard(model) {
  const isDefault = model.rel === defaultModel;
  const step = model.step === null || model.step === undefined ? "?" : model.step;
  const isBase = Number(step) === 0;
  const configBadge = model.has_config
    ? `<span class="badge success"><span class="dot"></span>配置就绪</span>`
    : `<span class="badge warn"><span class="dot"></span>缺少配置</span>`;
  return `
    <div class="card model-card" data-model="${esc(model.rel)}">
      <div class="mc-top">
        <div style="min-width:0">
          <div class="mc-name">${esc(model.label || `model_${step}.pt`)}</div>
          <div class="mc-sub mono">${model.label ? `${esc(model.name)} · ` : ""}${esc(model.exp)}</div>
        </div>
        ${isDefault ? `<span class="badge accent">默认</span>` : ""}
      </div>
      <div class="mc-meta">
        ${model.label ? `<span class="badge accent">${esc(model.label)}</span>` : ""}
        ${isBase ? `<span class="badge warn">底模 / 初始权重</span>` : ""}
        ${configBadge}
        ${model.sampling_rate ? `<span class="badge">${model.sampling_rate} Hz</span>` : ""}
        ${model.n_spk ? `<span class="badge">${model.n_spk} spk</span>` : ""}
        ${model.encoder ? `<span class="badge">${esc(model.encoder)}</span>` : ""}
      </div>
      <div class="kv" style="padding:3px 0"><span class="k">文件</span><span class="v">${esc(model.name)}</span></div>
      <div class="kv" style="padding:3px 0"><span class="k">大小</span><span class="v">${fmtBytes(model.size)}</span></div>
      <div class="kv" style="padding:3px 0"><span class="k">修改时间</span><span class="v">${fmtDate(model.mtime)}</span></div>
      <div class="mc-actions">
        <button class="btn btn-sm btn-primary" data-action="use" data-rel="${esc(model.rel)}">${icon("spark")}用于推理</button>
        ${isDefault ? "" : `<button class="btn btn-sm" data-action="default" data-rel="${esc(model.rel)}">设为默认</button>`}
        <button class="btn btn-sm" data-action="label" data-rel="${esc(model.rel)}">${icon("pencil")}命名</button>
        <button class="btn btn-sm" data-action="config" data-rel="${esc(model.rel)}">${icon("log")}配置</button>
        <a class="btn btn-sm btn-ghost" href="${fileUrl(model.rel, true)}" download title="下载">${icon("download")}</a>
        <button class="btn btn-sm btn-ghost" data-action="rename" data-rel="${esc(model.rel)}" title="重命名文件">${icon("pencil")}</button>
        <button class="btn btn-sm btn-danger" data-action="delete" data-rel="${esc(model.rel)}">${icon("trash")}</button>
      </div>
    </div>`;
}

function bind(container) {
  container.querySelector("#open-exp").addEventListener("click", () => openTarget("exp"));
  container.querySelector("#focus-upload").addEventListener("click", () => {
    container.querySelector("#upload-card").scrollIntoView({ behavior: "smooth", block: "center" });
    container.querySelector("#upload-exp").focus();
  });
  container.querySelector("#upload-model-btn").addEventListener("click", uploadModel);
  container.querySelector("#model-file").addEventListener("change", () => {
    const file = container.querySelector("#model-file").files[0];
    container.querySelector("#upload-note").textContent = file ? `${file.name} · ${fmtBytes(file.size)}` : "";
  });
  container.querySelector("#model-grid").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const rel = button.dataset.rel;
    const action = button.dataset.action;
    if (action === "use") useModel(rel);
    else if (action === "default") setDefault(rel);
    else if (action === "label") renameLabel(rel);
    else if (action === "config") openConfigEditor(rel);
    else if (action === "rename") renameModel(rel);
    else if (action === "delete") deleteModel(rel);
  });
}

async function uploadModel() {
  if (uploadBusy) return;
  const fileInput = containerRef.querySelector("#model-file");
  const file = fileInput.files[0];
  if (!file) {
    toast("请选择模型文件", "支持 .pt / .ckpt / .pth", "warning");
    return;
  }
  const exp = containerRef.querySelector("#upload-exp").value.trim() || "reflow-test";
  if (exp.includes("..") || exp.startsWith("/") || exp.includes("\\")) {
    toast("实验目录无效", "请填写不带路径分隔符的目录名", "warning");
    return;
  }
  uploadBusy = true;
  const button = containerRef.querySelector("#upload-model-btn");
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>上传中…`;
  const progress = containerRef.querySelector("#upload-progress");
  progress.classList.remove("hidden");
  const bar = progress.querySelector("i");
  try {
    const result = await uploadFile(uploadUrl("model", { name: file.name, exp }), file, (ratio) => {
      bar.style.width = `${Math.round(ratio * 100)}%`;
    });
    bar.style.width = "100%";
    toast("上传完成", result.config_created ? "模型已上传，并自动生成了 config.yaml" : "模型已上传", "success");
    fileInput.value = "";
    containerRef.querySelector("#upload-note").textContent = "";
    await render(containerRef);
  } catch (error) {
    toast("上传失败", error.message, "error", 8000);
  } finally {
    uploadBusy = false;
    button.disabled = false;
    button.innerHTML = `${icon("upload")}上传`;
    progress.classList.add("hidden");
    bar.style.width = "0%";
  }
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

async function setDefault(rel) {
  try {
    await api.post("/api/models/default", { model: rel });
    defaultModel = rel;
    toast("已设为默认模型", rel, "success");
    await render(containerRef);
  } catch (error) {
    toast("设置失败", error.message, "error");
  }
}

function renameLabel(rel) {
  const model = models.find((item) => item.rel === rel);
  const current = model?.label || "";
  openModal({
    title: "模型显示名称",
    body: `
      <div class="stack-sm">
        <div class="notice">${icon("info")}<div>显示名称只影响 WebUI 中的模型列表和推理页，不会修改权重文件、目录名或 config.yaml。适合区分不同角色、数据集或训练阶段。</div></div>
        <div class="field">
          <label>名称 / 备注</label>
          <input class="input" id="label-input" maxlength="60" value="${esc(current)}" placeholder="例如：角色A · 2000步 · 柔和音色">
          <div class="hint">最多 60 个字符；留空可恢复为文件名。</div>
        </div>
      </div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="label-ok">保存名称</button>`,
    onMount: ({ root, close }) => {
      const input = root.querySelector("#label-input");
      input.focus();
      input.select();
      const save = async () => {
        try {
          const res = await api.post("/api/models/label", { model: rel, label: input.value.trim() });
          const saved = res.label || input.value.trim();
          toast("名称已保存", saved || "已恢复文件名", "success");
          close();
          await render(containerRef);
        } catch (error) {
          toast("保存失败", error.message, "error");
        }
      };
      root.querySelector("#label-ok").addEventListener("click", save);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") save();
      });
    },
  });
}

async function openConfigEditor(rel) {
  let response;
  try {
    response = await api.get("/api/models/config", { model: rel });
  } catch (error) {
    toast("读取配置失败", error.message, "error");
    return;
  }
  const baseOptions = configs.map((config) => `<option value="configs/${esc(config.name)}">${esc(config.name)}</option>`).join("");
  const body = `
    <div class="stack-sm">
      <div class="row between">
        <span class="small muted mono">${esc(rel)} / config.yaml</span>
        ${response.exists ? `<span class="badge success">配置已存在</span>` : `<span class="badge warn">缺少配置</span>`}
      </div>
      ${response.exists ? "" : `
        <div class="notice warn">${icon("alert")}<div>该模型目录缺少 config.yaml。推理需要模型结构配置，可以从基础配置生成一份。</div></div>
        <div class="row">
          <select class="select grow" id="cfg-base">${baseOptions}</select>
          <button class="btn" id="cfg-generate">${icon("spark")}生成配置</button>
        </div>`}
      <textarea class="code-editor" id="model-yaml" spellcheck="false" style="min-height:420px" ${response.exists ? "" : "disabled"}>${esc(response.text || "")}</textarea>
    </div>`;
  const { root, close } = openModal({
    title: "模型配置",
    wide: true,
    body,
    footer: `
      <button class="btn" data-close>关闭</button>
      ${response.exists ? `<button class="btn btn-primary" id="save-model-yaml">${icon("check")}保存</button>` : ""}`,
    onMount: ({ root }) => {
      const generate = root.querySelector("#cfg-generate");
      if (generate) {
        generate.addEventListener("click", async () => {
          try {
            const base = root.querySelector("#cfg-base").value;
            const result = await api.post("/api/models/ensure-config", { model: rel, base });
            toast("已生成配置", result.message, "success");
            close();
            openConfigEditor(rel);
          } catch (error) {
            toast("生成失败", error.message, "error");
          }
        });
      }
      const save = root.querySelector("#save-model-yaml");
      if (save) {
        save.addEventListener("click", async () => {
          try {
            await api.post("/api/models/config", { model: rel, text: root.querySelector("#model-yaml").value });
            toast("配置已保存", "", "success");
            close();
          } catch (error) {
            toast("保存失败", error.message, "error", 7000);
          }
        });
      }
    },
  });
}

async function renameModel(rel) {
  const current = rel.split("/").pop();
  const body = `
    <div class="field">
      <label>新的文件名</label>
      <input class="input" id="rename-input" value="${esc(current)}">
      <div class="hint">只会重命名权重文件，不会修改 config.yaml</div>
    </div>`;
  openModal({
    title: "重命名模型",
    body,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="rename-ok">重命名</button>`,
    onMount: ({ root, close }) => {
      const input = root.querySelector("#rename-input");
      input.focus();
      input.select();
      const doRename = async () => {
        try {
          await api.post("/api/models/rename", { model: rel, new_name: input.value.trim() });
          toast("已重命名", "", "success");
          close();
          await render(containerRef);
        } catch (error) {
          toast("重命名失败", error.message, "error");
        }
      };
      root.querySelector("#rename-ok").addEventListener("click", doRename);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") doRename();
      });
    },
  });
}

async function deleteModel(rel) {
  const model = models.find((item) => item.rel === rel);
  const isBase = Number(model?.step) === 0;
  const confirmed = await confirmDialog({
    title: isBase ? "删除底模" : "删除模型",
    message: `确定删除 ${rel} 吗？`,
    detail: isBase
      ? "这是 step 0 的底模/初始权重，删除后可能无法从零继续训练或缺少基础权重。请确认你已有其他可用模型。只删除权重文件，不会删除 config.yaml。"
      : "只删除权重文件，不会删除同目录的 config.yaml。删除后无法恢复。",
    confirmText: "继续",
    danger: true,
  });
  if (!confirmed) return;
  const confirmedAgain = await confirmDialog({
    title: "再次确认删除",
    message: `请再次确认删除 ${rel}`,
    detail: isBase
      ? "底模删除后不可恢复；如果只是暂时不用，建议保留并在模型管理中重命名。"
      : "删除后不可恢复，训练中的任务也可能受影响。",
    confirmText: "确认删除",
    danger: true,
  });
  if (!confirmedAgain) return;
  try {
    await api.post("/api/models/delete", { model: rel });
    toast("已删除", rel, "success");
    await render(containerRef);
  } catch (error) {
    toast("删除失败", error.message, "error");
  }
}

async function openTarget(target) {
  try {
    await api.post("/api/open", { target });
  } catch (error) {
    toast("无法打开", error.message, "error");
  }
}
