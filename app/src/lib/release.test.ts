import { describe, expect, it, vi } from "vitest";
import { checkLatestRelease, compareVersions, manualCheckMessage, parseGithubRelease, pickAsset, updatePlatform, LATEST_RELEASE_API } from "./release";

const gh = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag, name: `GPTImageStudio ${tag}`, body: "更新说明", html_url: `https://github.com/x/y/releases/tag/${tag}`, draft: false, prerelease: false,
  assets: [
    { name: `GPTImageStudio_${tag.slice(1)}_android_universal.apk`, browser_download_url: "https://e/a.apk", size: 26_000_000 },
    { name: `GPTImageStudio_${tag.slice(1)}_android_universal.aab`, browser_download_url: "https://e/a.aab", size: 13_000_000 },
    { name: `GPTImageStudio_${tag.slice(1)}_ios.ipa`, browser_download_url: "https://e/a.ipa", size: 4_000_000 },
    { name: `GPTImageStudio_${tag.slice(1)}_x64-setup.exe`, browser_download_url: "https://e/a.exe", size: 5_000_000 },
    { name: `GPTImageStudio_${tag.slice(1)}_aarch64.dmg`, browser_download_url: "https://e/a.dmg", size: 6_000_000 },
    { name: "latest.json", browser_download_url: "https://e/latest.json", size: 1000 },
  ],
  ...extra,
});
const resp = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("compareVersions", () => {
  it.each([
    ["0.1.1", "0.1.0", 1], ["0.1.0", "0.1.1", -1], ["0.1.0", "0.1.0", 0], ["v0.2.0", "0.1.9", 1],
    ["0.10.0", "0.9.9", 1], ["1.0.0", "1.0.0-beta.2", 1], ["1.0.0-beta.2", "1.0.0-beta.10", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1], ["1.0.0-rc.1", "1.0.0-beta.9", 1], ["1.0.0+build.5", "1.0.0", 0],
  ])("%s vs %s → %d", (a, b, r) => expect(compareVersions(a, b)).toBe(r));
  it("非法版本号抛错而不是当成相等", () => {
    expect(() => compareVersions("abc", "0.1.0")).toThrow(/无法识别/);
    expect(() => compareVersions("0.1", "0.1.0")).toThrow();
  });
});

describe("parseGithubRelease / pickAsset", () => {
  it("解析正式版并按平台挑选资产", () => {
    const r = parseGithubRelease(gh("v0.1.1"));
    expect(r.version).toBe("0.1.1");
    expect(pickAsset(r, "android")?.name).toMatch(/_android_universal\.apk$/);
    expect(pickAsset(r, "ios")?.name).toMatch(/_ios\.ipa$/);
    expect(pickAsset(r, "windows")?.name).toMatch(/-setup\.exe$/);
    expect(pickAsset(r, "macos")?.name).toMatch(/\.dmg$/);
    expect(pickAsset(r, "web")).toBeNull();
  });
  it("iOS 优先已签名 IPA", () => {
    const r = parseGithubRelease(gh("v0.1.1", { assets: [...gh("v0.1.1").assets, { name: "GPTImageStudio_0.1.1_ios_signed.ipa", browser_download_url: "https://e/s.ipa", size: 1 }] }));
    expect(pickAsset(r, "ios")?.name).toBe("GPTImageStudio_0.1.1_ios_signed.ipa");
  });
  it("草稿 / 预发布 / 缺字段 / 非法版本均报错", () => {
    expect(() => parseGithubRelease(gh("v0.1.1", { prerelease: true }))).toThrow(/正式/);
    expect(() => parseGithubRelease(gh("v0.1.1", { draft: true }))).toThrow();
    expect(() => parseGithubRelease({})).toThrow(/tag_name/);
    expect(() => parseGithubRelease(gh("nightly"))).toThrow(/版本号/);
  });
});

describe("checkLatestRelease", () => {
  it("有新版本", async () => {
    const f = vi.fn(() => resp(200, gh("v0.1.1")));
    const r = await checkLatestRelease("0.1.0", "android", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith(LATEST_RELEASE_API, expect.anything());
    expect(r.kind).toBe("available");
    if (r.kind === "available") expect(r.asset?.url).toBe("https://e/a.apk");
  });
  it("同版本 / 远端更旧 → 已是最新", async () => {
    expect((await checkLatestRelease("0.1.1", "ios", (() => resp(200, gh("v0.1.1"))) as unknown as typeof fetch)).kind).toBe("latest");
    expect((await checkLatestRelease("0.2.0", "ios", (() => resp(200, gh("v0.1.1"))) as unknown as typeof fetch)).kind).toBe("latest");
  });
  it.each([
    [404, /暂未找到/], [403, /频繁/], [429, /频繁/], [500, /HTTP 500/],
  ])("HTTP %d → 抛错", async (status, re) => {
    await expect(checkLatestRelease("0.1.0", "android", (() => resp(status as number, {})) as unknown as typeof fetch)).rejects.toThrow(re as RegExp);
  });
  it("网络错误 → 抛错", async () => {
    await expect(checkLatestRelease("0.1.0", "android", (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch)).rejects.toThrow(/无法连接 GitHub/);
  });
  it("当前版本未知 → 抛错而不是“已是最新”", async () => {
    await expect(checkLatestRelease("", "android", (() => resp(200, gh("v0.1.1"))) as unknown as typeof fetch)).rejects.toThrow(/当前版本/);
  });
});

describe("manualCheckMessage", () => {
  it("失败时绝不显示“已是最新”", () => {
    const m = manualCheckMessage({ kind: "error", error: new Error("Could not fetch a valid release JSON from the remote") });
    expect(m.level).toBe("error");
    expect(m.text).not.toMatch(/最新版本/);
    expect(manualCheckMessage({ kind: "error", error: undefined }).text).toMatch(/未知错误/);
  });
  it("成功分支", () => {
    expect(manualCheckMessage({ kind: "latest" })).toEqual({ level: "success", text: "已是最新版本" });
    expect(manualCheckMessage({ kind: "available", version: "0.1.1" }).text).toBe("发现新版本 0.1.1");
  });
});

describe("updatePlatform", () => {
  it.each([
    [{ tauri: false, android: true, ios: false, mac: false }, "web"],
    [{ tauri: true, android: true, ios: false, mac: false }, "android"],
    [{ tauri: true, android: false, ios: true, mac: true }, "ios"],
    [{ tauri: true, android: false, ios: false, mac: true }, "macos"],
    [{ tauri: true, android: false, ios: false, mac: false }, "windows"],
  ])("%o → %s", (env, p) => expect(updatePlatform(env)).toBe(p));
});
