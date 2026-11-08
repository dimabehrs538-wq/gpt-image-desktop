import { useEffect, useRef, useState } from "react";
import { Loader2, Lightbulb, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { JobFeed } from "@/components/JobFeed";
import { ParamsPanel } from "@/components/ParamsPanel";
import { RefImages } from "@/components/RefImages";
import { api, isMac, type GenParams, type ImageInput, type Job } from "@/lib/api";
import { loadParams, saveParams, sizeValid } from "@/lib/params";
import { useData } from "@/lib/store";

const IDEAS_GEN = [
  "一只戴着宇航员头盔的橘猫漂浮在星云中，电影感光影，超高细节",
  "极简主义产品海报：透明玻璃香水瓶置于水面，柔和晨光，留白构图",
  "赛博朋克风格的上海外滩夜景，霓虹灯倒映在雨后的街道，广角镜头",
  "水彩插画风格的江南小镇，小桥流水，春天的樱花，温柔色调",
];
const IDEAS_EDIT = [
  "把图 1 的背景替换为日落时分的海滩，保持人物不变",
  "将图 2 中的服装穿到图 1 的人物身上，其余内容保持不变",
  "把图 1 转换为吉卜力动画风格，保持构图与人物姿态",
  "仅修改蒙版区域：在桌面上添加一杯冒着热气的咖啡",
];

export function Composer({ mode }: { mode: "generate" | "edit" }) {
  const { groups, handoff, clearHandoff, run } = useData();
  const key = mode === "edit" ? "edit" : "create";
  const [params, setParams] = useState<GenParams>(() => loadParams(key));
  const [images, setImages] = useState<ImageInput[]>([]);
  const [mask, setMask] = useState<ImageInput | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const applied = useRef(0);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { saveParams(key, { ...params, name: "" }); }, [key, params]);

  // 接收“复用参数 / 作为参考图编辑”
  useEffect(() => {
    if (!handoff || handoff.page !== key || handoff.nonce === applied.current) return;
    applied.current = handoff.nonce;
    if (handoff.params) setParams((p) => ({ ...p, ...handoff.params, name: "" }));
    if (mode === "edit" && handoff.images) { setImages(handoff.images); setMask(handoff.mask ?? null); }
    clearHandoff();
    setTimeout(() => ta.current?.focus(), 50);
  }, [handoff, mode, key, clearHandoff]);

  const ideas = mode === "edit" ? IDEAS_EDIT : IDEAS_GEN;
  const canSubmit = groups.length > 0 && params.prompt.trim() && sizeValid(params.size) && (mode === "generate" || images.length > 0);

  const submit = async () => {
    if (!canSubmit || submitting) {
      if (mode === "edit" && images.length === 0) toast.warning("请先添加至少一张参考图");
      else if (!params.prompt.trim()) toast.warning("请输入提示词");
      return;
    }
    setSubmitting(true);
    const body = { ...params, images: mode === "edit" ? images : undefined, mask: mode === "edit" ? mask : undefined };
    const j = await run(() => api<Job>("POST", mode === "edit" ? "/api/edit" : "/api/generate", body));
    setSubmitting(false);
    if (j) toast.message("任务已提交", { description: `${j.group} · ${j.model} · ${j.n} 张` });
  };

  return (
    // 移动端单列流式排布：提示词 → 参考图 → 参数 → 任务结果（通过 display: contents + order 重排）
    <div className="grid grid-cols-1 gap-4 md:gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="space-y-4 max-lg:contents lg:sticky lg:top-0 lg:self-start">
        {mode === "edit" && <div className="max-lg:order-2"><RefImages images={images} onChange={setImages} mask={mask} onMask={setMask} /></div>}
        <div className="max-lg:order-3"><ParamsPanel value={params} onChange={setParams} /></div>
      </div>
      <div className="min-w-0 space-y-5 max-lg:contents">
        <Card className="gap-0 overflow-hidden p-0 focus-within:border-primary/50 focus-within:ring-[3px] focus-within:ring-primary/10 max-lg:order-1">
          <Textarea ref={ta} value={params.prompt} rows={5}
            placeholder={mode === "edit" ? "描述要如何修改参考图。多张参考图时，请说明每张图的作用，例如：「以图 1 为底图，把图 2 的logo 放到杯子上，其余保持不变」" : "描述你想要的画面：主体、场景、风格、光线、构图、色调……"}
            className="min-h-32 resize-none rounded-none border-0 p-4 text-[15px] leading-relaxed shadow-none focus-visible:ring-0 max-md:min-h-28 dark:bg-transparent"
            onChange={(e) => setParams({ ...params, prompt: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }} />
          <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-3 py-2">
            <div className="scrollbar-none flex min-w-0 items-center gap-2 max-md:-mx-1 max-md:w-full max-md:overflow-x-auto max-md:px-1 md:flex-wrap">
              <Lightbulb className="size-3.5 shrink-0 text-amber-500" />
              {ideas.map((s, i) => (
                <button key={i} className="max-w-52 shrink-0 truncate rounded-full border bg-background px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground max-md:py-1.5" title={s}
                  onClick={() => setParams({ ...params, prompt: s })}>{s}</button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-3 max-md:w-full">
              <span className="text-[11px] text-muted-foreground tabular-nums">{params.prompt.length} 字<span className="max-md:hidden"> · {isMac() ? "⌘" : "Ctrl"}+Enter 生成</span></span>
              <Button variant="brand" className="max-md:ml-auto max-md:h-11 max-md:flex-1 max-md:text-[15px]" disabled={!canSubmit || submitting} onClick={submit}>
                {submitting ? <Loader2 className="animate-spin" /> : <Wand2 />}{mode === "edit" ? "开始编辑" : "立即生成"}{params.n > 1 ? ` ×${params.n}` : ""}
              </Button>
            </div>
          </div>
        </Card>
        <div className="max-lg:order-4"><JobFeed mode={mode} /></div>
      </div>
    </div>
  );
}
