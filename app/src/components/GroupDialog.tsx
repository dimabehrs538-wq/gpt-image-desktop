import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, KeyRound, Link2, Loader2, Save, ShieldCheck, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/tabs";
import { Field } from "@/components/common";
import { ModelCombobox } from "@/components/ModelCombobox";
import { api, effectiveBaseUrl, type GroupInput, type GroupsResp, type ProbeResult } from "@/lib/api";
import { MODEL_PRESETS } from "@/lib/params";
import { useData } from "@/lib/store";
import { cn } from "@/lib/utils";

const BASE_PRESETS = [
  { label: "OpenAI 官方", url: "https://api.openai.com", v1: true },
  { label: "本地网关 :8080", url: "http://127.0.0.1:8080", v1: true },
];

const empty: GroupInput = { name: "", displayName: "", note: "", baseUrl: "https://api.openai.com", appendV1: true, model: "gpt-image-2", keySource: "literal", apiKey: "", apiKeyEnv: "OPENAI_API_KEY", apiKeyRef: { path: "", field: "" }, makeDefault: false };

function slug(s: string) {
  const v = s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 48);
  return v || "";
}

export function GroupDialog() {
  const { groupOpen, closeGroupDialog, setGroups, groups, models, modelsLoading, refreshModels } = useData();
  const edit = groupOpen.edit ?? null;
  const [f, setF] = useState<GroupInput>(empty);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [nameTouched, setNameTouched] = useState(false);

  useEffect(() => {
    if (!groupOpen.open) return;
    setShowKey(false); setBusy("");
    if (edit) {
      setF({ name: edit.name, newName: edit.name, displayName: edit.displayName, note: edit.note, baseUrl: edit.baseUrl, appendV1: edit.appendV1, model: edit.model,
        keySource: edit.keySource === "none" ? "literal" : edit.keySource, apiKey: "", apiKeyEnv: edit.keyEnv ?? "", apiKeyRef: edit.keyRef ?? { path: "", field: "" }, makeDefault: edit.isDefault });
      setNameTouched(true);
    } else {
      setF({ ...empty, name: groups.length ? "" : "default", makeDefault: groups.length === 0 });
      setNameTouched(groups.length === 0);
    }
  }, [groupOpen.open, edit, groups.length]);

  const set = <K extends keyof GroupInput>(k: K, v: GroupInput[K]) => setF((o) => ({ ...o, [k]: v }));
  const eff = useMemo(() => effectiveBaseUrl(f.baseUrl, f.appendV1), [f.baseUrl, f.appendV1]);
  const urlOk = /^https?:\/\/[^/\s]+/.test(f.baseUrl.trim());
  const nameVal = edit ? (f.newName ?? f.name) : f.name;
  const nameOk = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nameVal);
  const keyOk = f.keySource === "literal" ? (!!f.apiKey.trim() || (!!edit && edit.keySource === "literal")) : f.keySource === "env" ? !!f.apiKeyEnv.trim() : !!(f.apiKeyRef?.path && f.apiKeyRef.field);
  const valid = urlOk && nameOk && keyOk;
  // 已保存分组且接口地址 / 密钥未在表单中改动时，才展示并允许刷新该组已缓存的模型列表
  const live = edit ? groups.find((g) => g.name === edit.name) : undefined;
  const sameEndpoint = !!live && eff === live.effectiveBaseUrl && f.keySource === (live.keySource === "none" ? "literal" : live.keySource) && !f.apiKey.trim();
  const modelCache = live && sameEndpoint ? models[live.name] : undefined;

  const save = async (test: boolean) => {
    setBusy(test ? "test" : "save");
    try {
      const r = edit ? await api<GroupsResp>("PUT", `/api/groups/${encodeURIComponent(edit.name)}`, f) : await api<GroupsResp>("POST", "/api/groups", f);
      setGroups(r);
      const target = edit ? (f.newName || edit.name) : f.name;
      if (test) {
        const p = await api<ProbeResult>("POST", `/api/groups/${encodeURIComponent(target)}/test`);
        if (p.ok) toast.success("已保存，连接测试通过", { description: `${p.message}（${p.latencyMs} ms）` });
        else toast.error("已保存，但连接测试失败", { description: p.message, duration: 10000 });
        closeGroupDialog();
      } else {
        toast.success(edit ? "分组已更新" : "分组已创建");
        closeGroupDialog();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setBusy(""); }
  };

  return (
    <Dialog open={groupOpen.open} onOpenChange={(v) => !v && busy === "" && closeGroupDialog()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><KeyRound className="size-4 text-primary" />{edit ? `编辑接口分组 · ${edit.displayName || edit.name}` : "新建接口分组"}</DialogTitle>
          <DialogDescription>填写 OpenAI 兼容接口的 baseUrl 与 apiKey。密钥仅保存在本机配置文件（权限 0600），界面只显示脱敏掩码。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="显示名称">
            <Input value={f.displayName} placeholder="例如：OpenAI 官方 / 中转站 A" onChange={(e) => {
              const v = e.target.value; set("displayName", v);
              if (!edit && !nameTouched) set("name", slug(v));
            }} />
          </Field>
          <Field label="分组标识" hint="字母、数字、. _ -">
            <Input value={nameVal} aria-invalid={!!nameVal && !nameOk} className="font-mono text-xs" placeholder="default"
              onChange={(e) => { setNameTouched(true); edit ? set("newName", e.target.value) : set("name", e.target.value); }} />
          </Field>
        </div>

        <Field label={<span className="flex items-center gap-1"><Link2 className="size-3.5" />baseUrl</span>}
          hint={<span className="flex gap-1">{BASE_PRESETS.map((p) => (
            <button key={p.url} type="button" className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted" onClick={() => { set("baseUrl", p.url); set("appendV1", p.v1); }}>{p.label}</button>
          ))}</span>}>
          <Input value={f.baseUrl} aria-invalid={!!f.baseUrl && !urlOk} className="font-mono text-xs" placeholder="https://api.openai.com 或 https://your-host.example/v1" onChange={(e) => set("baseUrl", e.target.value)} />
        </Field>

        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
          <Switch checked={f.appendV1} onCheckedChange={(v) => set("appendV1", v)} id="v1" />
          <label htmlFor="v1" className="flex-1 text-sm">
            自动补全 <code className="rounded bg-muted px-1 font-mono text-xs">/v1</code>（appendV1）
            <div className="text-xs text-muted-foreground">baseUrl 已以 /v1 结尾时不会重复拼接；官方域名会自动补全</div>
          </label>
        </div>

        <div className={cn("space-y-1 rounded-lg border px-3 py-2.5 font-mono text-[11px]", urlOk ? "border-primary/25 bg-primary/5" : "border-dashed text-muted-foreground")}>
          <div className="mb-1 font-sans text-xs font-medium text-muted-foreground">最终请求地址预览</div>
          <div><span className="mr-2 rounded bg-emerald-500/15 px-1 text-emerald-700 dark:text-emerald-400">POST</span>{urlOk ? `${eff}/images/generations` : "—"}</div>
          <div><span className="mr-2 rounded bg-emerald-500/15 px-1 text-emerald-700 dark:text-emerald-400">POST</span>{urlOk ? `${eff}/images/edits` : "—"}</div>
          <div><span className="mr-2 rounded bg-sky-500/15 px-1 text-sky-700 dark:text-sky-400">GET&nbsp;</span>{urlOk ? `${eff}/models` : "—"}<span className="ml-2 font-sans text-muted-foreground">（测试连接）</span></div>
        </div>

        <Field label="默认模型" hint={live ? (sameEndpoint ? "可从拉取的列表选择，也可自由输入" : "接口地址或密钥已改动：保存后可重新拉取模型列表") : "可自由输入任意模型名；保存后会自动拉取模型列表"}>
          <ModelCombobox value={f.model} placeholder="gpt-image-2" onChange={(m) => set("model", m)}
            cache={modelCache} loading={!!(live && modelsLoading[live.name])}
            canRefresh={!!live?.keyOk && sameEndpoint} onRefresh={live ? () => refreshModels(live.name) : undefined} />
          <div className="flex flex-wrap gap-1.5 pt-1">
            {MODEL_PRESETS.map((m) => (
              <button key={m.value} type="button" onClick={() => set("model", m.value)}
                className={cn("rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors", f.model === m.value ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>{m.value}</button>
            ))}
          </div>
        </Field>

        <Field label={<span className="flex items-center gap-1"><ShieldCheck className="size-3.5" />API Key 来源</span>}>
          <Segmented size="sm" value={f.keySource} onChange={(v) => set("keySource", v)} className="w-full"
            options={[{ value: "literal", label: "直接填写 api_key" }, { value: "env", label: "环境变量 api_key_env" }, { value: "ref", label: "引用文件 api_key_ref" }]} />
          {f.keySource === "literal" && (
            <div className="relative pt-1">
              <Input type={showKey ? "text" : "password"} value={f.apiKey} autoComplete="off" className="pr-10 font-mono text-xs"
                placeholder={edit?.keySource === "literal" && edit.keyMask ? `留空保持原密钥（${edit.keyMask}）` : "sk-..."} onChange={(e) => set("apiKey", e.target.value)} />
              <button type="button" className="absolute top-1/2 right-2 mt-0.5 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowKey((v) => !v)}>
                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          )}
          {f.keySource === "env" && (
            <Input value={f.apiKeyEnv} className="mt-1 font-mono text-xs" placeholder="OPENAI_API_KEY" onChange={(e) => set("apiKeyEnv", e.target.value)} />
          )}
          {f.keySource === "ref" && (
            <div className="grid gap-2 pt-1 sm:grid-cols-[1fr_200px]">
              <Input value={f.apiKeyRef?.path ?? ""} className="font-mono text-xs" placeholder="~/.secrets/openai.json" onChange={(e) => set("apiKeyRef", { path: e.target.value, field: f.apiKeyRef?.field ?? "" })} />
              <Input value={f.apiKeyRef?.field ?? ""} className="font-mono text-xs" placeholder="字段，如 providers.openai.key" onChange={(e) => set("apiKeyRef", { path: f.apiKeyRef?.path ?? "", field: e.target.value })} />
            </div>
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="备注（可选）"><Input value={f.note} placeholder="例如：按量计费 / 公司网关" onChange={(e) => set("note", e.target.value)} /></Field>
          <label className="flex h-9 items-center gap-2 text-sm"><Switch checked={f.makeDefault} onCheckedChange={(v) => set("makeDefault", v)} />设为默认分组</label>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={!!busy} onClick={closeGroupDialog}>取消</Button>
          <Button variant="secondary" disabled={!valid || !!busy} onClick={() => save(true)}>{busy === "test" ? <Loader2 className="animate-spin" /> : <Zap />}保存并测试</Button>
          <Button disabled={!valid || !!busy} onClick={() => save(false)}>{busy === "save" ? <Loader2 className="animate-spin" /> : <Save />}保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
