import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Ban, Clock, Loader2, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/common";
import { ImageCard } from "@/components/ImageCard";
import { Lightbox } from "@/components/Lightbox";
import { api, formatMs, formatTime, type HistoryItem, type Job } from "@/lib/api";
import { useData } from "@/lib/store";
import { cn } from "@/lib/utils";

function Elapsed({ from }: { from: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, []);
  return <span className="font-mono tabular-nums">{((now - from) / 1000).toFixed(1)}s</span>;
}

export function JobFeed({ mode }: { mode: "generate" | "edit" }) {
  const { jobs, groups, run } = useData();
  const list = useMemo(() => jobs.filter((j) => j.mode === mode).slice(0, 12), [jobs, mode]);
  const allItems = useMemo(() => list.flatMap((j) => j.items), [list]);
  const [open, setOpen] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = list.filter((j) => !hidden.has(j.id));

  if (!visible.length) {
    return (
      <Empty icon={Sparkles} title={mode === "edit" ? "上传参考图并描述修改，开始图生图" : "输入提示词，开始你的第一张作品"}
        desc="任务在本地内核中异步执行，生成过程与耗时会实时显示在这里；完成后自动保存到输出目录并收录进作品画廊。" />
    );
  }
  const gname = (n: string) => groups.find((g) => g.name === n)?.displayName || n;
  const idx = (it: HistoryItem) => allItems.findIndex((x) => x.id === it.id);

  return (
    <div className="space-y-4">
      {visible.map((j: Job) => (
        <div key={j.id} className={cn("rounded-xl border bg-card p-3.5 shadow-xs", j.status === "running" && "border-primary/30")}>
          <div className="mb-2.5 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-sm">{j.prompt}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <Badge variant="secondary">{gname(j.group)}</Badge>
                <span className="font-mono">{j.model}</span>
                {j.size && <span className="font-mono">· {j.size}</span>}
                <span>· {j.n} 张</span>
                {j.inputCount > 0 && <span>· {j.inputCount} 张参考图</span>}
                <span>· {formatTime(j.createdAt)}</span>
              </div>
            </div>
            {j.status === "running" && <Badge variant="brand" className="gap-1"><Loader2 className="animate-spin" />生成中 <Elapsed from={j.createdAt} /></Badge>}
            {j.status === "succeeded" && <Badge variant="success" className="gap-1"><Clock />{formatMs(j.elapsedMs)}</Badge>}
            {j.status === "failed" && <Badge variant="destructive" className="gap-1"><AlertCircle />失败</Badge>}
            {j.status === "canceled" && <Badge variant="secondary" className="gap-1"><Ban />已取消</Badge>}
            {j.status === "running" ? (
              <Button size="icon-sm" variant="ghost" title="取消任务" onClick={() => run(() => api("POST", `/api/jobs/${j.id}/cancel`))}><Ban /></Button>
            ) : (
              <Button size="icon-sm" variant="ghost" title="从列表隐藏" onClick={() => setHidden((s) => new Set(s).add(j.id))}><X /></Button>
            )}
          </div>
          {j.status === "running" && (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {Array.from({ length: j.n }).map((_, i) => (
                <div key={i} className="shimmer flex aspect-square items-center justify-center rounded-lg border border-dashed border-primary/30 bg-primary/5">
                  <Sparkles className="size-5 animate-pulse text-primary/60" />
                </div>
              ))}
            </div>
          )}
          {j.status === "failed" && <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-2.5 font-mono text-xs break-all whitespace-pre-wrap text-destructive">{j.error}</div>}
          {j.items.length > 0 && (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {j.items.map((it) => <ImageCard key={it.id} item={it} showMeta={false} onClick={() => setOpen(idx(it))} />)}
            </div>
          )}
        </div>
      ))}
      <Lightbox items={allItems} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </div>
  );
}
