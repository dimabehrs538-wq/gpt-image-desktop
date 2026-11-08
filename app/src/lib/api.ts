import { invoke, isTauri } from "@tauri-apps/api/core";

export interface CoreInfo { port: number; token: string; platform?: string }

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
/** missingPolicy：接口返回张数少于请求时 fill=逐张补请求（每次 n=1，最多补到请求张数），report=只报告不补 */
export type MissingPolicy = "fill" | "report";
export interface Settings { outputDir: string; requestTimeoutSec: number; filenamePrefix: string; missingPolicy: MissingPolicy }
export interface Status {
  version: string; pid: number; uptime: number; home: string; configPath: string; outputDir: string;
  groups: number; defaultGroup: string; activeJobs: number; historyCount: number; codexConfigPath: string;
  platform?: string; core?: "go" | "rust";
}
export interface HistoryItem {
  id: string; jobId: string; createdAt: number; mode: "generate" | "edit"; group: string; baseUrl: string; model: string;
  prompt: string; revisedPrompt?: string; size?: string; quality?: string; background?: string; outputFormat?: string;
  n: number; index: number; path: string; fileSize: number; width?: number; height?: number; elapsedMs: number;
  sourceUrl?: string; inputImages?: string[]; mask?: string;
}
export interface Job {
  id: string; mode: "generate" | "edit"; status: "running" | "succeeded" | "partial" | "failed" | "canceled"; group: string; model: string;
  prompt: string; size?: string; n: number; inputCount: number; createdAt: number; finishedAt?: number; elapsedMs: number;
  error?: string; items: HistoryItem[];
  /** 期望张数 / 接口实际返回 / 已保存 / 无法使用 / 请求次数（旧内核没有这些字段时按 n 与 items 推断） */
  requested?: number; received?: number; saved?: number; failed?: number; requests?: number;
  /** 给用户的说明，例如「接口只返回了 1/4 张」「已逐张补请求 3 次」 */
  notes?: string[];
}
export interface ProbeResult { ok: boolean; status: number; latencyMs: number; message: string; url: string; modelCount: number; modelListed: boolean }
/** 分组模型列表缓存（内核 GET /api/models、POST /api/groups/{name}/models 返回；不含任何密钥） */
export interface ModelCache {
  group: string; models: string[];
  /** 接口返回的不同模型 ID 数（去重后），不是原始 data 数组长度 */
  total: number; fetchedAt: number; effectiveBaseUrl: string;
  /** 分组的 baseUrl 或密钥已变化：旧列表不再返回，需要重新拉取 */
  stale: boolean; error: string; errorStatus: number; errorAt: number; filter: string;
}
export interface ModelsResp { groups: Record<string, ModelCache>; filter: string }
export interface ModelRefreshResult { ok: boolean; message: string; cache: ModelCache }
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
/** 任务张数统计（兼容没有计数字段的旧内核） */
export function jobCounts(j: Job) {
  const requested = j.requested ?? j.n;
  const saved = j.saved ?? j.items.length;
  return { requested, saved, received: j.received ?? saved, failed: j.failed ?? 0, requests: j.requests ?? (j.status === "running" ? 0 : 1), notes: j.notes ?? [] };
}

/** 一句话张数说明，例如「期望 4 张，已保存 1 张 · 失败 1 张 · 请求 2 次」 */
export function countLine(j: Job) {
  const c = jobCounts(j);
  const parts = [`期望 ${c.requested} 张，已保存 ${c.saved} 张`];
  if (c.failed > 0) parts.push(`无法使用 ${c.failed} 张`);
  if (c.requests > 1) parts.push(`请求 ${c.requests} 次`);
  return parts.join(" · ");
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

/* ───────────── 平台判断：桌面 App / 移动 App（Android、iOS）/ 浏览器 ───────────── */

const ua = () => navigator.userAgent;
/** iPadOS 13+ 的 UA 伪装成 Macintosh，需要结合触控点判断 */
const iPadOS = () => /Macintosh/.test(ua()) && navigator.maxTouchPoints > 1;
export const isIOS = () => core?.platform === "ios" || /iPhone|iPad|iPod/i.test(ua()) || iPadOS();
export const isAndroid = () => core?.platform === "android" || /Android/i.test(ua());
/** 运行在 Tauri 移动端（Android / iOS） */
export const isMobileApp = () => isTauri() && (isIOS() || isAndroid());
/** 运行在 Tauri 桌面端（Windows / macOS / Linux），可使用系统对话框、托盘、开机自启、自动更新等 */
export const isDesktopApp = () => isTauri() && !isMobileApp();

/**
 * 直接上传图片文件流到内核（POST /api/uploads，请求体即原始字节），返回可在编辑请求中引用的本地路径。
 * 移动端 WebView 与浏览器的 <input type="file"> 拿不到系统绝对路径，因此统一先上传为内核附件。
 */
export async function uploadImage(f: File): Promise<ImageInput> {
  const c = await getCore();
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${c.port}/api/uploads?name=${encodeURIComponent(f.name || "image.png")}`, {
      method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/octet-stream" }, body: f,
    });
  } catch {
    throw new Error("无法连接内核服务，请稍后重试");
  }
  const data = (await r.json().catch(() => ({}))) as { path?: string; name?: string; error?: string };
  if (!r.ok || !data.path) throw new ApiError(data.error || `上传失败（HTTP ${r.status}）`, r.status, data);
  return { path: data.path, name: f.name || data.name };
}

interface AndroidBridge { saveImage(path: string, name: string): string; shareImage(path: string, name: string): string; installUpdate?(url: string, name: string): string }
export const androidBridge = () => (window as unknown as { GPTImageAndroid?: AndroidBridge }).GPTImageAndroid;

async function fileBlob(path: string) {
  const r = await fetch(fileURL(path));
  if (!r.ok) throw new Error("读取图片失败");
  const b = await r.blob();
  return new File([b], baseName(path), { type: b.type || "image/png" });
}

function downloadFile(f: File) {
  const url = URL.createObjectURL(f);
  const a = Object.assign(document.createElement("a"), { href: url, download: f.name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 当前环境能否调起系统分享面板 */
export const canShareImages = () => !!androidBridge() || (typeof navigator.share === "function" && isMobileApp());

/**
 * 分享图片：Android 通过原生桥调起系统分享（FileProvider），iOS / 其它支持 Web Share API 的环境用 navigator.share({ files })，
 * 都不支持时回退为下载。
 */
export async function shareImage(path: string) {
  const br = androidBridge();
  if (br) {
    const r = br.shareImage(path, baseName(path));
    if (!r.startsWith("ok")) throw new Error(r.replace(/^error:/, "") || "分享失败");
    return "shared";
  }
  const f = await fileBlob(path);
  if (navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], title: f.name }); return "shared"; }
    catch (e) { if ((e as Error).name === "AbortError") return "canceled"; throw e; }
  }
  downloadFile(f);
  return "downloaded";
}

/**
 * 保存图片到手机相册 / 本地：Android 直接写入系统相册（Pictures/GPTImageStudio），
 * iOS 调起分享面板（选择「存储图像」即可存入照片），桌面浏览器直接下载原图。
 */
export async function saveImage(path: string): Promise<"saved" | "shared" | "downloaded" | "canceled"> {
  const br = androidBridge();
  if (br) {
    const r = br.saveImage(path, baseName(path));
    if (r.startsWith("ok")) return "saved";
    if (r !== "unsupported") throw new Error(r.replace(/^error:/, "") || "保存失败");
    return (await shareImage(path)) as "shared";
  }
  if (isIOS()) return (await shareImage(path)) as "shared" | "downloaded" | "canceled";
  downloadFile(await fileBlob(path));
  return "downloaded";
}

/** 读取用户选择的文本文件（移动端导入 JSON 配置） */
export function pickTextFile(accept = ".json,application/json,text/plain"): Promise<string | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept });
    input.onchange = async () => resolve(input.files?.[0] ? await input.files[0].text() : null);
    input.click();
  });
}

/** 用系统浏览器 / 系统应用打开链接（Tauri 内通过 opener 插件，浏览器调试模式用新标签页） */
export async function openExternal(url: string) {
  if (!isTauri()) { window.open(url, "_blank", "noopener"); return; }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
