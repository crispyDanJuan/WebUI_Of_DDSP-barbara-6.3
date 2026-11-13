export class ApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message || "请求失败");
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

function buildQuery(params) {
  if (!params) return "";
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    usp.set(key, value);
  }
  const text = usp.toString();
  return text ? `?${text}` : "";
}

async function request(path, { method = "GET", body, params, timeout = 0 } = {}) {
  const url = path + buildQuery(params);
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let timer = null;
  if (timeout > 0) {
    const controller = new AbortController();
    options.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeout);
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (timer) clearTimeout(timer);
    throw new ApiError("无法连接本地服务，请确认 WebUI 仍在运行", 0, error);
  }
  if (timer) clearTimeout(timer);
  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok || (data && data.ok === false)) {
    throw new ApiError((data && data.error) || `请求失败（HTTP ${response.status}）`, response.status, data);
  }
  return data;
}

export const api = {
  get: (path, params) => request(path, { params }),
  post: (path, body = {}, params) => request(path, { method: "POST", body, params }),
  del: (path, params) => request(path, { method: "DELETE", params }),
  raw: request,
};

export function uploadFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total, event.loaded, event.total);
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText || "null");
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && (!data || data.ok !== false)) {
        resolve(data || {});
      } else {
        reject(new ApiError((data && data.error) || `上传失败（HTTP ${xhr.status}）`, xhr.status, data));
      }
    };
    xhr.onerror = () => reject(new ApiError("上传失败，请检查网络/服务状态"));
    xhr.onabort = () => reject(new ApiError("上传已取消"));
    xhr.send(file);
  });
}

export function fileUrl(rel, download = false) {
  return `/api/file${buildQuery({ path: rel, download: download ? 1 : 0 })}`;
}

export function uploadUrl(target, { name, split, spk, exp } = {}) {
  return `/api/upload${buildQuery({ target, name, split, spk, exp })}`;
}
