import type { GenParams } from "./api";

export const MODEL_PRESETS = [
  { value: "gpt-image-2", hint: "最新 GPT 生图模型" },
  { value: "gpt-image-1", hint: "GPT Image 1" },
  { value: "gpt-image-1-mini", hint: "轻量、低成本" },
  { value: "dall-e-3", hint: "仅文生图，画质 standard / hd" },
  { value: "dall-e-2", hint: "旧版，支持编辑" },
];

export const SIZE_PRESETS = [
  { value: "1024x1024", label: "1024×1024", hint: "方形 1:1" },
  { value: "1536x1024", label: "1536×1024", hint: "横版 3:2" },
  { value: "1024x1536", label: "1024×1536", hint: "竖版 2:3" },
  { value: "2048x1152", label: "2048×1152", hint: "宽屏 16:9" },
  { value: "1792x1024", label: "1792×1024", hint: "横版（DALL·E 3）" },
  { value: "1024x1792", label: "1024×1792", hint: "竖版（DALL·E 3）" },
  { value: "auto", label: "auto", hint: "由模型决定" },
];

export const QUALITY = [
  { value: "auto", label: "自动 auto" }, { value: "high", label: "高 high" }, { value: "medium", label: "中 medium" },
  { value: "low", label: "低 low" }, { value: "hd", label: "高清 hd（DALL·E 3）" }, { value: "standard", label: "标准 standard（DALL·E）" },
];
export const BACKGROUND = [{ value: "auto", label: "自动 auto" }, { value: "transparent", label: "透明 transparent" }, { value: "opaque", label: "不透明 opaque" }];
export const FORMATS = [{ value: "png", label: "PNG" }, { value: "jpeg", label: "JPEG" }, { value: "webp", label: "WebP" }];

/** Radix Select 不允许空值，用 UNSET 表示“不发送该参数” */
export const UNSET = "__unset__";

export const DEFAULT_PARAMS: GenParams = {
  group: "", model: "", prompt: "", size: "1024x1024", quality: "auto", background: "", outputFormat: "", n: 1,
};

export function loadParams(key: string): GenParams {
  try {
    const raw = localStorage.getItem(`params:${key}`);
    if (raw) return { ...DEFAULT_PARAMS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_PARAMS };
}
export function saveParams(key: string, p: GenParams) {
  localStorage.setItem(`params:${key}`, JSON.stringify(p));
}

export function sizeValid(s: string) {
  return s === "" || s === "auto" || /^\d{2,5}x\d{2,5}$/.test(s);
}
