import { useEffect, useState } from "react";
import { ArrowUpCircle, Bell, FolderOpen, Info, Laptop, Layers, Moon, Power, Save, ShieldCheck, Smartphone, Sun, Timer, FileImage, Settings as SettingsIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/common";
import { api, formatUptime, isDesktopApp, isMobileApp, openExternal, openPath, pickDirectory, type Settings as S } from "@/lib/api";
import { RELEASES_PAGE } from "@/lib/release";
import { useData } from "@/lib/store";
import { useUpdater } from "@/lib/updater";
import { cn } from "@/lib/utils";

function Row({ icon: Icon, title, desc, stack, children }: { icon: typeof Bell; title: string; desc: string; stack?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-3 max-md:flex-wrap max-md:gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" /></div>
      <div className="min-w-0 flex-1"><div className="text-sm font-medium">{title}</div><div className="text-xs text-muted-foreground">{desc}</div></div>
      {/* 移动端：带输入框的设置项把控件放到说明文字下方，避免挤压 */}
      {stack ? <div className="flex shrink-0 items-center gap-2 max-md:ml-12 max-md:w-[calc(100%-3rem)] max-md:[&>div]:w-full max-md:[&_input]:flex-1">{children}</div> : children}
    </div>
  );
}

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const { status, settings, run } = useData();
  const up = useUpdater();
  const [out, setOut] = useState("");
  const [timeout, setTimeoutSec] = useState(600);
  const [prefix, setPrefix] = useState("");
  useEffect(() => { if (settings) { setOut(settings.outputDir); setTimeoutSec(settings.requestTimeoutSec); setPrefix(settings.filenamePrefix); } }, [settings]);
  const [auto, setAuto] = useState(false);
  const [notify, setNotify] = useState(localStorage.getItem("notify") !== "0");
  const desktop = isDesktopApp();
  const mobile = isMobileApp();
  useEffect(() => { if (isDesktopApp()) import("@tauri-apps/plugin-autostart").then((m) => m.isEnabled()).then(setAuto).catch(() => {}); }, []);
  const themes = [{ v: "light", l: "浅色", i: Sun }, { v: "dark", l: "深色", i: Moon }, { v: "system", l: "跟随系统", i: Laptop }];
  const save = (patch: Partial<S>, msg: string) => run(() => api<S>("PUT", "/api/settings", patch), msg);

  return (
    <>
      <PageHeader icon={SettingsIcon} title="系统设置" />
      <Card>
        <CardHeader><CardTitle className="text-sm">外观</CardTitle><CardDescription>选择界面主题</CardDescription></CardHeader>
        <CardContent className="grid grid-cols-3 gap-3 max-md:gap-2">
          {themes.map((t) => (
            <button key={t.v} onClick={() => setTheme(t.v)} className={cn("flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors hover:bg-muted/60 max-md:p-3", theme === t.v && "border-primary ring-2 ring-primary/20")}>
              <t.i className="size-5" />{t.l}
            </button>
          ))}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><FolderOpen className="size-4" />图片输出目录</CardTitle>
          <CardDescription>
            生成的图片自动保存到这里；同名文件会自动递增序号（-2、-3…），绝不覆盖已有文件。
            {mobile && "移动端图片保存在应用沙盒内，可在画廊中「保存到相册」或「分享图片」导出。"}
          </CardDescription>
        </CardHeader>
        {mobile ? (
          <CardContent><div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all text-muted-foreground">{settings?.outputDir ?? "-"}</div></CardContent>
        ) : (
          <CardContent className="flex gap-2 max-md:flex-wrap">
            <Input value={out} onChange={(e) => setOut(e.target.value)} className="font-mono text-xs max-md:w-full" />
            {desktop && <Button variant="outline" onClick={async () => { const p = await pickDirectory("选择输出目录", out || undefined); if (p) setOut(p); }}><FolderOpen />浏览</Button>}
            {desktop && settings && <Button variant="ghost" onClick={() => openPath(settings.outputDir).catch((e) => toast.error(String(e)))}>打开</Button>}
            <Button disabled={!out || out === settings?.outputDir} onClick={() => save({ outputDir: out }, "已保存输出目录")}><Save />保存</Button>
          </CardContent>
        )}
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-sm">生成</CardTitle></CardHeader>
        <CardContent>
          <Row stack icon={Timer} title="请求超时" desc="单次生图请求的最长等待时间（10–3600 秒），高画质大图建议 300 秒以上">
            <div className="flex items-center gap-2">
              <Input type="number" min={10} max={3600} value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value))} className="w-24 text-right" />
              <span className="text-xs text-muted-foreground">秒</span>
              <Button size="sm" variant="outline" disabled={timeout === settings?.requestTimeoutSec} onClick={() => save({ requestTimeoutSec: timeout }, "已保存请求超时")}>保存</Button>
            </div>
          </Row>
          <Separator />
          <Row stack icon={FileImage} title="文件名前缀" desc="自动命名时使用的前缀，默认 imagegen（例如 imagegen-20261106-223000.png）">
            <div className="flex items-center gap-2">
              <Input value={prefix} placeholder="imagegen" onChange={(e) => setPrefix(e.target.value)} className="w-36 font-mono text-xs" />
              <Button size="sm" variant="outline" disabled={prefix === (settings?.filenamePrefix ?? "")} onClick={() => save({ filenamePrefix: prefix }, "已保存文件名前缀")}>保存</Button>
            </div>
          </Row>
          <Separator />
          <Row icon={Layers} title="张数不足时逐张补图"
            desc="部分接口 / 中转站会忽略张数，一次只返回 1 张。开启后会按缺少的张数逐张补请求（每次只要 1 张，总请求数不超过所选张数；出错、返回空或取消时立即停止，不会无限重试，也不会更换模型或分组）。按张计费时总张数不超过所选张数；按次计费的中转站会多计最多「张数−1」次请求费用。关闭则只如实提示实际张数。">
            <Switch checked={(settings?.missingPolicy ?? "fill") === "fill"} disabled={!settings}
              onCheckedChange={(v) => save({ missingPolicy: v ? "fill" : "report" }, v ? "已开启逐张补图" : "已关闭逐张补图（只提示实际张数）")} />
          </Row>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-sm">通用</CardTitle></CardHeader>
        <CardContent>
          {!mobile && (
            <>
              <Row icon={Power} title="开机自动启动" desc="登录系统后自动在后台运行，只显示托盘图标">
                <Switch checked={auto} disabled={!desktop} onCheckedChange={async (v) => {
                  const m = await import("@tauri-apps/plugin-autostart");
                  try { v ? await m.enable() : await m.disable(); setAuto(v); toast.success(v ? "已开启开机自启" : "已关闭开机自启"); }
                  catch (e) { toast.error("设置失败", { description: String(e) }); }
                }} />
              </Row>
              <Separator />
            </>
          )}
          <Row icon={Bell} title="完成通知" desc={mobile ? "生图任务完成或失败时发送系统通知（切到后台时也能收到）" : "生图任务完成或失败时弹出系统通知（窗口隐藏到托盘时也能收到）"}>
            <Switch checked={notify} onCheckedChange={(v) => { setNotify(v); localStorage.setItem("notify", v ? "1" : "0"); }} />
          </Row>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-sm">{mobile ? <Smartphone className="size-4 text-primary" /> : <ArrowUpCircle className="size-4 text-primary" />}软件更新</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 py-2 max-md:flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">当前版本 {up.version || "-"}</div>
              <div className="text-xs text-muted-foreground">
                {up.channel === "desktop" && "从 GitHub Releases 获取更新（Windows / macOS），安装包经过签名校验后自动安装并重启"}
                {up.channel === "android" && "检查 GitHub 最新正式版；下载 APK 后由系统安装器安装，需要你在系统界面确认"}
                {up.channel === "ios" && "检查 GitHub 最新正式版；IPA 需用 AltStore / SideStore / Sideloadly 重新签名安装，无法应用内直接更新"}
                {up.channel === "web" && "浏览器调试模式不支持更新"}
              </div>
              {up.lastResult && <div className={cn("mt-1 text-xs", up.lastResult.ok ? "text-muted-foreground" : "text-destructive")}>上次检查：{up.lastResult.text}（{new Date(up.lastResult.at).toLocaleTimeString()}）</div>}
            </div>
            <Button variant="outline" disabled={up.checking || up.channel === "web"} onClick={up.checkNow} className="max-md:w-full"><ArrowUpCircle className={up.checking ? "animate-spin" : ""} />{up.checking ? "检查中…" : "检查更新"}</Button>
          </div>
          <Separator />
          <Row icon={ArrowUpCircle} title="自动检查更新" desc="启动后及每隔 4 小时检查一次，有新版本时提示">
            <Switch checked={up.autoCheck} onCheckedChange={up.setAutoCheck} />
          </Row>
          {mobile && <p className="pt-2 text-xs text-muted-foreground">所有版本：<button className="text-primary underline-offset-2 hover:underline" onClick={() => openExternal(RELEASES_PAGE).catch((e) => toast.error(String(e)))}>GitHub Releases</button></p>}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="size-4 text-emerald-600" />安全与隐私</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>本地内核{mobile ? "（移动端为 App 进程内的 Rust 内核）" : ""}仅监听 127.0.0.1，并使用每次启动随机生成的 40 位 Bearer Token 鉴权；请求直接从本机发往你配置的接口，不经过任何第三方服务器。</p>
          <p>API Key 保存在本机配置文件（权限 0600），界面、接口响应与日志中只出现脱敏掩码；请求失败时返回的错误信息同样会自动抹去密钥。</p>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Info className="size-4" />关于</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-[96px_1fr] gap-y-2 text-sm md:grid-cols-[120px_1fr]">
          <span className="text-muted-foreground">应用版本</span><span>GPT 生图工作室 {up.version || "-"}</span>
          <span className="text-muted-foreground">内核版本</span><span>{status?.core === "rust" ? "imagegen 移动内核（Rust）" : "imagegend"} {status?.version ?? "-"}（PID {status?.pid ?? "-"}）</span>
          <span className="text-muted-foreground">内核运行时间</span><span>{status?.uptime !== undefined ? formatUptime(status.uptime) : "-"}</span>
          <span className="text-muted-foreground">数据目录</span><span className="font-mono text-xs break-all">{status?.home ?? "-"}</span>
          <span className="text-muted-foreground">分组配置</span><span className="font-mono text-xs break-all">{status?.configPath ?? "-"}</span>
          <span className="text-muted-foreground">作品数量</span><span>{status?.historyCount ?? "-"}</span>
        </CardContent>
      </Card>
    </>
  );
}
