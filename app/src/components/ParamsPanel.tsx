import { useEffect, useState } from "react";
import { Info, Plus, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Segmented } from "@/components/ui/tabs";
import { Tip } from "@/components/ui/tooltip";
import { Field } from "@/components/common";
import { ModelCombobox } from "@/components/ModelCombobox";
import type { GenParams } from "@/lib/api";
import { modelForGroup, saveModelPref } from "@/lib/models";
import { BACKGROUND, FORMATS, QUALITY, SIZE_PRESETS, UNSET, sizeValid } from "@/lib/params";
import { useData } from "@/lib/store";

const CUSTOM = "__custom__";

export function ParamsPanel({ value, onChange }: { value: GenParams; onChange: (p: GenParams) => void }) {
  const { groups, defaultGroup, openGroupDialog, models, modelsLoading, refreshModels } = useData();
  const set = <K extends keyof GenParams>(k: K, v: GenParams[K]) => onChange({ ...value, [k]: v });
  const groupName = value.group && groups.some((g) => g.name === value.group) ? value.group : defaultGroup;
  const group = groups.find((g) => g.name === groupName);
  const isPreset = value.size === "" || SIZE_PRESETS.some((s) => s.value === value.size);
  const [custom, setCustom] = useState(!isPreset);
  const [w, h] = (value.size.includes("x") ? value.size.split("x") : ["", ""]) as [string, string];
  useEffect(() => { if (!isPreset) setCustom(true); }, [isPreset]);

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4"><CardTitle className="flex items-center gap-2 text-sm"><Settings2 className="size-4 text-primary" />生成参数</CardTitle></CardHeader>
      <CardContent className="space-y-3.5 px-4">
        <Field label="接口分组" hint={<button className="text-primary hover:underline" onClick={() => openGroupDialog(group ?? null)}>{group ? "编辑" : ""}</button>}>
          {groups.length === 0 ? (
            <Button variant="outline" className="w-full border-dashed" onClick={() => openGroupDialog(null)}><Plus />配置 baseUrl 与 apiKey</Button>
          ) : (
            <Select value={groupName} onValueChange={(v) => { if (v === "__new__") openGroupDialog(null); else onChange({ ...value, group: v, model: modelForGroup(v) }); }}>
              <SelectTrigger><SelectValue placeholder="选择接口分组" /></SelectTrigger>
              <SelectContent>
                {groups.map((g) => (
                  <SelectItem key={g.name} value={g.name}>
                    <span className="truncate">{g.displayName || g.name}</span>
                    {g.isDefault && <span className="text-[10px] text-primary">默认</span>}
                    {!g.keyOk && <span className="text-[10px] text-destructive">密钥异常</span>}
                  </SelectItem>
                ))}
                <SelectSeparator />
                <SelectItem value="__new__"><Plus />新建分组…</SelectItem>
              </SelectContent>
            </Select>
          )}
          {group && <div className="truncate font-mono text-[10px] text-muted-foreground" title={group.effectiveBaseUrl}>{group.effectiveBaseUrl} · {group.keyMask || group.keyError}</div>}
        </Field>

        <Field label="模型" hint={group ? `留空 = 分组默认 ${group.model}` : undefined}>
          <ModelCombobox value={value.model} placeholder={group ? `${group.model}（分组默认）` : "gpt-image-2"}
            cache={group ? models[group.name] : undefined} loading={!!(group && modelsLoading[group.name])}
            canRefresh={!!group?.keyOk} onRefresh={group ? () => refreshModels(group.name) : undefined}
            onChange={(m) => { set("model", m); if (groupName) saveModelPref(groupName, m); }} />
        </Field>

        <Field label="尺寸 size" hint={!sizeValid(value.size) ? <span className="text-destructive">格式应为 宽x高</span> : undefined}>
          <Select value={custom ? CUSTOM : value.size || UNSET} onValueChange={(v) => {
            if (v === CUSTOM) { setCustom(true); if (isPreset) set("size", "1280x720"); }
            else { setCustom(false); set("size", v === UNSET ? "" : v); }
          }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {SIZE_PRESETS.map((s) => <SelectItem key={s.value} value={s.value}><span className="font-mono">{s.label}</span><span className="text-xs text-muted-foreground">{s.hint}</span></SelectItem>)}
              <SelectSeparator />
              <SelectItem value={CUSTOM}>自定义尺寸…</SelectItem>
              <SelectItem value={UNSET}><span className="text-muted-foreground">不指定（服务端默认）</span></SelectItem>
            </SelectContent>
          </Select>
          {custom && (
            <div className="flex items-center gap-2">
              <Input inputMode="numeric" value={w} className="font-mono text-xs" placeholder="宽" onChange={(e) => set("size", `${e.target.value.replace(/\D/g, "")}x${h}`)} />
              <span className="text-muted-foreground">×</span>
              <Input inputMode="numeric" value={h} className="font-mono text-xs" placeholder="高" onChange={(e) => set("size", `${w}x${e.target.value.replace(/\D/g, "")}`)} />
            </div>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="画质 quality">
            <Select value={value.quality || UNSET} onValueChange={(v) => set("quality", v === UNSET ? "" : v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {QUALITY.map((q) => <SelectItem key={q.value} value={q.value}>{q.label}</SelectItem>)}
                <SelectSeparator /><SelectItem value={UNSET}><span className="text-muted-foreground">不指定</span></SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="背景 background">
            <Select value={value.background || UNSET} onValueChange={(v) => set("background", v === UNSET ? "" : v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}><span className="text-muted-foreground">不指定</span></SelectItem>
                {BACKGROUND.map((q) => <SelectItem key={q.value} value={q.value}>{q.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field label="输出格式 output_format">
          <Segmented size="sm" className="w-full" value={value.outputFormat || UNSET} onChange={(v) => set("outputFormat", v === UNSET ? "" : v)}
            options={[{ value: UNSET, label: "默认" }, ...FORMATS]} />
        </Field>

        <Field label="生成张数 n">
          <Segmented size="sm" className="w-full" value={value.n} onChange={(v) => set("n", v)} options={[1, 2, 3, 4].map((n) => ({ value: n, label: `${n} 张` }))} />
        </Field>

        <Field label="文件名（可选）">
          <Input value={value.name ?? ""} className="font-mono text-xs" placeholder="留空自动命名，例如 imagegen-20261106-…" onChange={(e) => set("name", e.target.value)} />
        </Field>

        <div className="flex items-start gap-1.5 rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3 shrink-0" />
          <span>参数按所选分组与模型原样发送，绝不回退其它接口或模型。DALL·E 3 仅支持 standard / hd 画质，且不支持 background / output_format，请选择“不指定”。
            <Tip content="“不指定”表示请求中不包含该字段，由服务端使用默认值。"><span className="ml-1 cursor-help underline decoration-dotted">说明</span></Tip>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
