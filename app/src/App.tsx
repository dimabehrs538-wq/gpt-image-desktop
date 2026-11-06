import { ImagePlus, Images, KeyRound, Loader2, Moon, Settings as SettingsIcon, Sparkles, Sun, Wand2 } from "lucide-react";
import { useTheme } from "next-themes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dot } from "@/components/common";
import { GroupDialog } from "@/components/GroupDialog";
import { isMobileApp } from "@/lib/api";
import { useData, type Page } from "@/lib/store";
import { cn } from "@/lib/utils";
import Create from "@/pages/Create";
import Edit from "@/pages/Edit";
import Gallery from "@/pages/Gallery";
import Groups from "@/pages/Groups";
import Settings from "@/pages/Settings";

/**
 * 自适应布局：
 * - 桌面（≥ 768px）：左侧边栏 + 双栏工作台
 * - 移动窄屏（< 768px）：顶部紧凑标题栏 + 底部固定五栏导航（创作 / 编辑 / 画廊 / 接口 / 设置），适配刘海与手势条安全区域
 */
export default function App() {
  const { page, go, connected, jobs, groups, defaultGroup, status, openGroupDialog } = useData();
  const { resolvedTheme, setTheme } = useTheme();
  const running = jobs.filter((j) => j.status === "running");
  const runGen = running.filter((j) => j.mode === "generate").length;
  const runEdit = running.filter((j) => j.mode === "edit").length;
  const def = groups.find((g) => g.name === defaultGroup);
  const nav: { id: Page; label: string; short: string; icon: typeof Wand2; badge?: number }[] = [
    { id: "create", label: "创作工作台", short: "创作", icon: Wand2, badge: runGen || undefined },
    { id: "edit", label: "图生图 / 编辑", short: "编辑", icon: ImagePlus, badge: runEdit || undefined },
    { id: "gallery", label: "作品画廊", short: "画廊", icon: Images },
    { id: "groups", label: "接口配置", short: "接口", icon: KeyRound },
    { id: "settings", label: "系统设置", short: "设置", icon: SettingsIcon },
  ];
  const statusText = !connected ? "正在连接内核…" : running.length ? `生成中 · ${running.length} 个任务` : "内核就绪";
  const toggleTheme = () => setTheme(resolvedTheme === "dark" ? "light" : "dark");
  const current = nav.find((n) => n.id === page);

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {/* 桌面：左侧边栏 */}
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex items-center gap-2.5 px-4 pt-5 pb-6">
          <div className="brand-gradient flex size-9 items-center justify-center rounded-xl text-white shadow-md shadow-primary/25">
            <Sparkles className="size-[18px]" />
          </div>
          <div>
            <div className="text-sm leading-tight font-semibold">GPT 生图工作室</div>
            <div className="text-[11px] text-muted-foreground">OpenAI 兼容 · {isMobileApp() ? "移动端" : "本地桌面端"}</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {nav.map((n) => (
            <button key={n.id} onClick={() => go(n.id)}
              className={cn("group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                page === n.id ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}>
              <n.icon className={cn("size-4", page === n.id && "text-primary")} />
              <span className="flex-1 text-left">{n.label}</span>
              {n.badge !== undefined && <Badge className="h-5 min-w-5 justify-center gap-1 px-1.5 tabular-nums"><Loader2 className="animate-spin" />{n.badge}</Badge>}
            </button>
          ))}
        </nav>

        <div className="mx-3 mt-6 rounded-xl border bg-background/60 p-3">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">当前默认接口</div>
          {def ? (
            <button className="w-full text-left" onClick={() => openGroupDialog(def)}>
              <div className="truncate text-sm font-medium">{def.displayName || def.name}</div>
              <div className="truncate font-mono text-[10px] text-muted-foreground">{def.model} · {def.keyMask || "密钥异常"}</div>
            </button>
          ) : (
            <Button size="sm" className="mt-1 w-full" onClick={() => openGroupDialog(null)}>配置 baseUrl / apiKey</Button>
          )}
        </div>

        <div className="mt-auto space-y-3 border-t p-3">
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <Dot tone={!connected ? "amber" : running.length ? "violet" : "green"} pulse={!connected || running.length > 0} />
            <span>{statusText}</span>
            {status?.version && <span className="ml-auto font-mono text-[10px]">v{status.version}</span>}
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" onClick={toggleTheme}>
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}{resolvedTheme === "dark" ? "浅色模式" : "深色模式"}
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动端：顶部紧凑标题栏 */}
        <header className="pt-safe pl-safe pr-safe z-30 shrink-0 border-b bg-background/85 backdrop-blur-md md:hidden">
          <div className="flex h-12 items-center gap-2.5 px-4">
            <div className="brand-gradient flex size-7 items-center justify-center rounded-lg text-white shadow shadow-primary/25"><Sparkles className="size-3.5" /></div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] leading-tight font-semibold">{current?.label ?? "GPT 生图工作室"}</div>
              <button className="flex max-w-full items-center gap-1.5 text-[11px] text-muted-foreground" onClick={() => (def ? openGroupDialog(def) : openGroupDialog(null))}>
                <Dot tone={!connected ? "amber" : running.length ? "violet" : "green"} pulse={!connected || running.length > 0} />
                <span className="truncate">{running.length ? statusText : def ? `${def.displayName || def.name} · ${def.model}` : connected ? "点此配置 baseUrl / apiKey" : statusText}</span>
              </button>
            </div>
            <Button variant="ghost" size="icon" className="size-10 text-muted-foreground" onClick={toggleTheme} aria-label="切换主题">
              {resolvedTheme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {!connected && !status ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-sm text-muted-foreground">
              <Loader2 className="size-6 animate-spin text-primary" />
              正在启动本地内核…
              {!isMobileApp() && <p className="max-w-sm text-center text-xs">浏览器调试模式请使用 <code className="font-mono">?port=端口&token=令牌</code> 打开（见数据目录下 daemon.json）。</p>}
            </div>
          ) : (
            <div className={cn("mx-auto pt-4 pr-[max(1rem,env(safe-area-inset-right))] pb-6 pl-[max(1rem,env(safe-area-inset-left))] md:px-8 md:py-7", page === "gallery" ? "max-w-7xl" : "max-w-6xl")}>
              {page === "create" && <Create />}
              {page === "edit" && <Edit />}
              {page === "gallery" && <Gallery />}
              {page === "groups" && <Groups />}
              {page === "settings" && <Settings />}
            </div>
          )}
        </main>

        {/* 移动端：底部固定五栏导航 */}
        <nav className="pb-safe pl-safe pr-safe z-30 shrink-0 border-t bg-background/90 backdrop-blur-md md:hidden" aria-label="主导航">
          <div className="grid h-14 grid-cols-5">
            {nav.map((n) => {
              const active = page === n.id;
              return (
                <button key={n.id} onClick={() => go(n.id)} aria-current={active ? "page" : undefined}
                  className={cn("relative flex flex-col items-center justify-center gap-0.5 text-[11px] transition-colors active:bg-muted/60", active ? "font-medium text-primary" : "text-muted-foreground")}>
                  {active && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-primary" />}
                  <span className="relative">
                    <n.icon className="size-[22px]" strokeWidth={active ? 2.2 : 1.8} />
                    {n.badge !== undefined && <span className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground tabular-nums">{n.badge}</span>}
                  </span>
                  {n.short}
                </button>
              );
            })}
          </div>
        </nav>
      </div>
      <GroupDialog />
    </div>
  );
}
