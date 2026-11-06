import { useState } from "react";
import { CheckCircle2, Copy, Download, FileJson, KeyRound, Loader2, MoreHorizontal, Pencil, Plus, Server, Star, Trash2, Upload, XCircle, Zap } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Empty, PageHeader } from "@/components/common";
import { api, isTauri, pickJsonFile, type GroupView, type GroupsResp, type ProbeResult } from "@/lib/api";
import { useData } from "@/lib/store";
import { cn } from "@/lib/utils";

const SRC_CN = { literal: "明文 api_key", env: "环境变量", ref: "引用文件", none: "未配置" } as const;

function GroupCard({ g }: { g: GroupView }) {
  const { openGroupDialog, setGroups, run } = useData();
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [del, setDel] = useState(false);
  const test = async () => {
    setTesting(true); setProbe(null);
    const r = await run(() => api<ProbeResult>("POST", `/api/groups/${encodeURIComponent(g.name)}/test`));
    setTesting(false);
    if (r) setProbe(r);
  };
  return (
    <Card className={cn("gap-3 py-4 transition-shadow hover:shadow-md", g.isDefault && "border-primary/40 ring-1 ring-primary/15")}>
      <CardHeader className="flex flex-row items-start gap-3 px-4">
        <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", g.isDefault ? "brand-gradient text-white" : "bg-muted text-muted-foreground")}><Server className="size-5" /></div>
        <div className="min-w-0 flex-1">
          <CardTitle className="flex items-center gap-2 text-sm">
            <span className="truncate">{g.displayName || g.name}</span>
            {g.isDefault && <Badge variant="brand"><Star className="fill-current" />默认</Badge>}
          </CardTitle>
          <CardDescription className="mt-1 font-mono">{g.name}{g.note ? <span className="font-sans"> · {g.note}</span> : null}</CardDescription>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost"><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => openGroupDialog(g)}><Pencil />编辑</DropdownMenuItem>
            {!g.isDefault && <DropdownMenuItem onClick={() => run(async () => setGroups(await api<GroupsResp>("POST", `/api/groups/${encodeURIComponent(g.name)}/default`)), "已设为默认分组")}><Star />设为默认</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setDel(true)}><Trash2 />删除</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="space-y-2.5 px-4 text-xs">
        <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1.5">
          <span className="text-muted-foreground">baseUrl</span><span className="truncate font-mono" title={g.baseUrl}>{g.baseUrl}{g.appendV1 && <Badge variant="outline" className="ml-1.5 h-4 px-1 text-[9px]">+v1</Badge>}</span>
          <span className="text-muted-foreground">模型</span><span className="font-mono">{g.model}</span>
          <span className="text-muted-foreground">API Key</span>
          <span className="flex items-center gap-1.5">
            {g.keyOk ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <XCircle className="size-3.5 text-destructive" />}
            <span className="font-mono">{g.keyOk ? g.keyMask : ""}</span>
            <span className="text-muted-foreground">{SRC_CN[g.keySource]}{g.keyEnv ? ` ${g.keyEnv}` : ""}</span>
          </span>
        </div>
        {!g.keyOk && g.keyError && <div className="rounded-md bg-destructive/5 px-2 py-1.5 text-destructive">{g.keyError}</div>}
        <div className="space-y-0.5 rounded-md bg-muted/50 px-2.5 py-2 font-mono text-[10.5px] text-muted-foreground">
          <div className="truncate" title={g.generationsUrl}>POST {g.generationsUrl}</div>
          <div className="truncate" title={g.editsUrl}>POST {g.editsUrl}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={testing} onClick={test}>{testing ? <Loader2 className="animate-spin" /> : <Zap />}测试连接</Button>
          <Button size="sm" variant="ghost" onClick={() => openGroupDialog(g)}><Pencil />编辑</Button>
          {probe && (
            <span className={cn("ml-auto flex min-w-0 items-center gap-1 truncate", probe.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")} title={probe.message}>
              {probe.ok ? <CheckCircle2 className="size-3.5 shrink-0" /> : <XCircle className="size-3.5 shrink-0" />}
              <span className="truncate">{probe.ok ? `可用 · ${probe.latencyMs} ms` : probe.message}</span>
            </span>
          )}
        </div>
        {probe?.ok && <div className="text-[11px] text-muted-foreground">{probe.message}</div>}
      </CardContent>
      <AlertDialog open={del} onOpenChange={setDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除接口分组「{g.displayName || g.name}」？</AlertDialogTitle>
            <AlertDialogDescription>该分组的 baseUrl 与密钥配置将从本机删除，已生成的作品不受影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button variant="destructive" onClick={async () => { await run(async () => setGroups(await api<GroupsResp>("DELETE", `/api/groups/${encodeURIComponent(g.name)}`)), "已删除分组"); setDel(false); }}><Trash2 />删除</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default function Groups() {
  const { groups, status, openGroupDialog, run } = useData();
  const [replace, setReplace] = useState(false);
  const [includeKeys, setIncludeKeys] = useState(false);
  const [paste, setPaste] = useState(false);
  const [json, setJson] = useState("");
  const [path, setPath] = useState("");
  const codex = status?.codexConfigPath ?? "~/.codex/image-api-groups.json";

  const doImport = async (body: { path?: string; json?: string }) => {
    const r = await run(() => api<{ imported: number }>("POST", "/api/groups/import", { ...body, replace }));
    if (r) { toast.success(`已导入 ${r.imported} 个分组`); setPaste(false); setJson(""); }
  };

  return (
    <>
      <PageHeader icon={KeyRound} title="接口配置" desc="管理多个 OpenAI 兼容接口分组：baseUrl、apiKey、默认模型与 /v1 规范化">
        <Button onClick={() => openGroupDialog(null)}><Plus />新建分组</Button>
      </PageHeader>

      {groups.length === 0 ? (
        <Empty icon={Server} title="还没有接口分组" desc="新建一个分组，填写 baseUrl 与 apiKey；或从 ~/.codex/image-api-groups.json 一键导入 openai-image-api 技能配置。">
          <Button onClick={() => openGroupDialog(null)}><Plus />新建分组</Button>
          <Button variant="outline" onClick={() => doImport({})}><Download />从 Codex 配置导入</Button>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">{groups.map((g) => <GroupCard key={g.name} g={g} />)}</div>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><FileJson className="size-4 text-primary" />导入 / 导出（兼容 openai-image-api 技能）</CardTitle>
          <CardDescription>格式与 <code className="font-mono">image-api-groups.json</code> 相同，支持 api_key、api_key_env、api_key_ref 三种密钥方式。导出文件以 0600 权限写入。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={codex} className="font-mono text-xs" />
            {isTauri() && <Button variant="outline" onClick={async () => { const p = await pickJsonFile("选择配置文件"); if (p) setPath(p); }}>浏览…</Button>}
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2"><Switch checked={replace} onCheckedChange={setReplace} />导入时替换现有全部分组</label>
            <label className="flex items-center gap-2"><Switch checked={includeKeys} onCheckedChange={setIncludeKeys} />导出时包含明文 api_key</label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => doImport({ path: path || undefined })}><Download />从文件导入</Button>
            <Button variant="outline" onClick={() => setPaste(true)}><FileJson />粘贴 JSON 导入</Button>
            <Button variant="secondary" onClick={() => run(async () => {
              const r = await api<{ path: string; groups: number }>("POST", "/api/groups/export", { path: path || undefined, includeKeys });
              return r;
            }).then((r) => r && toast.success(`已导出 ${r.groups} 个分组`, { description: r.path }))}><Upload />导出到文件</Button>
            <Button variant="outline" onClick={() => run(async () => {
              const r = await api("GET", `/api/groups/export${includeKeys ? "?includeKeys=1" : ""}`);
              await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
            }, "已复制配置 JSON")}><Copy />复制 JSON</Button>
          </div>
          <p className="text-xs text-muted-foreground">路径留空时默认使用 <code className="font-mono">{codex}</code>。{includeKeys && <span className="text-amber-600 dark:text-amber-400"> 注意：导出内容将包含明文密钥，请妥善保管。</span>}</p>
          {status?.configPath && <p className="text-xs text-muted-foreground">本机配置文件：<code className="font-mono">{status.configPath}</code></p>}
        </CardContent>
      </Card>

      <Dialog open={paste} onOpenChange={setPaste}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>粘贴配置 JSON</DialogTitle>
            <DialogDescription>粘贴 image-api-groups.json 的内容，{replace ? "将替换现有全部分组" : "将与现有分组合并（同名覆盖）"}。</DialogDescription>
          </DialogHeader>
          <Textarea value={json} onChange={(e) => setJson(e.target.value)} rows={12} className="font-mono text-xs"
            placeholder={'{\n  "default_group": "default",\n  "groups": {\n    "default": { "base_url": "https://api.openai.com", "append_v1": true, "api_key_env": "OPENAI_API_KEY", "model": "gpt-image-2" }\n  }\n}'} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaste(false)}>取消</Button>
            <Button disabled={!json.trim()} onClick={() => doImport({ json })}><Download />导入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
