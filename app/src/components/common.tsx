import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageHeader({ title, desc, icon: Icon, children }: { title: string; desc?: string; icon?: LucideIcon; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-x-4 gap-y-2 max-md:mb-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {Icon && <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary max-md:hidden"><Icon className="size-5" /></div>}
        <div className="min-w-0">
          {/* 移动端标题已显示在顶部标题栏，这里只保留说明文字 */}
          <h1 className="text-xl font-semibold tracking-tight max-md:hidden">{title}</h1>
          {desc && <p className="mt-0.5 text-sm text-muted-foreground max-md:mt-0 max-md:text-xs">{desc}</p>}
        </div>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

export function Dot({ tone, pulse }: { tone: "green" | "amber" | "red" | "gray" | "violet"; pulse?: boolean }) {
  const c = { green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500", gray: "bg-zinc-400", violet: "bg-primary" }[tone];
  return (
    <span className="relative inline-flex size-2">
      {pulse && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", c)} />}
      <span className={cn("relative inline-flex size-2 rounded-full", c)} />
    </span>
  );
}

export function Empty({ icon: Icon, title, desc, children, className }: { icon: LucideIcon; title: string; desc?: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-14 text-center", className)}>
      <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><Icon className="size-6" /></div>
      <div className="text-sm font-medium">{title}</div>
      {desc && <div className="mt-1 max-w-sm text-xs text-muted-foreground">{desc}</div>}
      {children && <div className="mt-4 flex gap-2">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">{label}{hint && <span className="font-normal">{hint}</span>}</div>
      {children}
    </div>
  );
}
