/* Shared UI helpers: escaping, toasts, modals, audio players, log viewer. */

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function icon(name, cls = "") {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined || isNaN(bytes)) return "-";
  const n = Number(bytes);
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return "-";
  const total = Math.max(0, Math.round(Number(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtDate(ts) {
  if (!ts) return "-";
  const date = new Date(ts * 1000);
  return date.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export function timeAgo(ts) {
  if (!ts) return "-";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} 天前`;
  return fmtDate(ts);
}

export function fmtPercent(value, digits = 0) {
  if (value === null || value === undefined || isNaN(value)) return "-";
  return `${Number(value).toFixed(digits)}%`;
}

export function statusBadge(status) {
  const map = {
    queued: ["等待中", ""],
    running: ["运行中", "cyan"],
    success: ["已完成", "success"],
    failed: ["失败", "danger"],
    canceled: ["已取消", "warn"],
  };
  const [label, cls] = map[status] || [status || "未知", ""];
  return `<span class="badge ${cls}"><span class="dot"></span>${esc(label)}</span>`;
}

let toastSeq = 0;
export function toast(title, message = "", type = "info", timeout = 4600) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const current = host.querySelectorAll(".toast");
  if (current.length >= 4) current[0].remove();
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.dataset.id = String(++toastSeq);
  const iconName = type === "success" ? "check" : type === "error" ? "alert" : type === "warning" ? "alert" : "info";
  el.innerHTML = `
    <div class="t-ico">${icon(iconName)}</div>
    <div class="t-body">
      <div class="t-title">${esc(title)}</div>
      ${message ? `<div class="t-msg">${esc(message)}</div>` : ""}
    </div>
    <button class="t-close" aria-label="关闭">${icon("close")}</button>`;
  const close = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 260);
  };
  el.querySelector(".t-close").addEventListener("click", close);
  host.appendChild(el);
  if (timeout > 0) setTimeout(close, timeout);
  return el;
}

export function openModal({ title, body = "", footer = "", wide = false, onMount, onClose } = {}) {
  const root = document.createElement("div");
  root.className = "modal-backdrop";
  root.innerHTML = `
    <div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button class="modal-close" data-close aria-label="关闭">${icon("close")}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ""}
    </div>`;
  document.getElementById("modal-root").appendChild(root);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    root.remove();
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  root.addEventListener("mousedown", (event) => {
    if (event.target === root) close();
  });
  root.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", close));
  if (onMount) onMount({ root, close });
  return { root, close };
}

export function confirmDialog({
  title = "确认操作",
  message = "",
  detail = "",
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value, close) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
      if (close) close();
    };
    const { close } = openModal({
      title,
      body: `
        <div class="stack-sm">
          <div style="font-size:13px;font-weight:600">${esc(message)}</div>
          ${detail ? `<div class="muted small" style="line-height:1.6">${detail}</div>` : ""}
        </div>`,
      footer: `
        <button class="btn" data-cancel>${esc(cancelText)}</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-confirm>${esc(confirmText)}</button>`,
      onMount: ({ root, close }) => {
        root.querySelector("[data-cancel]").addEventListener("click", () => finish(false, close));
        root.querySelector("[data-confirm]").addEventListener("click", () => finish(true, close));
      },
      onClose: () => finish(false, null),
    });
    return close;
  });
}

export function renderEmpty(iconName, title, text = "") {
  return `
    <div class="empty">
      <div class="empty-icon">${icon(iconName)}</div>
      <h4>${esc(title)}</h4>
      ${text ? `<p>${esc(text)}</p>` : ""}
    </div>`;
}

export function bindRange(input, valueEl, { format = (v) => v, onChange } = {}) {
  const update = () => {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const value = Number(input.value);
    const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
    input.style.setProperty("--fill", `${Math.max(0, Math.min(100, fill))}%`);
    if (valueEl) {
      if (valueEl.tagName === "INPUT") valueEl.value = value;
      else valueEl.textContent = format(value);
    }
    if (onChange) onChange(value);
  };
  input.addEventListener("input", update);
  update();
  return update;
}

export function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } catch {
    /* ignore */
  }
  area.remove();
}

export function downloadBlob(filename, content, mime = "application/octet-stream") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* --------------------------------------------------------------------------
   Audio player
   -------------------------------------------------------------------------- */
let sharedAudioContext = null;

function getAudioContext() {
  if (!sharedAudioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    sharedAudioContext = new Ctx();
  }
  return sharedAudioContext;
}

async function decodePeaks(url, bins = 150) {
  const context = getAudioContext();
  if (!context) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error("无法读取音频");
  const arrayBuffer = await response.arrayBuffer();
  const buffer = await context.decodeAudioData(arrayBuffer.slice(0));
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const data = buffer.getChannelData(0);
  const peaks = new Float32Array(bins);
  const block = Math.max(1, Math.floor(length / bins));
  for (let i = 0; i < bins; i += 1) {
    const start = i * block;
    const end = Math.min(length, start + block);
    let max = 0;
    for (let j = start; j < end; j += 1) {
      const value = Math.abs(data[j]);
      if (value > max) max = value;
    }
    if (channels > 1) {
      const other = buffer.getChannelData(1);
      for (let j = start; j < end; j += 1) {
        const value = Math.abs(other[j]);
        if (value > max) max = value;
      }
    }
    peaks[i] = max;
  }
  let peakMax = 0;
  for (const value of peaks) if (value > peakMax) peakMax = value;
  if (peakMax > 0) for (let i = 0; i < peaks.length; i += 1) peaks[i] /= peakMax;
  return peaks;
}

/* One shared audio element: playback continues across route changes. */
const globalAudio = new Audio();
let globalAudioSrc = "";
let globalAudioName = "";
const audioSubs = new Set();

function notifyAudio() {
  for (const fn of audioSubs) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

["play", "pause", "timeupdate", "loadedmetadata", "ended", "error"].forEach((name) => {
  globalAudio.addEventListener(name, notifyAudio);
});
globalAudio.addEventListener("ended", () => {
  globalAudio.currentTime = 0;
  notifyAudio();
});

export function audioSource() {
  return globalAudioSrc;
}

export function audioName() {
  return globalAudioName;
}

export function getGlobalAudio() {
  return globalAudio;
}

export function subscribeAudio(fn) {
  audioSubs.add(fn);
  return () => audioSubs.delete(fn);
}

export async function playAudio(src, name = "") {
  if (globalAudioSrc !== src) {
    globalAudio.pause();
    globalAudioSrc = src;
    globalAudioName = name;
    globalAudio.src = src;
    globalAudio.load();
  }
  try {
    await globalAudio.play();
  } finally {
    notifyAudio();
  }
}

export function pauseAudio() {
  globalAudio.pause();
}

export function seekAudio(seconds) {
  if (Number.isFinite(seconds)) globalAudio.currentTime = Math.max(0, seconds);
  notifyAudio();
}

export function stopGlobalAudio() {
  globalAudio.pause();
  globalAudio.removeAttribute("src");
  globalAudio.load();
  globalAudioSrc = "";
  globalAudioName = "";
  notifyAudio();
}

export function initGlobalAudioUI() {
  const root = document.getElementById("global-audio");
  if (!root) return;
  const toggle = root.querySelector("#ga-toggle");
  const seek = root.querySelector("#ga-seek");
  const nameEl = root.querySelector("#ga-name");
  const timeEl = root.querySelector("#ga-time");
  const close = root.querySelector("#ga-close");

  const render = () => {
    if (!globalAudioSrc) {
      root.classList.add("hidden");
      return;
    }
    root.classList.remove("hidden");
    nameEl.textContent = globalAudioName || globalAudioSrc.split("/").pop();
    const duration = Number.isFinite(globalAudio.duration) ? globalAudio.duration : 0;
    const current = globalAudio.currentTime || 0;
    timeEl.textContent = `${fmtDuration(current)} / ${duration ? fmtDuration(duration) : "--:--"}`;
    seek.max = String(duration || 0);
    seek.value = String(current || 0);
    toggle.innerHTML = icon(globalAudio.paused ? "play" : "pause");
  };

  toggle.addEventListener("click", () => {
    if (globalAudio.paused) globalAudio.play().catch(() => {});
    else globalAudio.pause();
  });
  close.addEventListener("click", stopGlobalAudio);
  seek.addEventListener("input", () => {
    const duration = Number.isFinite(globalAudio.duration) ? globalAudio.duration : 0;
    if (duration) globalAudio.currentTime = (Number(seek.value) / 100) * duration;
  });
  subscribeAudio(render);
  render();
}

export function trackAudio(audio) {
  return audio;
}

export function stopAudio(audio) {
  if (audio) {
    try {
      audio.pause();
    } catch {
      /* ignore */
    }
  }
}

export function stopAllAudio() {
  stopGlobalAudio();
}

export function mountPlayer(host, { src, name = "", download = "", mini = false, autoWave = false } = {}) {  const wrap = document.createElement("div");
  wrap.className = `player ${mini ? "mini" : ""}`;
  wrap.innerHTML = `
    <button class="player-play" type="button" aria-label="播放">${icon("play")}</button>
    <div class="player-main">
      <canvas class="player-wave"></canvas>
      <div class="player-meta">
        <span class="player-name">${esc(name)}</span>
        <span class="player-time">0:00 / --:--</span>
      </div>
    </div>
    <div class="player-actions">
      ${download ? `<a class="btn btn-icon btn-ghost" href="${esc(download)}" download title="下载">${icon("download")}</a>` : ""}
    </div>`;
  host.appendChild(wrap);

  const audio = getGlobalAudio();
  const active = () => audioSource() === src;

  const button = wrap.querySelector(".player-play");
  const canvas = wrap.querySelector(".player-wave");
  const timeEl = wrap.querySelector(".player-time");
  const nameEl = wrap.querySelector(".player-name");
  const ctx = canvas.getContext("2d");
  let peaks = null;
  let duration = active() && Number.isFinite(audio.duration) ? audio.duration : 0;
  let loadingWave = false;
  let destroyed = false;

  const setTime = () => {
    if (!active()) {
      timeEl.textContent = "0:00 / --:--";
      return;
    }
    if (!duration) {
      timeEl.textContent = "0:00 / --:--";
      return;
    }
    timeEl.textContent = `${fmtDuration(audio.currentTime)} / ${fmtDuration(duration)}`;
  };

  const draw = () => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width;
    const height = rect.height;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const bins = peaks ? peaks.length : 120;
    const gap = Math.max(1, (width / bins) * 0.32);
    const barWidth = Math.max(1.2, width / bins - gap);
    const progress = active() && duration ? Math.min(1, audio.currentTime / duration) : 0;
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, "#8b5cf6");
    gradient.addColorStop(0.6, "#818cf8");
    gradient.addColorStop(1, "#22d3ee");
    const center = height / 2;
    for (let i = 0; i < bins; i += 1) {
      const raw = peaks ? peaks[i] : 0.22 + 0.16 * Math.abs(Math.sin(i * 0.55));
      const barHeight = Math.max(2, raw * height * 0.86);
      const x = (i / bins) * width;
      ctx.fillStyle = i / bins <= progress ? gradient : "rgba(148,163,184,0.26)";
      ctx.fillRect(x, center - barHeight / 2, barWidth, barHeight);
    }
    if (!peaks && loadingWave) {
      ctx.fillStyle = "rgba(255,255,255,0.2)";
      ctx.font = "9px sans-serif";
      ctx.fillText("loading waveform…", 8, 12);
    }
  };

  const loadWave = async () => {
    if (peaks || loadingWave) return;
    loadingWave = true;
    draw();
    try {
      const result = await decodePeaks(src);
      if (!destroyed && result) {
        peaks = result;
      }
    } catch {
      /* keep placeholder */
    } finally {
      loadingWave = false;
      if (!destroyed) draw();
    }
  };

  button.addEventListener("click", async () => {
    if (active() && !audio.paused) {
      audio.pause();
      return;
    }
    try {
      await playAudio(src, name);
      loadWave();
    } catch {
      toast("无法播放", "浏览器拒绝了音频播放，请重试", "error");
    }
  });

  const sync = () => {
    if (destroyed) return;
    if (!wrap.isConnected) {
      unsubscribe();
      return;
    }
    const is = active();
    button.innerHTML = icon(is && !audio.paused ? "pause" : "play");
    if (is) {
      duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      setTime();
      draw();
    }
  };
  const unsubscribe = subscribeAudio(sync);

  canvas.addEventListener("click", (event) => {
    if (!active() || !duration) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seekAudio(ratio * duration);
    draw();
  });

  const observer = new ResizeObserver(() => draw());
  observer.observe(canvas);
  setTimeout(draw, 30);
  if (autoWave) setTimeout(loadWave, 150);
  if (active()) setTimeout(sync, 0);

  return {
    audio,
    destroy() {
      destroyed = true;
      unsubscribe();
      observer.disconnect();
      // The shared audio element keeps playing across route changes.
      wrap.remove();
    },
  };
}

/* --------------------------------------------------------------------------
   Log viewer
   -------------------------------------------------------------------------- */
export async function openLogViewer(taskId, title = "任务日志") {
  let offset = 0;
  let accumulated = "";
  let timer = null;
  let autoScroll = true;
  let closed = false;

  const { root, close } = openModal({
    title,
    wide: true,
    body: `
      <div class="row between">
        <div class="row small muted">
          <span class="spinner dark" id="lv-spin"></span>
          <span id="lv-status">读取中…</span>
        </div>
        <label class="checkbox"><input type="checkbox" id="lv-autoscroll" checked> 自动滚动</label>
      </div>
      <div class="log" id="lv-log" style="max-height:min(60vh,560px)"></div>`,
    footer: `
      <button class="btn btn-sm" id="lv-copy">复制</button>
      <button class="btn btn-sm" id="lv-download">下载</button>
      <button class="btn btn-sm btn-primary" data-close>关闭</button>`,
    onClose: () => {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });

  const logEl = root.querySelector("#lv-log");
  const statusEl = root.querySelector("#lv-status");
  const spinEl = root.querySelector("#lv-spin");
  const autoEl = root.querySelector("#lv-autoscroll");

  const append = (text) => {
    if (!text) return;
    accumulated += text;
    logEl.textContent = accumulated.length > 400000 ? accumulated.slice(-400000) : accumulated;
    if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
  };

  const refresh = async () => {
    if (closed) return;
    try {
      const url = offset
        ? `/api/task/log?id=${encodeURIComponent(taskId)}&offset=${offset}`
        : `/api/task/log?id=${encodeURIComponent(taskId)}&tail=1`;
      const response = await fetch(url);
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "读取日志失败");
      append(data.text || "");
      offset = data.offset || offset;
      const taskRes = await fetch(`/api/task?id=${encodeURIComponent(taskId)}`);
      const taskData = await taskRes.json();
      const status = taskData.task ? taskData.task.status : "unknown";
      statusEl.textContent = status === "running" ? "任务运行中" : status === "success" ? "任务已完成" : status === "failed" ? "任务失败" : status === "canceled" ? "任务已取消" : "任务状态：" + status;
      if (status !== "running" && status !== "queued") {
        spinEl.classList.add("hidden");
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }
    } catch (error) {
      statusEl.textContent = error.message;
      spinEl.classList.add("hidden");
    }
  };

  autoEl.addEventListener("change", () => {
    autoScroll = autoEl.checked;
  });
  root.querySelector("#lv-copy").addEventListener("click", async () => {
    await copyText(accumulated);
    toast("已复制", "日志内容已复制到剪贴板", "success");
  });
  root.querySelector("#lv-download").addEventListener("click", () => {
    downloadBlob(`${taskId}.log`, accumulated, "text/plain;charset=utf-8");
  });

  await refresh();
  timer = setInterval(refresh, 1300);
  return { close };
}
