import { api, fileUrl } from "../api.js";
import { esc, icon, toast, confirmDialog, openModal, fmtBytes, fmtDate } from "../ui.js";

let containerRef = null;
let timer = null;
let tools = {};

export async function render(container) {
  containerRef = container;
  tools = await api.get("/api/tools").catch(() => ({}));
  container.innerHTML = template();
  bind(container);
  refreshStatus();
  timer = setInterval(refreshStatus, 3000);
}

export function destroy() {
  if (timer) clearInterval(timer);
  timer = null;
}

function template() {
  return `
  <div class="page-grid fade-enter">
    <div class="card hero list-hero">
      <div class="lh-icon">${icon("tools")}</div>
      <div class="grow">
        <h2>工具中心</h2>
        <p>实时变声、音频工具箱、TensorBoard 和常用文件夹都可以从这里一键打开，不再需要批处理窗口。</p>
      </div>
    </div>

    ${tools.admin ? `<div class="notice warn">${icon("alert")}<div><div class="strong">当前 WebUI 以管理员权限运行</div><div style="margin-top:3px">Chromium 浏览器和部分外部工具可能拒绝在管理员权限下启动。浏览器打开已自动改为通过 Explorer 转交；如果实时变声/音频工具箱仍无法启动，请关闭 WebUI 后以普通用户身份双击启动脚本。</div></div></div>` : ""}

    <div class="grid-3">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("infer")}实时变声</div>
            <div class="card-sub">启动 gui_reflow.py 低延迟变声窗口</div>
          </div>
          <span id="rt-status"></span>
        </div>
        <div class="card-body stack-sm">
          <p class="small muted" style="margin:0;line-height:1.65">使用滑动窗口、交叉淡化和 SOLA 拼接，适合麦克风实时输入。需要先有一个可用的推理模型。</p>
          <div class="row row-wrap">
            <button class="btn btn-primary" id="rt-start">${icon("play")}启动实时变声</button>
            <button class="btn btn-danger" id="rt-stop">${icon("stop")}停止</button>
            <button class="btn btn-sm" id="rt-focus">${icon("external")}显示窗口</button>
            <a class="btn btn-sm btn-ghost" id="rt-log" target="_blank" rel="noopener">${icon("log")}工具日志</a>
          </div>
          <div class="tiny faint">窗口可能出现在任务栏；如果几秒后仍没有窗口，请打开工具日志查看原因。显存不足时请先停止训练或其他推理任务。</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("music")}音频工具箱</div>
            <div class="card-sub">数据集切片、格式转换、试听</div>
          </div>
          <span id="tk-status"></span>
        </div>
        <div class="card-body stack-sm">
          <p class="small muted" style="margin:0;line-height:1.65">navigator_audio_toolkit 是整合包自带的音频处理工具，可用于准备训练数据、切片和格式转换。</p>
          <div class="row row-wrap">
            <button class="btn btn-primary" id="tk-start">${icon("play")}启动音频工具箱</button>
            <button class="btn btn-danger" id="tk-stop">${icon("stop")}停止</button>
            <button class="btn btn-sm" id="tk-focus">${icon("external")}显示窗口</button>
            <a class="btn btn-sm btn-ghost" id="tk-log" target="_blank" rel="noopener">${icon("log")}工具日志</a>
          </div>
          <div class="tiny faint">外部程序会单独打开一个窗口；日志会记录启动失败、缺少组件等错误。</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("train")}TensorBoard</div>
            <div class="card-sub">查看训练 loss 和验证音频</div>
          </div>
          <span id="tb-status"></span>
        </div>
        <div class="card-body stack-sm">
          <div class="kv"><span class="k">地址</span><span class="v" id="tb-url">未启动</span></div>
          <div class="row">
            <button class="btn btn-primary" id="tb-start">${icon("play")}启动</button>
            <button class="btn btn-danger" id="tb-stop">${icon("stop")}停止</button>
            <a class="btn" id="tb-open" target="_blank" rel="noopener">${icon("external")}打开</a>
          </div>
          <div class="tiny faint">也可以到“模型训练”页面内嵌查看。</div>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("folder")}快速访问</div>
            <div class="card-sub">点击卡片在页面内浏览常用目录</div>
          </div>
        </div>
        <div class="card-body">
          <div class="grid-2" style="gap:9px">
            ${folderButton("raw", "raw 干声", "上传的输入音频")}
            ${folderButton("results", "results 结果", "转换输出音频")}
            ${folderButton("exp", "exp 模型", "训练检查点与日志")}
            ${folderButton("data", "data 数据集", "训练 / 验证集")}
            ${folderButton("configs", "configs 配置", "训练配置文件")}
            ${folderButton("logs", "运行日志", "WebUI 与任务日志")}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("trash")}维护</div>
            <div class="card-sub">清理缓存与查看服务日志</div>
          </div>
        </div>
        <div class="card-body stack-sm">
          <div class="kv"><span class="k">音高缓存</span><span class="v">cache/*.npy</span></div>
          <div class="row">
            <button class="btn" id="clear-f0">${icon("trash")}清理音高缓存</button>
            <button class="btn" id="clear-logs">${icon("trash")}清理 7 天前任务日志</button>
          </div>
          <hr class="hr">
          <div class="row">
            <a class="btn btn-sm btn-ghost" href="${fileUrl("webui/logs/server.log")}" target="_blank" rel="noopener">${icon("log")}查看服务日志</a>
            <button class="btn btn-sm btn-ghost" id="open-logs">${icon("folder")}打开日志目录</button>
          </div>
          <div class="hint">音高缓存可以安全清理，下次推理会自动重新提取。</div>
        </div>
      </div>
    </div>

    <div class="card card-pad">
      <div class="row" style="align-items:flex-start">
        <div class="stat-icon amber">${icon("alert")}</div>
        <div class="stack-sm" style="gap:5px">
          <div class="strong small">使用声明</div>
          <div class="small muted" style="line-height:1.7">
            本整合包仅供交流学习。请确保拥有数据集音声来源的授权许可，禁止用于公众人物、政治人物或争议人物，
            禁止用于血腥、暴力、性相关或侵犯他人合法权利的用途。发布作品时请明确标注输入源音频。
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function folderButton(target, title, text) {
  return `
    <button class="quick-tile" data-open="${target}" style="min-height:82px;text-align:left;color:inherit">
      <div class="row">
        <div class="qt-icon">${icon("folder")}</div>
        <div>
          <div class="qt-title">${esc(title)}</div>
          <div class="qt-sub">${esc(text)}</div>
        </div>
      </div>
    </button>`;
}

function bind(container) {
  container.querySelector("#rt-start").addEventListener("click", () => launch("realtime"));
  container.querySelector("#rt-stop").addEventListener("click", () => stopTool("realtime"));
  container.querySelector("#rt-focus").addEventListener("click", () => focusTool("realtime"));
  container.querySelector("#tk-start").addEventListener("click", () => launch("toolkit"));
  container.querySelector("#tk-stop").addEventListener("click", () => stopTool("toolkit"));
  container.querySelector("#tk-focus").addEventListener("click", () => focusTool("toolkit"));
  container.querySelector("#tb-start").addEventListener("click", startTensorboard);
  container.querySelector("#tb-stop").addEventListener("click", stopTensorboard);
  container.querySelectorAll("[data-open]").forEach((button) => {
    button.addEventListener("click", () => openTarget(button.dataset.open));
  });
  container.querySelector("#open-logs").addEventListener("click", () => openTarget("logs"));
  container.querySelector("#clear-f0").addEventListener("click", () => clearCache("f0", "音高缓存"));
  container.querySelector("#clear-logs").addEventListener("click", () => clearCache("logs", "旧任务日志"));
  container.querySelector("#tb-open").addEventListener("click", (event) => {
    if (!tools.tensorboard?.url) {
      event.preventDefault();
      toast("TensorBoard 未启动", "", "warning");
    }
  });
}

async function refreshStatus() {
  if (!containerRef) return;
  try {
    tools = await api.get("/api/tools");
  } catch {
    return;
  }
  const rt = tools.realtime || {};
  const tk = tools.toolkit || {};
  const tbState = tools.tensorboard || {};
  setStatus(containerRef.querySelector("#rt-status"), rt.running, "运行中", "未运行");
  setStatus(containerRef.querySelector("#tk-status"), tk.running, "运行中", "未运行");
  setStatus(containerRef.querySelector("#tb-status"), Boolean(tbState.running && tbState.alive), "运行中", tbState.running ? "启动中" : "未启动");
  const rtLog = containerRef.querySelector("#rt-log");
  if (rtLog) {
    if (rt.log) rtLog.href = fileUrl(rt.log);
    else rtLog.removeAttribute("href");
  }
  const tkLog = containerRef.querySelector("#tk-log");
  if (tkLog) {
    if (tk.log) tkLog.href = fileUrl(tk.log);
    else tkLog.removeAttribute("href");
  }
  const url = containerRef.querySelector("#tb-url");
  const open = containerRef.querySelector("#tb-open");
  if (url && open) {
    if (tbState.url && tbState.running) {
      url.innerHTML = `<a href="${esc(tbState.url)}" target="_blank" rel="noopener" style="text-decoration:underline">${esc(tbState.url)}</a>`;
      open.href = tbState.url;
    } else {
      url.textContent = "未启动";
      open.removeAttribute("href");
    }
  }
}

function setStatus(el, on, onText, offText) {
  if (!el) return;
  el.innerHTML = `<span class="badge ${on ? "success" : ""}"><span class="dot"></span>${on ? onText : offText}</span>`;
}

async function launch(name) {
  try {
    const response = await api.post("/api/tools/launch", { tool: name });
    if (response.status?.already) {
      toast("程序已经在运行", "", "info", 2200);
    } else {
      toast("已启动", name === "realtime" ? "实时变声窗口正在打开" : "音频工具箱正在打开", "success");
    }
    await refreshStatus();
  } catch (error) {
    toast("启动失败", error.message, "error", 7000);
  }
}

async function focusTool(name) {
  try {
    const response = await api.post("/api/tools/focus", { tool: name });
    if (response.focused) {
      toast("已切换到工具窗口", "", "success", 2200);
    } else {
      toast("没有找到工具窗口", "请确认程序已经启动；窗口可能在任务栏或被浏览器遮挡", "warning", 5000);
    }
  } catch (error) {
    toast("切换失败", error.message, "error");
  }
}

async function stopTool(name) {
  const confirmed = await confirmDialog({
    title: "停止程序",
    message: `确定停止${name === "realtime" ? "实时变声" : "音频工具箱"}吗？`,
    confirmText: "停止",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.post("/api/tools/stop", { tool: name });
    toast("已停止", "", "success", 2000);
    await refreshStatus();
  } catch (error) {
    toast("停止失败", error.message, "error");
  }
}

async function startTensorboard() {
  try {
    const response = await api.post("/api/tensorboard/start", {});
    toast("TensorBoard 正在启动", `端口 ${response.port}`, "info");
    setTimeout(refreshStatus, 1200);
    setTimeout(refreshStatus, 2600);
  } catch (error) {
    toast("启动失败", error.message, "error", 7000);
  }
}

async function stopTensorboard() {
  try {
    await api.post("/api/tensorboard/stop", {});
    toast("TensorBoard 已停止", "", "success", 2200);
    await refreshStatus();
  } catch (error) {
    toast("停止失败", error.message, "error");
  }
}

async function openTarget(target) {
  await openFolderBrowser(target, null);
}

async function openFolderBrowser(target, rel) {
  let data;
  try {
    data = await api.post("/api/browse", rel ? { path: rel } : { target });
  } catch (error) {
    toast("无法读取目录", error.message, "error");
    return;
  }
  const rows = (data.entries || []).map((entry) => `
    <div class="file-row" style="cursor:pointer" data-browse="${esc(entry.rel)}" data-dir="${entry.dir ? "1" : "0"}">
      <div class="file-ico">${icon(entry.dir ? "folder" : "file-audio")}</div>
      <div class="grow">
        <div class="file-name">${esc(entry.name)}</div>
        <div class="file-meta">${entry.dir ? "文件夹" : fmtBytes(entry.size)} · ${fmtDate(entry.mtime)}</div>
      </div>
      <div class="file-actions"><span class="tiny faint">${entry.dir ? "打开" : "查看"}</span></div>
    </div>`).join("");
  openModal({
    title: `文件夹 · ${data.rel || target}`,
    wide: true,
    body: `
      <div class="stack-sm">
        <div class="row row-wrap">
          ${data.parent ? `<button class="btn btn-sm" id="browse-up">${icon("arrow")}上一级</button>` : ""}
          <span class="tiny faint mono grow truncate">${esc(data.path || "")}</span>
        </div>
        <div class="file-list" style="max-height:52vh">${rows || `<div class="empty" style="padding:20px">空文件夹</div>`}</div>
      </div>`,
    onMount: ({ root: modalRoot, close }) => {
      modalRoot.querySelector("#browse-up")?.addEventListener("click", () => {
        close();
        openFolderBrowser(target, data.parent);
      });
      modalRoot.querySelectorAll("[data-browse]").forEach((row) => {
        row.addEventListener("click", () => {
          const path = row.dataset.browse;
          if (row.dataset.dir === "1") {
            close();
            openFolderBrowser(target, path);
          } else {
            window.open(fileUrl(path, true), "_blank", "noopener");
          }
        });
      });
    },
  });
}

async function clearCache(target, label) {
  const confirmed = await confirmDialog({
    title: `清理${label}`,
    message: `确定清理${label}吗？`,
    detail: target === "logs" ? "只会删除 7 天前的任务日志，当前任务日志不受影响。" : "清理后下次推理会重新提取音高，不影响模型和结果。",
    confirmText: "清理",
    danger: target === "logs",
  });
  if (!confirmed) return;
  try {
    const result = await api.post("/api/cache/clear", { target });
    toast("清理完成", `删除了 ${result.removed} 个文件`, "success");
  } catch (error) {
    toast("清理失败", error.message, "error");
  }
}
