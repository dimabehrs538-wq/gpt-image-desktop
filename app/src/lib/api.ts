import { invoke, isTauri } from "@tauri-apps/api/core";

export interface CoreInfo { port: number; token: string }

export interface KeyRef { path: string; field: string }
export interface GroupView {
  name: string; displayName: string; note: string; baseUrl: string; appendV1: boolean; model: string;
  keySource: "literal" | "env" | "ref" | "none"; keyMask: string; keyEnv?: string; keyRef?: KeyRef;
  keyOk: boolean; keyError?: string; effectiveBaseUrl: string; generationsUrl: string; editsUrl: string;
  isDefault: boolean; createdAt: number;
}
export interface GroupInput {
  name: string; newName?: string; displayName: string; note: string; baseUrl: string; appendV1: boolean; model: string;
  keySource: "literal" | "env" | "ref"; apiKey: string; apiKeyEnv: string; apiKeyRef: KeyRef | null; makeDefault: boolean;
}
export interface GroupsResp { defaultGroup: string; groups: GroupView[]; configPath?: string }
export interface Settings { outputDir: string; requestTimeoutSec: number; filenamePrefix: string }
export interface Status {
  version: string; pid: number; uptime: number; home: string; configPath: string; outputDir: string;
  groups: number; defaultGroup: string; activeJobs: number; historyCount: number; codexConfigPath: string;
}
export interface HistoryItem {
  id: string; jobId: string; createdAt: number; mode: "generate" | "edit"; group: string; baseUrl: string; model: string;
  prompt: string; revisedPrompt?: string; size?: string; quality?: string; background?: string; outputFormat?: string;
  n: number; index: number; path: string; fileSize: number; width?: number; height?: number; elapsedMs: number;
  sourceUrl?: string; inputImages?: string[]; mask?: string;
}
export interface Job {
  id: string; mode: "generate" | "edit"; status: "running" | "succeeded" | "failed" | "canceled"; group: string; model: string;
  prompt: string; size?: string; n: number; inputCount: number; createdAt: number; finishedAt?: number; elapsedMs: number;
  error?: string; items: HistoryItem[];
}
export interface ProbeResult { ok: boolean; status: number; latencyMs: number; message: string; url: string; modelCount: number; modelListed: boolean }
export interface ImageInput { path?: string; dataUrl?: string; name?: string }
export interface GenParams {
  group: string; model: string; prompt: string; size: string; quality: string; background: string; outputFormat: string; n: number; name?: string;
}

let core: CoreInfo | null = null;

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: Record<string, unknown>) { super(message); }
}

const HTTP_CN: Record<number, string> = {
  400: "请求参数不正确", 401: "授权已失效，请重启软件", 404: "找不到对应的项目", 500: "内核服务出错，请稍后重试",
};

export async function getCore(): Promise<CoreInfo> {
  if (core) return core;
  if (isTauri()) core = await invoke<CoreInfo>("core_info");
  else {
    // 浏览器调试：http://localhost:5173/?port=xxx&token=yyy（见数据目录下 daemon.json）
    const q = new URLSearchParams(location.search);
    core = { port: Number(q.get("port")), token: q.get("token") ?? "" };
  }
  return core;
}

export const coreReady = () => core !== null;
const base = () => `http://127.0.0.1:${core?.port}`;

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const c = await getCore();
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${c.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("无法连接内核服务，请稍后重试");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((data as { error?: string }).error || HTTP_CN[r.status] || `请求失败（HTTP ${r.status}）`, r.status, data as Record<string, unknown>);
  return data as T;
}

export async function eventSourceURL() {
  const c = await getCore();
  return `http://127.0.0.1:${c.port}/api/events?token=${encodeURIComponent(c.token)}`;
}

/** 本地图片原图地址（带 token） */
export function fileURL(path: string, download = false) {
  return `${base()}/api/files?path=${encodeURIComponent(path)}&token=${encodeURIComponent(core?.token ?? "")}${download ? "&download=1" : ""}`;
}
/** 本地图片缩略图地址 */
export function thumbURL(path: string, w = 384) {
  return `${base()}/api/thumb?w=${w}&path=${encodeURIComponent(path)}&token=${encodeURIComponent(core?.token ?? "")}`;
}

/** 与内核一致的 baseUrl 规范化：去掉末尾 /；appendV1 或官方域名补 /v1；已有 /v1 不重复 */
export function effectiveBaseUrl(baseUrl: string, appendV1: boolean) {
  let b = baseUrl.trim().replace(/\/+$/, "");
  if (!b) return "";
  if (!b.endsWith("/v1")) {
    if (appendV1) b += "/v1";
    else {
      try {
        const u = new URL(b);
        if (u.hostname.toLowerCase() === "api.openai.com" && (u.pathname === "" || u.pathname === "/")) b += "/v1";
      } catch { /* 输入中 */ }
    }
  }
  return b;
}

export function formatBytes(n = 0) {
  if (n < 0) return "文件缺失";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
export function formatMs(ms = 0) {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`;
}
export function formatTime(t: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function formatUptime(s = 0) {
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
  return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`;
}

export function fileToDataURL(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, "");

let notifyMod: typeof import("@tauri-apps/plugin-notification") | null = null;
export async function notify(title: string, body: string) {
  if (localStorage.getItem("notify") === "0") return;
  try {
    if (isTauri()) {
      notifyMod ??= await import("@tauri-apps/plugin-notification");
      let ok = await notifyMod.isPermissionGranted();
      if (!ok) ok = (await notifyMod.requestPermission()) === "granted";
      if (ok) notifyMod.sendNotification({ title, body });
    } else if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch (e) { console.warn(e); }
}

export function setTray(text: string) {
  if (isTauri()) invoke("set_tray_status", { text }).catch(() => {});
}

/** 在系统文件管理器中显示文件 */
export async function revealFile(path: string) {
  if (!isTauri()) throw new Error("浏览器调试模式不支持打开文件夹");
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}
/** 用系统默认程序打开文件 / 文件夹 */
export async function openPath(path: string) {
  if (!isTauri()) { window.open(fileURL(path), "_blank"); return; }
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
}
/** 选择本地图片（Tauri 对话框返回路径） */
export async function pickImages(multiple: boolean, title: string): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ multiple, title, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] });
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}
export async function pickDirectory(title: string, defaultPath?: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, title, defaultPath });
  return typeof r === "string" ? r : null;
}
export async function pickJsonFile(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ title, filters: [{ name: "JSON", extensions: ["json"] }] });
  return typeof r === "string" ? r : null;
}

export const isMac = () => /Mac|iPhone|iPad/i.test(navigator.userAgent);
export { isTauri };
