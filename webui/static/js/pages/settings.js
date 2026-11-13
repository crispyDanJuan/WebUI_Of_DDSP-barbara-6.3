import { api, fileUrl } from "../api.js";
import { esc, icon, toast, fmtDuration, fmtBytes, confirmDialog } from "../ui.js";

let containerRef = null;
let system = null;
let settings = {};
let models = [];
let engine = null;

export async function render(container) {
  containerRef = container;
  [system, settings, models, engine] = await Promise.all([
    api.get("/api/system"),
    api.get("/api/settings").then((res) => res.settings || {}),
    api.get("/api/models").then((res) => res.models || []).catch(() => []),
    api.get("/api/infer/status").catch(() => null),
  ]);
  container.innerHTML = template();
  bind(container);
}

function template() {
  const gpu = (system.gpus || [])[0];
  const vramUsed = gpu?.vram_used_mb ? (gpu.vram_used_mb / 1024).toFixed(1) : null;
  const vramTotal = gpu?.vram_total_mb ? (gpu.vram_total_mb / 1024).toFixed(1) : null;
  const vramPct = gpu?.vram_total_mb ? Math.round((gpu.vram_used_mb / gpu.vram_total_mb) * 100) : 0;
  const url = `http://127.0.0.1:${system.port || location.port}/`;
  const engineLoaded = Boolean(engine?.loaded);
  return `
  <div class="page-grid fade-enter">
    <div class="card hero list-hero">
      <div class="lh-icon">${icon("settings")}</div>
      <div class="grow">
        <h2>设置与系统信息</h2>
        <p>所有功能都在本机运行，不会上传任何音频或模型到互联网。</p>
      </div>
      <span class="badge success"><span class="dot"></span>本地服务运行中</span>
    </div>

    <div class="grid-2" style="align-items:start">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("cpu")}系统信息</div>
            <div class="card-sub">运行环境与硬件</div>
          </div>
          <button class="btn btn-sm btn-ghost" id="refresh-sys">${icon("refresh")}</button>
        </div>
        <div class="card-body">
          <div class="task-box" style="margin-bottom:12px;padding:12px">
            <div class="between">
              <span class="small strong">${esc(gpu ? gpu.name : "CPU 模式")}</span>
              ${gpu ? `<span class="badge cyan">${gpu.util_percent ?? 0}% 利用率</span>` : ""}
            </div>
            ${gpu ? `
              <div class="meter" style="margin-top:9px"><i style="width:${vramPct}%"></i></div>
              <div class="between tiny faint" style="margin-top:4px"><span>显存 ${vramUsed} / ${vramTotal} GB</span><span>${gpu.temp_c ?? "-"}°C</span></div>
            ` : `<div class="hint" style="margin-top:6px">未检测到 NVIDIA GPU，推理和训练将使用 CPU（会很慢）。</div>`}
          </div>
          <div class="kv"><span class="k">Python</span><span class="v">${esc(system.python || "-")}</span></div>
          <div class="kv"><span class="k">PyTorch</span><span class="v">${esc(system.torch || "-")}</span></div>
          <div class="kv"><span class="k">TorchAudio</span><span class="v">${esc(system.torchaudio || "-")}</span></div>
          <div class="kv"><span class="k">CUDA 可用</span><span class="v">${system.cuda_available ? "是" : "否"}</span></div>
          <div class="kv"><span class="k">运行权限</span><span class="v">${system.admin ? "管理员（不建议）" : "普通用户"}</span></div>
          <div class="kv"><span class="k">CPU / 内存</span><span class="v">${system.cpu_count || "-"} 核 / ${system.ram_gb || "-"} GB</span></div>
          <div class="kv"><span class="k">磁盘可用</span><span class="v">${system.disk_free_gb || "-"} / ${system.disk_total_gb || "-"} GB</span></div>
          <div class="kv"><span class="k">服务端口</span><span class="v">${system.port || "-"}</span></div>
          <div class="kv"><span class="k">运行时长</span><span class="v">${fmtDuration(system.uptime_seconds || 0)}</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("spark")}默认参数</div>
            <div class="card-sub">新建推理页面时使用的默认值</div>
          </div>
        </div>
        <div class="card-body stack-sm">
          <div class="field">
            <label>默认模型</label>
            <select class="select" id="set-model">
              <option value="">自动选择最新可用模型</option>
              ${models.map((model) => `<option value="${esc(model.rel)}" ${settings.default_model === model.rel ? "selected" : ""}>${esc(model.exp)} / ${esc(model.name)}</option>`).join("")}
            </select>
          </div>
          <div class="field-row">
            <div class="field">
              <label>默认设备</label>
              <select class="select" id="set-device">
                ${["auto", "cuda", "cpu"].map((value) => `<option value="${value}" ${settings.default_device === value ? "selected" : ""}>${value}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>默认音高提取器</label>
              <select class="select" id="set-pitch">
                ${["rmvpe", "fcpe", "crepe", "harvest", "dio", "parselmouth"].map((value) => `<option value="${value}" ${settings.default_pitch_extractor === value ? "selected" : ""}>${value}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="field-row-3">
            <div class="field">
              <label>默认步数</label>
              <input class="input" type="number" id="set-step" min="1" max="300" value="${settings.default_infer_step ?? 50}">
            </div>
            <div class="field">
              <label>默认方法</label>
              <select class="select" id="set-method">
                <option value="euler" ${settings.default_method === "euler" ? "selected" : ""}>euler</option>
                <option value="rk4" ${settings.default_method === "rk4" ? "selected" : ""}>rk4</option>
              </select>
            </div>
            <div class="field">
              <label>默认 t_start</label>
              <input class="input" type="number" id="set-ts" step="0.05" min="0" max="1" value="${settings.default_t_start ?? 0.7}">
            </div>
          </div>
          <div class="field">
            <label>输出文件名模板</label>
            <input class="input mono" id="set-template" value="${esc(settings.output_template || "")}">
            <div class="hint">可用变量：{stem} {step} {key} {v} {f} {method} {infer_step} {t_start} {date} {time}</div>
          </div>
          <button class="btn btn-primary" id="save-settings">${icon("check")}保存默认参数</button>
        </div>
      </div>
    </div>

    <div class="grid-2" style="align-items:start">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("model")}推理引擎</div>
            <div class="card-sub">当前显存中缓存的模型</div>
          </div>
          <span class="badge ${engineLoaded ? "success" : ""}"><span class="dot"></span>${engineLoaded ? "已加载" : "未加载"}</span>
        </div>
        <div class="card-body stack-sm">
          <div class="kv"><span class="k">模型</span><span class="v">${esc(engine?.model || "—")}</span></div>
          <div class="kv"><span class="k">设备</span><span class="v">${esc((engine?.device || "—").toUpperCase())}</span></div>
          <div class="kv"><span class="k">采样率 / 说话人</span><span class="v">${engine?.sampling_rate || "—"} Hz / ${engine?.n_spk || "—"}</span></div>
          <div class="row">
            <button class="btn btn-danger" id="unload-engine" ${engineLoaded ? "" : "disabled"}>${icon("trash")}释放模型 / 显存</button>
          </div>
          <div class="hint">训练或预处理开始前会自动释放缓存的推理模型，避免显存冲突。</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${icon("external")}服务</div>
            <div class="card-sub">本机访问地址与关闭服务</div>
          </div>
        </div>
        <div class="card-body stack-sm">
          <div class="field">
            <label>WebUI 地址</label>
            <div class="row">
              <input class="input mono" id="service-url" readonly value="${esc(url)}">
              <button class="btn btn-icon" id="copy-url" title="复制">${icon("log")}</button>
            </div>
          </div>
          <div class="row">
            <button class="btn" id="open-root">${icon("folder")}打开整合包目录</button>
            <button class="btn" id="open-logs">${icon("log")}打开日志</button>
          </div>
          <hr class="hr">
          <div class="notice warn">${icon("alert")}<div>关闭服务后，正在运行的任务会被停止。下次双击“启动WebUI.bat”即可重新打开。</div></div>
          <button class="btn btn-danger" id="shutdown">${icon("stop")}关闭 WebUI 服务</button>
        </div>
      </div>
    </div>

    <div class="card card-pad">
      <div class="row" style="align-items:flex-start">
        <div class="stat-icon">${icon("info")}</div>
        <div class="stack-sm" style="gap:5px">
          <div class="strong small">关于 DDSP Studio</div>
          <div class="small muted" style="line-height:1.7">
            DDSP Studio 是 DDSP-barbara-6.3 整合包的本地 WebUI 外壳，推理算法来自 DDSP-SVC / DDSP-barbara。
            版本 ${esc(system.version || "1.0.0")}，根目录 <span class="mono">${esc(system.root || "")}</span>。
          </div>
          <div class="row">
            <a class="btn btn-sm btn-ghost" href="${fileUrl("cn_README.md")}" target="_blank" rel="noopener">${icon("log")}查看原版说明</a>
            <a class="btn btn-sm btn-ghost" href="https://github.com/yxlllc/DDSP-SVC" target="_blank" rel="noopener">${icon("external")}DDSP-SVC</a>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function bind(container) {
  container.querySelector("#refresh-sys").addEventListener("click", async () => {
    await render(containerRef);
    toast("已刷新", "", "success", 1500);
  });
  container.querySelector("#save-settings").addEventListener("click", saveSettings);
  container.querySelector("#unload-engine").addEventListener("click", async () => {
    try {
      await api.post("/api/infer/unload", {});
      toast("已释放模型", "显存已清空", "success");
      await render(containerRef);
    } catch (error) {
      toast("释放失败", error.message, "error");
    }
  });
  container.querySelector("#open-root").addEventListener("click", () => openTarget("root"));
  container.querySelector("#open-logs").addEventListener("click", () => openTarget("logs"));
  container.querySelector("#copy-url").addEventListener("click", async () => {
    const input = container.querySelector("#service-url");
    try {
      await navigator.clipboard.writeText(input.value);
      toast("已复制", input.value, "success", 2000);
    } catch {
      input.select();
      document.execCommand("copy");
      toast("已复制", input.value, "success", 2000);
    }
  });
  container.querySelector("#shutdown").addEventListener("click", shutdown);
}

async function saveSettings() {
  const settings = {
    default_model: document.getElementById("set-model").value,
    default_device: document.getElementById("set-device").value,
    default_pitch_extractor: document.getElementById("set-pitch").value,
    default_infer_step: Number(document.getElementById("set-step").value) || 50,
    default_method: document.getElementById("set-method").value,
    default_t_start: Number(document.getElementById("set-ts").value) || 0,
    output_template: document.getElementById("set-template").value.trim(),
  };
  try {
    await api.post("/api/settings", { settings });
    toast("设置已保存", "新建推理时会使用这些默认值", "success");
  } catch (error) {
    toast("保存失败", error.message, "error");
  }
}

async function openTarget(target) {
  try {
    await api.post("/api/open", { target });
  } catch (error) {
    toast("无法打开", error.message, "error");
  }
}

async function shutdown() {
  const confirmed = await confirmDialog({
    title: "关闭 WebUI 服务",
    message: "确定关闭本地 WebUI 服务吗？",
    detail: "正在运行的推理、训练或预处理任务会被停止。浏览器页面将无法继续访问，需要重新双击启动脚本。",
    confirmText: "关闭服务",
    danger: true,
  });
  if (!confirmed) return;
  // Tell the service watchdog this disconnect is intentional, so it does not
  // raise the "服务已停止" error over the farewell screen.
  window.__ddspShuttingDown = true;
  try {
    await api.post("/api/shutdown", {});
    document.body.innerHTML = `
      <div class="center" style="min-height:100vh;padding:30px">
        <div class="card card-pad" style="max-width:460px;text-align:center">
          <div class="empty-icon" style="margin:0 auto 14px">${icon("check")}</div>
          <h2 style="margin:0 0 8px">服务已关闭</h2>
          <p class="muted" style="font-size:12px;line-height:1.7">可以关闭此页面。下次双击整合包目录中的<br><span class="mono">启动WebUI.bat</span> 即可重新打开。</p>
        </div>
      </div>`;
  } catch (error) {
    toast("关闭失败", error.message, "error");
  }
}
