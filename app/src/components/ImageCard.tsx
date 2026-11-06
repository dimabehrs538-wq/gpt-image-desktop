import { ImageOff } from "lucide-react";
import { thumbURL, type HistoryItem } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ImageCard({ item, onClick, className, showMeta = true }: { item: HistoryItem; onClick: () => void; className?: string; showMeta?: boolean }) {
  return (
    <button onClick={onClick} className={cn("group relative block overflow-hidden rounded-xl border bg-card text-left shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/10 focus-visible:ring-2 focus-visible:ring-ring", className)}>
      <div className="checker aspect-square w-full overflow-hidden">
        {item.fileSize < 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-muted-foreground"><ImageOff className="size-5" />文件缺失</div>
        ) : (
          <img src={thumbURL(item.path, 384)} loading="lazy" alt={item.prompt} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        )}
      </div>
      {showMeta && (
        <div className="space-y-0.5 p-2.5">
          <p className="line-clamp-2 text-xs leading-snug">{item.prompt}</p>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className={cn("rounded px-1", item.mode === "edit" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-primary/10 text-primary")}>{item.mode === "edit" ? "图生图" : "文生图"}</span>
            <span className="truncate font-mono">{item.model}</span>
            {item.width ? <span className="ml-auto font-mono">{item.width}×{item.height}</span> : null}
          </div>
        </div>
      )}
    </button>
  );
}
