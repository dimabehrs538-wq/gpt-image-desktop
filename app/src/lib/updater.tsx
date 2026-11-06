import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Download, ExternalLink, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { androidBridge, isAndroid, isDesktopApp, isIOS, isMac, isTauri, openExternal } from "./api";
import { checkLatestRelease, formatSize, manualCheckMessage, updatePlatform, type ReleaseAsset, type ReleaseInfo } from "./release";
import type { Update } from "@tauri-apps/plugin-updater";

const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 每 4 小时
const FIRST_CHECK_DELAY = 15 * 1000;

interface Ctx {
  version: string; checking: boolean; autoCheck: boolean; setAutoCheck: (v: boolean) => void; checkNow: () => Promise<void>;
  /** 最近一次检查的结果文字（成功 / 失败都记录，供设置页展示） */
  lastResult: { ok: boolean; text: string; at: number } | null;
  /** 当前平台的更新方式说明 */
  channel: "desktop" | "android" | "ios" | "web";
}
const UpdaterCtx = createContext<Ctx>(null!);
export const useUpdater = () => useContext(UpdaterCtx);

interface MobileUpdate { release: ReleaseInfo; asset: ReleaseAsset | null }

/**
 * 软件更新：
 * - Windows：Tauri updater 读取 Release 中的 latest.json（minisign 签名校验）→ 下载 NSIS 安装包 → 停止内核 → passive 模式安装后自动重启。
 * - macOS：Tauri updater 下载 .app.tar.gz（签名校验）→ 停止内核 → 原地替换 .app → relaunch() 重启。
 * - Android：查询 GitHub 最新正式版 → 展示更新说明 → 下载 APK（校验包名 / 版本 / 签名证书）→ 交给系统安装器由用户确认。
 * - iOS：查询 GitHub 最新正式版 → 展示更新说明与下载页；IPA 需用户自行用 AltStore / Sideloadly 等重新签名安装。
 */
export function UpdaterProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [autoCheck, setAuto] = useState(localStorage.getItem("autoUpdate") !== "0");
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<"idle" | "downloading" | "stopping" | "installing" | "relaunching">("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [mobileUpdate, setMobileUpdate] = useState<MobileUpdate | null>(null);
  const [mobileBusy, setMobileBusy] = useState(false);
  const [lastResult, setLastResult] = useState<Ctx["lastResult"]>(null);
  const dismissed = useRef<string | null>(localStorage.getItem("dismissedUpdate"));
  const mac = isMac();
  const channel: Ctx["channel"] = !isTauri() ? "web" : isAndroid() ? "android" : isIOS() ? "ios" : "desktop";
  const dismiss = (v: string | undefined) => { dismissed.current = v ?? null; if (v) localStorage.setItem("dismissedUpdate", v); };

  // Android 原生下载 / 安装进度回调
  useEffect(() => {
    const w = window as unknown as { __gptUpdateEvent?: (e: { stage: string; message: string }) => void };
    w.__gptUpdateEvent = (e) => {
      setMobileBusy(false);
      if (e.stage === "error") toast.error("更新失败", { description: e.message, duration: 10000 });
      else toast.info(e.message);
    };
    return () => { delete w.__gptUpdateEvent; };
  }, []);

  useEffect(() => { if (isTauri()) import("@tauri-apps/api/app").then((m) => m.getVersion()).then(setVersion); }, []);

  const report = (manual: boolean, r: Parameters<typeof manualCheckMessage>[0]) => {
    const m = manualCheckMessage(r);
    setLastResult({ ok: m.level !== "error", text: m.text, at: Date.now() });
    if (!manual) return;
    if (m.level === "error") toast.error(m.text, { description: "请检查网络后重试，或前往 GitHub Releases 页面手动下载。" });
    else if (m.level === "success") toast.success(m.text);
  };

  const check = useCallback(async (manual: boolean) => {
    if (!isTauri()) { if (manual) toast.info("浏览器调试模式不支持更新"); return; }
    setChecking(true);
    try {
      if (isDesktopApp()) {
        const { check } = await import("@tauri-apps/plugin-updater");
        const u = await check();
        if (u) {
          report(manual, { kind: "available", version: u.version });
          if (manual || dismissed.current !== u.version) setUpdate(u);
        } else report(manual, { kind: "latest" });
      } else {
        const current = version || (await import("@tauri-apps/api/app").then((m) => m.getVersion()));
        const platform = updatePlatform({ tauri: true, android: isAndroid(), ios: isIOS(), mac });
        const r = await checkLatestRelease(current, platform);
        if (r.kind === "available") {
          report(manual, { kind: "available", version: r.release.version });
          if (manual || dismissed.current !== r.release.version) setMobileUpdate({ release: r.release, asset: r.asset });
        } else report(manual, { kind: "latest" });
      }
    } catch (e) {
      // 失败时只提示失败原因，绝不显示“已是最新版本”
      report(manual, { kind: "error", error: e });
    } finally { setChecking(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(() => {
    if (!autoCheck || !isTauri()) return;
    const t = setTimeout(() => check(false), FIRST_CHECK_DELAY);
    const iv = setInterval(() => check(false), CHECK_INTERVAL);
    return () => { clearTimeout(t); clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck]);

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

  const mobileInstall = async () => {
    const mu = mobileUpdate;
    if (!mu) return;
    const br = androidBridge();
    if (isAndroid() && br?.installUpdate && mu.asset) {
      const r = br.installUpdate(mu.asset.url, mu.asset.name);
      if (r.startsWith("ok")) { setMobileBusy(true); toast.info("正在下载新版本，可在通知栏查看进度；下载完成后会打开系统安装界面"); setMobileUpdate(null); return; }
      if (r === "permission") { toast.info("请在系统设置中允许「GPT 生图」安装未知应用，返回后再点一次“下载并安装”", { duration: 10000 }); return; }
      toast.error("无法开始下载", { description: r.replace(/^error:/, "") });
      return;
    }
    // iOS / 无原生桥：打开下载页（系统浏览器）
    try { await openExternal(mu.asset && isAndroid() ? mu.asset.url : mu.release.pageUrl); }
    catch (e) { toast.error("无法打开下载页", { description: String(e) }); }
  };

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const mb = (n: number) => (n / 1048576).toFixed(1);
  const busy = phase !== "idle";

  return (
    <UpdaterCtx.Provider value={{ version, checking, autoCheck, lastResult, channel, checkNow: () => check(true),
      setAutoCheck: (v) => { setAuto(v); localStorage.setItem("autoUpdate", v ? "1" : "0"); } }}>
      {children}
      <Dialog open={!!update} onOpenChange={(v) => { if (!v && !busy) { dismiss(update?.version); setUpdate(null); } }}>
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
            <Button variant="outline" disabled={busy} onClick={() => { dismiss(update?.version); setUpdate(null); }}>稍后</Button>
            <Button disabled={busy} onClick={install}>{busy ? <RefreshCw className="animate-spin" /> : <Download />}立即更新</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 移动端：GitHub 最新正式版 */}
      <Dialog open={!!mobileUpdate} onOpenChange={(v) => { if (!v) { dismiss(mobileUpdate?.release.version); setMobileUpdate(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Sparkles className="size-5 text-primary" />发现新版本 {mobileUpdate?.release.version}</DialogTitle>
            <DialogDescription>
              当前版本 {version}。
              {isAndroid()
                ? "将下载新版 APK 并打开系统安装界面，需要你在系统中确认安装（首次需允许本应用“安装未知应用”）。签名一致时覆盖安装会保留数据。"
                : "iOS 版为未签名 IPA，无法在应用内直接更新：请下载 IPA 后用 AltStore / SideStore / Sideloadly 以你的 Apple ID 重新签名安装（同一 Bundle ID 覆盖安装会保留数据）。"}
            </DialogDescription>
          </DialogHeader>
          {mobileUpdate?.release.notes && <div className="max-h-64 overflow-y-auto rounded-lg border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{mobileUpdate.release.notes}</div>}
          {mobileUpdate?.asset && <div className="text-xs text-muted-foreground">安装包：{mobileUpdate.asset.name}（{formatSize(mobileUpdate.asset.size)}）</div>}
          <DialogFooter className="max-md:flex-col-reverse max-md:gap-2">
            <Button variant="outline" onClick={() => { dismiss(mobileUpdate?.release.version); setMobileUpdate(null); }}>稍后</Button>
            {isAndroid() && mobileUpdate?.asset
              ? <Button disabled={mobileBusy} onClick={mobileInstall}><Download />下载并安装</Button>
              : <Button onClick={mobileInstall}><ExternalLink />打开下载页</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </UpdaterCtx.Provider>
  );
}
