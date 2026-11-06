import { useEffect, useState } from "react";
import { FolderOpen, Images, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Segmented } from "@/components/ui/tabs";
import { Empty, PageHeader } from "@/components/common";
import { ImageCard } from "@/components/ImageCard";
import { Lightbox } from "@/components/Lightbox";
import { api, isDesktopApp, openPath, type HistoryItem } from "@/lib/api";
import { useData } from "@/lib/store";

const PAGE = 60;
const ALL = "__all__";

export default function Gallery() {
  const { historyVersion, groups, settings, go } = useData();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [mode, setMode] = useState<"" | "generate" | "edit">("");
  const [group, setGroup] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [histGroups, setHistGroups] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => { const t = setTimeout(() => setDq(q), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const sp = new URLSearchParams({ q: dq, mode, group, limit: String(limit) });
    api<{ items: HistoryItem[]; total: number; groups: string[] }>("GET", `/api/history?${sp}`)
      .then((r) => { if (alive) { setItems(r.items); setTotal(r.total); setHistGroups(r.groups); } })
      .catch((e) => toast.error(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [dq, mode, group, limit, historyVersion]);

  useEffect(() => { if (open !== null && open >= items.length) setOpen(items.length ? items.length - 1 : null); }, [items.length, open]);

  const allGroups = Array.from(new Set([...groups.map((g) => g.name), ...histGroups]));
  const label = (n: string) => groups.find((g) => g.name === n)?.displayName || n;

  return (
    <>
      <PageHeader icon={Images} title="作品画廊" desc={`共 ${total} 张作品 · 本地历史记录`}>
        {settings && isDesktopApp() && <Button variant="outline" size="sm" onClick={() => openPath(settings.outputDir).catch((e) => toast.error(String(e)))}><FolderOpen />输出目录</Button>}
      </PageHeader>
      <div className="mb-5 flex flex-wrap items-center gap-3 max-md:mb-4 max-md:gap-2">
        <div className="relative min-w-60 flex-1 max-md:w-full max-md:min-w-0 max-md:flex-none">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索提示词、模型、文件名…" className="pl-9" />
        </div>
        <Segmented value={mode} onChange={setMode} options={[{ value: "", label: "全部" }, { value: "generate", label: "文生图" }, { value: "edit", label: "图生图" }]} />
        <Select value={group || ALL} onValueChange={(v) => setGroup(v === ALL ? "" : v)}>
          <SelectTrigger className="w-44 max-md:flex-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部接口分组</SelectItem>
            {allGroups.map((g) => <SelectItem key={g} value={g}>{label(g)}</SelectItem>)}
          </SelectContent>
        </Select>
        {loading && <RefreshCw className="size-4 animate-spin text-muted-foreground" />}
      </div>
      {!loading && items.length === 0 ? (
        <Empty icon={Images} title={dq || mode || group ? "没有符合条件的作品" : "还没有作品"} desc={dq || mode || group ? "换个关键词或筛选条件试试" : "去创作工作台生成第一张图片吧"}>
          {!(dq || mode || group) && <Button onClick={() => go("create")}>开始创作</Button>}
        </Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-4">
          {items.map((it, i) => <ImageCard key={it.id} item={it} onClick={() => setOpen(i)} />)}
        </div>
      )}
      {items.length < total && (
        <div className="mt-6 flex justify-center"><Button variant="outline" onClick={() => setLimit((l) => l + PAGE)}>加载更多（{items.length}/{total}）</Button></div>
      )}
      <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </>
  );
}
