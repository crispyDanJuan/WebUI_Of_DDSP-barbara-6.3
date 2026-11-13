import { api } from "./api.js";

export const state = {
  system: null,
  settings: {},
  models: [],
  defaultModel: "",
  engine: null,
  lastSystemAt: 0,
};

export async function loadSystem() {
  const data = await api.get("/api/system");
  state.system = data;
  state.lastSystemAt = Date.now();
  return data;
}

export async function loadSettings() {
  const data = await api.get("/api/settings");
  state.settings = data.settings || {};
  return state.settings;
}

export async function loadModels() {
  const data = await api.get("/api/models");
  state.models = data.models || [];
  state.defaultModel = data.default_model || "";
  return state.models;
}

export async function loadEngine() {
  try {
    state.engine = await api.get("/api/infer/status");
  } catch {
    state.engine = null;
  }
  return state.engine;
}

export function pickDefaultModel() {
  const preferred = state.settings.default_model || state.defaultModel;
  const found = state.models.find((model) => model.rel === preferred && model.has_config);
  if (found) return found.rel;
  const withConfig = state.models.filter((model) => model.has_config);
  if (withConfig.length) {
    return withConfig.sort((a, b) => (b.step || 0) - (a.step || 0))[0].rel;
  }
  return state.models[0] ? state.models[0].rel : "";
}

export function gpuText() {
  if (!state.system) return "检测中…";
  const gpu = (state.system.gpus || [])[0];
  if (!gpu) return "CPU 模式";
  const used = gpu.vram_used_mb ? (gpu.vram_used_mb / 1024).toFixed(1) : null;
  const total = gpu.vram_total_mb ? (gpu.vram_total_mb / 1024).toFixed(1) : null;
  return `${gpu.name.replace("NVIDIA GeForce ", "")}${used && total ? ` · ${used}/${total} GB` : ""}`;
}

export function modelLabel(model) {
  if (!model) return "未选择模型";
  const step = model.step === null || model.step === undefined ? "?" : model.step;
  return `${model.exp.split("/").pop()} · model_${step} (${model.name})`;
}
