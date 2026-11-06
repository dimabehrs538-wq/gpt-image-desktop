/**
 * 版本更新的纯逻辑（无 UI / 无 Tauri 依赖，便于单元测试）：
 * - 语义化版本比较
 * - 解析 GitHub「最新正式版」Release（移动端检查更新用）
 * - 按平台挑选下载资产
 * - 把检查结果 / 错误转换成给用户看的提示（手动检查失败时绝不提示“已是最新”）
 */
export const RELEASE_REPO = "dimabehrs538-wq/gpt-image-desktop";
export const RELEASES_PAGE = `https://github.com/${RELEASE_REPO}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

export type UpdatePlatform = "windows" | "macos" | "android" | "ios" | "web";

interface ParsedVersion { core: number[]; pre: (string | number)[] }

export function parseVersion(v: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** a > b 返回 1，相等 0，a < b 返回 -1；无法解析时抛错（避免把异常数据当成“已是最新”） */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`无法识别的版本号：${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  // 正式版高于同号预发布版：1.0.0 > 1.0.0-beta
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p > q ? 1 : -1;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

export interface ReleaseAsset { name: string; url: string; size: number }
export interface ReleaseInfo { version: string; tag: string; name: string; notes: string; pageUrl: string; publishedAt: string; assets: ReleaseAsset[] }

interface GhAsset { name?: unknown; browser_download_url?: unknown; size?: unknown }
interface GhRelease { tag_name?: unknown; name?: unknown; body?: unknown; html_url?: unknown; published_at?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }

/** 解析 GitHub API /releases/latest 返回体；草稿 / 预发布 / 版本号非法都视为错误 */
export function parseGithubRelease(json: unknown): ReleaseInfo {
  const r = (json ?? {}) as GhRelease;
  if (typeof r.tag_name !== "string") throw new Error("发布信息格式不正确（缺少 tag_name）");
  if (r.draft || r.prerelease) throw new Error("最新发布不是正式版本");
  const version = r.tag_name.replace(/^v/, "");
  if (!parseVersion(version)) throw new Error(`无法识别的版本号：${r.tag_name}`);
  const assets = (Array.isArray(r.assets) ? (r.assets as GhAsset[]) : [])
    .filter((a) => typeof a.name === "string" && typeof a.browser_download_url === "string")
    .map((a) => ({ name: a.name as string, url: a.browser_download_url as string, size: Number(a.size) || 0 }));
  return {
    version, tag: r.tag_name, name: typeof r.name === "string" && r.name ? r.name : r.tag_name,
    notes: typeof r.body === "string" ? r.body : "", pageUrl: typeof r.html_url === "string" ? r.html_url : `${RELEASES_PAGE}/tag/${r.tag_name}`,
    publishedAt: typeof r.published_at === "string" ? r.published_at : "", assets,
  };
}

/** 按平台挑选安装包：Android → 通用 APK；iOS → IPA（优先已签名版）；桌面 → 安装包 */
export function pickAsset(rel: ReleaseInfo, platform: UpdatePlatform): ReleaseAsset | null {
  const by = (re: RegExp) => rel.assets.find((a) => re.test(a.name)) ?? null;
  switch (platform) {
    case "android": return by(/_android_universal\.apk$/i) ?? by(/\.apk$/i);
    case "ios": return by(/_ios_signed\.ipa$/i) ?? by(/\.ipa$/i);
    case "windows": return by(/-setup\.exe$/i) ?? by(/\.msi$/i);
    case "macos": return by(/\.dmg$/i);
    default: return null;
  }
}

export type MobileCheck = { kind: "available"; release: ReleaseInfo; asset: ReleaseAsset | null } | { kind: "latest"; release: ReleaseInfo };

/** 移动端检查更新：当前版本与 GitHub 最新正式版比较 */
export async function checkLatestRelease(current: string, platform: UpdatePlatform, fetchFn: typeof fetch = fetch): Promise<MobileCheck> {
  if (!parseVersion(current)) throw new Error(`无法识别当前版本号：${current || "（空）"}`);
  let res: Response;
  try {
    res = await fetchFn(LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
  } catch (e) {
    throw new Error(`无法连接 GitHub：${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 404) throw new Error("暂未找到正式发布版本");
  if (res.status === 403 || res.status === 429) throw new Error("GitHub 接口访问过于频繁，请稍后再试");
  if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`);
  const release = parseGithubRelease(await res.json());
  return compareVersions(release.version, current) > 0
    ? { kind: "available", release, asset: pickAsset(release, platform) }
    : { kind: "latest", release };
}

/** 手动检查的提示文案：只有“确实拿到且比较过版本”才会说已是最新 */
export function manualCheckMessage(result: { kind: "latest" | "available"; version?: string } | { kind: "error"; error: unknown }): { level: "success" | "info" | "error"; text: string } {
  if (result.kind === "error") {
    const msg = result.error instanceof Error ? result.error.message : String(result.error ?? "");
    return { level: "error", text: `检查更新失败：${msg.slice(0, 120) || "未知错误"}` };
  }
  if (result.kind === "available") return { level: "info", text: `发现新版本 ${result.version ?? ""}`.trim() };
  return { level: "success", text: "已是最新版本" };
}

/** 当前运行环境的更新渠道 */
export function updatePlatform(env: { tauri: boolean; android: boolean; ios: boolean; mac: boolean }): UpdatePlatform {
  if (!env.tauri) return "web";
  if (env.android) return "android";
  if (env.ios) return "ios";
  return env.mac ? "macos" : "windows";
}

export const formatSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
