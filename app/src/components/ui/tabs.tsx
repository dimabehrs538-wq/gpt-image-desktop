import * as React from "react";
import { cn } from "@/lib/utils";

/** 分段选择器（轻量 Tabs 替代） */
export function Segmented<T extends string | number>({ value, onChange, options, className, size = "default" }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode }[]; className?: string; size?: "default" | "sm";
}) {
  return (
    <div className={cn("inline-flex rounded-lg bg-muted p-0.5", className)}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" onClick={() => onChange(o.value)}
          className={cn("flex-1 rounded-md px-3 font-medium whitespace-nowrap transition-all", size === "sm" ? "h-7 text-xs" : "h-8 text-sm",
            value === o.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
