import type { GroupView, ModelCache } from "./api";

/**
 * 模型列表相关的纯函数（便于单测）。
 * 内核只保留模型 ID 中（不区分大小写）包含 "image" 的条目 —— 这是名称匹配，不代表接口一定支持生图；
 * 名称不含 image 的兼容模型仍可手动输入。
 */

const PREF_PREFIX = "modelPref:";

/** 读取某个分组上次选中的模型（只存模型名，不含任何密钥）。 */
export function loadModelPref(group: string): string {
  if (!group) return "";
  try { return localStorage.getItem(PREF_PREFIX + group) ?? ""; } catch { return ""; }
}

/** 记住某个分组选中的模型；空字符串 = 使用分组默认模型（清除偏好）。 */
export function saveModelPref(group: string, model: string) {
  if (!group) return;
  try {
    const m = model.trim();
    if (m) localStorage.setItem(PREF_PREFIX + group, m);
    else localStorage.removeItem(PREF_PREFIX + group);
  } catch { /* 存储不可用时忽略 */ }
}

/** 切换分组时应使用的模型：该组记住的偏好，否则空（= 分组默认模型）。不会因列表刷新而改变。 */
export function modelForGroup(group: string): string {
  return loadModelPref(group);
}

export interface Suggestions { fetched: string[]; presets: string[] }

/**
 * 下拉建议：已拉取的模型（按内核排序）+ 内置预设（排除已在列表中的）。
 * query 为空或恰好等于某一项时显示全部，否则按不区分大小写的子串过滤。
 */
export function suggestions(models: string[], presets: string[], query: string): Suggestions {
  const q = query.trim().toLowerCase();
  const all = [...models, ...presets];
  const exact = q !== "" && all.some((m) => m.toLowerCase() === q);
  const match = (m: string) => !q || exact || m.toLowerCase().includes(q);
  const seen = new Set(models);
  return { fetched: models.filter(match), presets: presets.filter((p) => !seen.has(p)).filter(match) };
}

export type Tone = "muted" | "ok" | "warn" | "error";
export interface CacheStatus { tone: Tone; text: string }

export function relTime(t: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** 列表状态文案：未拉取 / 拉取中 / 已过期 / 失败（保留旧列表）/ 空列表 / 成功。 */
export function cacheStatus(c: ModelCache | undefined, loading: boolean, now = Date.now()): CacheStatus {
  if (loading) return { tone: "muted", text: "正在拉取模型列表…" };
  if (!c) return { tone: "muted", text: "尚未拉取模型列表，可直接输入模型名" };
  if (c.stale) return { tone: "warn", text: "接口地址或密钥已变更，旧列表已失效，请刷新" };
  const ok = c.fetchedAt > 0;
  if (c.error) {
    return { tone: "error", text: ok ? `刷新失败（保留 ${relTime(c.fetchedAt, now)}的 ${c.models.length} 个模型）：${c.error}` : `拉取失败：${c.error}` };
  }
  if (!ok) return { tone: "muted", text: "尚未拉取模型列表，可直接输入模型名" };
  if (c.total === 0) return { tone: "warn", text: `接口返回空列表（${relTime(c.fetchedAt, now)}），可直接输入模型名` };
  if (c.models.length === 0) return { tone: "warn", text: `共 ${c.total} 个模型，名称都不含 image（${relTime(c.fetchedAt, now)}），可直接输入` };
  return { tone: "ok", text: `${c.models.length} 个 image 模型（共 ${c.total} 个）· ${relTime(c.fetchedAt, now)}` };
}

/** 判断当前选中的模型是否在已拉取的列表中（仅用于提示，绝不自动替换）。 */
export function notInList(model: string, c: ModelCache | undefined) {
  return !!model && !!c && c.fetchedAt > 0 && !c.stale && c.models.length > 0 && !c.models.includes(model);
}

/** 自动拉取的会话级去重键：分组名 + 最终 baseUrl + 密钥来源与脱敏尾号（不含明文密钥）。 */
export function autoKey(g: GroupView) {
  return `${g.name}|${g.effectiveBaseUrl}|${g.keySource}|${g.keyMask}`;
}

/** 是否需要自动拉取：密钥可用，且从未拉取过（无记录）或缓存已因端点变化失效；失败过的不自动重试。 */
export function needsAutoFetch(g: GroupView, c: ModelCache | undefined, attempted: Set<string>) {
  if (!g.keyOk || attempted.has(autoKey(g))) return false;
  if (!c) return true;
  if (c.stale) return true;
  return c.fetchedAt === 0 && !c.error;
}
