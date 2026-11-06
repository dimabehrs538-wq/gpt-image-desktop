import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Download, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { isDesktopApp, isMac, isMobileApp, isTauri } from "./api";
import type { Update } from "@tauri-apps/plugin-updater";

const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 每 4 小时
const FIRST_CHECK_DELAY = 15 * 1000;

interface Ctx { version: string; checking: boolean; autoCheck: boolean; setAutoCheck: (v: boolean) => void; checkNow: () => Promise<void> }
const UpdaterCtx = createContext<Ctx>(null!);
export const useUpdater = () => useContext(UpdaterCtx);

/**
 * 软件更新：
 * - Windows：下载 NSIS 安装包 → 停止内核 → install() 以 passive 模式启动安装程序并退出本程序（安装完成后自动启动）。
 * - macOS：下载 .app.tar.gz → 停止内核 → install() 原地替换 .app → relaunch() 重启。
 */
export function UpdaterProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [autoCheck, setAuto] = useState(localStorage.getItem("autoUpdate") !== "0");
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<"idle" | "downloading" | "stopping" | "installing" | "relaunching">("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const dismissed = useRef<string | null>(null);
  const mac = isMac();

  useEffect(() => { if (isTauri()) import("@tauri-apps/api/app").then((m) => m.getVersion()).then(setVersion); }, []);

  const check = useCallback(async (manual: boolean) => {
    // 移动端通过 GitHub Releases 下载新版 APK / IPA 覆盖安装，不使用桌面自动更新
    if (!isDesktopApp()) { if (manual) toast.info(isMobileApp() ? "移动端请前往 GitHub Releases 下载新版安装包" : "浏览器调试模式不支持更新"); return; }
    setChecking(true);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const u = await check();
      if (u) {
        if (manual || dismissed.current !== u.version) setUpdate(u);
      } else if (manual) toast.success("已是最新版本");
    } catch (e) {
      if (manual) toast.error("检查更新失败", { description: "无法连接更新服务器，请检查网络后重试。" + (e ? `（${String(e).slice(0, 80)}）` : "") });
    } finally { setChecking(false); }
  }, []);

  useEffect(() => {
    if (!autoCheck || !isDesktopApp()) return;
    const t = setTimeout(() => check(false), FIRST_CHECK_DELAY);
    const iv = setInterval(() => check(false), CHECK_INTERVAL);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, [autoCheck, check]);

  const install = async () => {
    if (!update) return;
    try {
      setPhase("downloading");
      let total = 0, done = 0;
      await update.download((ev) => {
        if (ev.event === "Started") { total = ev.data.contentLength ?? 0; setProgress({ done: 0, total }); }
        else if (ev.event === "Progress") { done += ev.data.chunkLength; setProgress({ done, total }); }
      });
      setPhase("stopping");
      await invoke("stop_core"); // 先停止内核，避免安装时文件被占用
      setPhase("installing");
      await update.install(); // Windows：启动安装程序并退出；macOS：替换 .app 后返回
      setPhase("relaunching");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setPhase("idle");
      toast.error("更新失败", { description: String(e) });
      invoke("restart_core").catch(() => {}); // 更新失败时恢复内核
    }
  };

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const mb = (n: number) => (n / 1048576).toFixed(1);
  const busy = phase !== "idle";

  return (
    <UpdaterCtx.Provider value={{ version, checking, autoCheck, checkNow: () => check(true),
      setAutoCheck: (v) => { setAuto(v); localStorage.setItem("autoUpdate", v ? "1" : "0"); } }}>
      {children}
      <Dialog open={!!update} onOpenChange={(v) => { if (!v && !busy) { dismissed.current = update?.version ?? null; setUpdate(null); } }}>
        <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Sparkles className="size-5 text-primary" />发现新版本 {update?.version}</DialogTitle>
            <DialogDescription>当前版本 {version}。{mac ? "更新会替换应用并自动重新启动。" : "更新会启动安装程序，完成后自动重新启动。"}正在进行的生图任务会被中断。</DialogDescription>
          </DialogHeader>
          {update?.body && <div className="max-h-56 overflow-y-auto rounded-lg border bg-muted/40 p-3 text-sm whitespace-pre-wrap">{update.body}</div>}
          {busy && (
            <div className="space-y-2">
              <Progress value={phase === "downloading" ? pct : 100} className="h-2" />
              <div className="text-xs text-muted-foreground">
                {phase === "downloading" && (progress.total ? `正在下载… ${mb(progress.done)} / ${mb(progress.total)} MB（${pct}%）` : "正在下载…")}
                {phase === "stopping" && "正在停止本地内核…"}
                {phase === "installing" && (mac ? "正在替换应用…" : "正在启动安装程序，程序将自动重启…")}
                {phase === "relaunching" && "正在重新启动…"}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => { dismissed.current = update?.version ?? null; setUpdate(null); }}>稍后</Button>
            <Button disabled={busy} onClick={install}>{busy ? <RefreshCw className="animate-spin" /> : <Download />}立即更新</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </UpdaterCtx.Provider>
  );
}
