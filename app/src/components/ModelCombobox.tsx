import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import type { ModelCache } from "@/lib/api";
import { cacheStatus, notInList, suggestions } from "@/lib/models";
import { MODEL_PRESETS } from "@/lib/params";
import { cn } from "@/lib/utils";

const PRESETS = MODEL_PRESETS.map((m) => m.value);
const PRESET_HINT = Object.fromEntries(MODEL_PRESETS.map((m) => [m.value, m.hint]));

/**
 * 可选可输入的模型选择框：下拉显示该分组已拉取的 image 模型（及内置预设），也可以直接输入任意模型名。
 * 刷新列表不会改动当前值；值不在列表中时只提示，不会被静默替换。
 */
export function ModelCombobox({ value, onChange, placeholder, cache, loading, onRefresh, canRefresh = true, className }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  cache?: ModelCache; loading?: boolean; onRefresh?: () => void; canRefresh?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const models = cache && !cache.stale ? cache.models : [];
  const sug = useMemo(() => suggestions(models, PRESETS, value), [models, value]);
  const items = [...sug.fetched, ...sug.presets];
  const st = cacheStatus(cache, !!loading);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => { setActive(-1); }, [value, open]);

  const pick = (m: string) => { onChange(m); setOpen(false); input.current?.blur(); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(-1, i - 1)); }
    else if (e.key === "Enter" && open && active >= 0 && items[active]) { e.preventDefault(); pick(items[active]); }
    else if (e.key === "Escape") { if (open) e.stopPropagation(); setOpen(false); }
    else if (e.key === "Tab") setOpen(false);
  };
  const row = (m: string, i: number, hint?: string) => (
    <li key={`${i}-${m}`} id={`${listId}-${i}`} role="option" aria-selected={m === value}
      className={cn("flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 font-mono text-xs max-md:py-2.5", i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")}
      onPointerDown={(e) => e.preventDefault()} onClick={() => pick(m)}>
      <Check className={cn("size-3.5 shrink-0", m === value ? "opacity-100 text-primary" : "opacity-0")} />
      <span className="min-w-0 flex-1 truncate">{m}</span>
      {hint && <span className="shrink-0 font-sans text-[10px] text-muted-foreground">{hint}</span>}
    </li>
  );

  return (
    <div ref={box} className={cn("space-y-1", className)}>
      <div className="relative flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Input ref={input} value={value} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            className="pr-8 font-mono text-xs" placeholder={placeholder} autoComplete="off" spellCheck={false}
            onFocus={() => setOpen(true)}
            onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }}
            onChange={(e) => { onChange(e.target.value); setOpen(true); }} onKeyDown={onKey} />
          <button type="button" aria-label="展开模型列表" tabIndex={-1}
            className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground hover:text-foreground"
            onPointerDown={(e) => e.preventDefault()} onClick={() => { setOpen((o) => !o); input.current?.focus(); }}>
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
          </button>
        </div>
        {onRefresh && (
          <Tip content={canRefresh ? "从接口拉取模型列表（GET /models）" : "请先保存分组并配置可用的 API Key"}>
            <button type="button" aria-label="刷新模型列表" disabled={!canRefresh || loading}
              className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              onClick={onRefresh}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            </button>
          </Tip>
        )}
        {open && (
          <ul id={listId} role="listbox" className="absolute top-full left-0 z-50 mt-1 max-h-[min(16rem,40dvh)] w-full overflow-y-auto overscroll-contain rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
            {sug.fetched.length > 0 && <li className="px-2 pt-1 pb-0.5 text-[10px] font-medium text-muted-foreground">接口返回（名称含 image）</li>}
            {sug.fetched.map((m, i) => row(m, i))}
            {sug.presets.length > 0 && <li className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium text-muted-foreground">内置预设（未经接口确认）</li>}
            {sug.presets.map((m, i) => row(m, sug.fetched.length + i, PRESET_HINT[m]))}
            {items.length === 0 && <li className="px-2 py-2 text-xs text-muted-foreground">没有匹配项，将按输入的名称「{value}」发送</li>}
          </ul>
        )}
      </div>
      <div className={cn("text-[10.5px] leading-snug", { muted: "text-muted-foreground", ok: "text-muted-foreground", warn: "text-amber-600 dark:text-amber-400", error: "text-destructive" }[st.tone])} title={st.text}>
        <span className="line-clamp-2">{st.text}</span>
      </div>
      {notInList(value, cache) && <div className="text-[10.5px] text-muted-foreground">「{value}」不在拉取到的列表中，仍会按原样发送</div>}
    </div>
  );
}
