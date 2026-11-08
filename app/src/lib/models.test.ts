import { beforeEach, describe, expect, it } from "vitest";
import type { GroupView, ModelCache } from "./api";
import { autoKey, cacheStatus, loadModelPref, modelForGroup, needsAutoFetch, notInList, saveModelPref, suggestions } from "./models";

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

const cache = (o: Partial<ModelCache> = {}): ModelCache => ({
  group: "a", models: ["gpt-image-1", "gpt-image-2"], total: 5, fetchedAt: Date.now() - 1000, effectiveBaseUrl: "https://x/v1",
  stale: false, error: "", errorStatus: 0, errorAt: 0, filter: "image", ...o,
});
const group = (o: Partial<GroupView> = {}) => ({ name: "a", effectiveBaseUrl: "https://x/v1", keySource: "literal", keyMask: "sk-…abcd", keyOk: true, ...o }) as GroupView;

describe("per-group preference", () => {
  it("isolates groups and clears on empty", () => {
    saveModelPref("a", "gpt-image-1"); saveModelPref("b", "flux-image");
    expect(modelForGroup("a")).toBe("gpt-image-1");
    expect(modelForGroup("b")).toBe("flux-image");
    expect(modelForGroup("c")).toBe("");
    saveModelPref("a", "  ");
    expect(loadModelPref("a")).toBe("");
    expect([...mem.values()].join()).not.toMatch(/sk-/);
  });
});

describe("suggestions", () => {
  it("lists fetched first, dedupes presets, filters by query", () => {
    const s = suggestions(["gpt-image-1", "flux-image"], ["gpt-image-2", "gpt-image-1"], "");
    expect(s.fetched).toEqual(["gpt-image-1", "flux-image"]);
    expect(s.presets).toEqual(["gpt-image-2"]);
    expect(suggestions(["gpt-image-1", "flux-image"], [], "FLUX").fetched).toEqual(["flux-image"]);
    // 精确匹配某一项时仍显示全部，方便改选
    expect(suggestions(["gpt-image-1", "flux-image"], [], "gpt-image-1").fetched).toHaveLength(2);
    // 自定义名不在列表也允许（返回空建议，不改值）
    expect(suggestions(["gpt-image-1"], [], "my-model").fetched).toEqual([]);
  });
});

describe("cacheStatus", () => {
  it("covers states", () => {
    expect(cacheStatus(undefined, false).tone).toBe("muted");
    expect(cacheStatus(cache(), true).text).toMatch(/正在拉取/);
    expect(cacheStatus(cache(), false)).toMatchObject({ tone: "ok" });
    expect(cacheStatus(cache(), false).text).toMatch(/2 个 image 模型（接口共 5 个不同模型）/);
    expect(cacheStatus(cache({ stale: true }), false).tone).toBe("warn");
    expect(cacheStatus(cache({ error: "HTTP 401" }), false).text).toMatch(/保留.*2 个模型.*HTTP 401/);
    expect(cacheStatus(cache({ error: "超时", fetchedAt: 0, models: [] }), false).text).toMatch(/^拉取失败/);
    expect(cacheStatus(cache({ models: [], total: 0 }), false).text).toMatch(/空列表/);
    expect(cacheStatus(cache({ models: [], total: 3 }), false).text).toMatch(/都不含 image/);
  });
});

describe("notInList / auto fetch", () => {
  it("only hints, never for empty or stale", () => {
    expect(notInList("custom", cache())).toBe(true);
    expect(notInList("gpt-image-1", cache())).toBe(false);
    expect(notInList("", cache())).toBe(false);
    expect(notInList("custom", cache({ stale: true }))).toBe(false);
  });
  it("auto fetches once per endpoint, not after errors", () => {
    const tried = new Set<string>();
    expect(needsAutoFetch(group(), undefined, tried)).toBe(true);
    expect(needsAutoFetch(group({ keyOk: false }), undefined, tried)).toBe(false);
    expect(needsAutoFetch(group(), cache(), tried)).toBe(false);
    expect(needsAutoFetch(group(), cache({ stale: true }), tried)).toBe(true);
    expect(needsAutoFetch(group(), cache({ fetchedAt: 0, models: [], error: "401" }), tried)).toBe(false);
    tried.add(autoKey(group()));
    expect(needsAutoFetch(group(), undefined, tried)).toBe(false);
    expect(needsAutoFetch(group({ effectiveBaseUrl: "https://y/v1" }), undefined, tried)).toBe(true);
    expect(autoKey(group())).not.toMatch(/secret/i);
  });
});
