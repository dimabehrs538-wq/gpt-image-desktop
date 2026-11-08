import { describe, expect, it } from "vitest";
import { countLine, jobCounts, type Job } from "./api";

const base: Job = { id: "j", mode: "generate", status: "succeeded", group: "g", model: "m", prompt: "p", n: 4, inputCount: 0, createdAt: 0, elapsedMs: 0, items: [] };

describe("jobCounts / countLine", () => {
  it("部分完成时如实显示期望 / 已保存 / 失败 / 请求次数", () => {
    const j: Job = { ...base, status: "partial", requested: 4, received: 4, saved: 3, failed: 1, requests: 2, notes: ["x"] };
    expect(jobCounts(j)).toMatchObject({ requested: 4, saved: 3, failed: 1, requests: 2, notes: ["x"] });
    expect(countLine(j)).toBe("期望 4 张，已保存 3 张 · 无法使用 1 张 · 请求 2 次");
  });
  it("旧内核没有计数字段时按 n 与 items 推断", () => {
    expect(countLine(base)).toBe("期望 4 张，已保存 0 张");
    expect(jobCounts(base).requests).toBe(1);
  });
});
