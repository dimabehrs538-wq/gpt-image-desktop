import { useEffect, useState } from "react";
import { ArrowUpCircle, Bell, FolderOpen, Info, Laptop, Moon, Power, Save, ShieldCheck, Sun, Timer, FileImage, Settings as SettingsIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/common";
import { api, formatUptime, isTauri, openPath, pickDirectory, type Settings as S } from "@/lib/api";
import { useData } from "@/lib/store";
import { useUpdater } from "@/lib/updater";
import { cn } from "@/lib/utils";

function Row({ icon: Icon, title, desc, children }: { icon: typeof Bell; title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-3">
      <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" /></div>
      <div className="flex-1"><div className="text-sm font-medium">{title}</div><div className="text-xs text-muted-foreground">{desc}</div></div>
      {children}
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
  useEffect(() => { if (isTauri()) import("@tauri-apps/plugin-autostart").then((m) => m.isEnabled()).then(setAuto).catch(() => {}); }, []);
  const themes = [{ v: "light", l: "浅色", i: Sun }, { v: "dark", l: "深色", i: Moon }, { v: "system", l: "跟随系统", i: Laptop }];
  const save = (patch: Partial<S>, msg: string) => run(() => api<S>("PUT", "/api/settings", patch), msg);

  return (
    <>
      <PageHeader icon={SettingsIcon} title="系统设置" />
      <Card>
        <CardHeader><CardTitle className="text-sm">外观</CardTitle><CardDescription>选择界面主题</CardDescription></CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          {themes.map((t) => (
            <button key={t.v} onClick={() => setTheme(t.v)} className={cn("flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors hover:bg-muted/60", theme === t.v && "border-primary ring-2 ring-primary/20")}>
              <t.i className="size-5" />{t.l}
            </button>
          ))}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><FolderOpen className="size-4" />图片输出目录</CardTitle>
          <CardDescription>生成的图片自动保存到这里；同名文件会自动递增序号（-2、-3…），绝不覆盖已有文件。</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Input value={out} onChange={(e) => setOut(e.target.value)} className="font-mono text-xs" />
          {isTauri() && <Button variant="outline" onClick={async () => { const p = await pickDirectory("选择输出目录", out || undefined); if (p) setOut(p); }}><FolderOpen />浏览</Button>}
          {isTauri() && settings && <Button variant="ghost" onClick={() => openPath(settings.outputDir).catch((e) => toast.error(String(e)))}>打开</Button>}
          <Button disabled={!out || out === settings?.outputDir} onClick={() => save({ outputDir: out }, "已保存输出目录")}><Save />保存</Button>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-sm">生成</CardTitle></CardHeader>
        <CardContent>
          <Row icon={Timer} title="请求超时" desc="单次生图请求的最长等待时间（10–3600 秒），高画质大图建议 300 秒以上">
            <div className="flex items-center gap-2">
              <Input type="number" min={10} max={3600} value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value))} className="w-24 text-right" />
              <span className="text-xs text-muted-foreground">秒</span>
              <Button size="sm" variant="outline" disabled={timeout === settings?.requestTimeoutSec} onClick={() => save({ requestTimeoutSec: timeout }, "已保存请求超时")}>保存</Button>
            </div>
          </Row>
          <Separator />
          <Row icon={FileImage} title="文件名前缀" desc="自动命名时使用的前缀，默认 imagegen（例如 imagegen-20261106-223000.png）">
            <div className="flex items-center gap-2">
              <Input value={prefix} placeholder="imagegen" onChange={(e) => setPrefix(e.target.value)} className="w-36 font-mono text-xs" />
              <Button size="sm" variant="outline" disabled={prefix === (settings?.filenamePrefix ?? "")} onClick={() => save({ filenamePrefix: prefix }, "已保存文件名前缀")}>保存</Button>
            </div>
          </Row>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-sm">通用</CardTitle></CardHeader>
        <CardContent>
          <Row icon={Power} title="开机自动启动" desc="登录系统后自动在后台运行，只显示托盘图标">
            <Switch checked={auto} disabled={!isTauri()} onCheckedChange={async (v) => {
              const m = await import("@tauri-apps/plugin-autostart");
              try { v ? await m.enable() : await m.disable(); setAuto(v); toast.success(v ? "已开启开机自启" : "已关闭开机自启"); }
              catch (e) { toast.error("设置失败", { description: String(e) }); }
            }} />
          </Row>
          <Separator />
          <Row icon={Bell} title="完成通知" desc="生图任务完成或失败时弹出系统通知（窗口隐藏到托盘时也能收到）">
            <Switch checked={notify} onCheckedChange={(v) => { setNotify(v); localStorage.setItem("notify", v ? "1" : "0"); }} />
          </Row>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><ArrowUpCircle className="size-4 text-primary" />软件更新</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 py-2">
            <div className="flex-1">
              <div className="text-sm font-medium">当前版本 {up.version || "-"}</div>
              <div className="text-xs text-muted-foreground">从 GitHub Releases 获取更新（Windows / macOS），安装包经过签名校验</div>
            </div>
            <Button variant="outline" disabled={up.checking} onClick={up.checkNow}><ArrowUpCircle className={up.checking ? "animate-spin" : ""} />{up.checking ? "检查中…" : "检查更新"}</Button>
          </div>
          <Separator />
          <Row icon={ArrowUpCircle} title="自动检查更新" desc="启动时及每隔 4 小时检查一次，有新版本时提示">
            <Switch checked={up.autoCheck} onCheckedChange={up.setAutoCheck} />
          </Row>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="size-4 text-emerald-600" />安全与隐私</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>本地内核仅监听 127.0.0.1，并使用每次启动随机生成的 40 位 Bearer Token 鉴权；请求直接从本机发往你配置的接口，不经过任何第三方服务器。</p>
          <p>API Key 保存在本机配置文件（权限 0600），界面、接口响应与日志中只出现脱敏掩码；请求失败时返回的错误信息同样会自动抹去密钥。</p>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Info className="size-4" />关于</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
          <span className="text-muted-foreground">应用版本</span><span>GPT 生图工作室 {up.version || "-"}</span>
          <span className="text-muted-foreground">内核版本</span><span>imagegend {status?.version ?? "-"}（PID {status?.pid ?? "-"}）</span>
          <span className="text-muted-foreground">内核运行时间</span><span>{status?.uptime !== undefined ? formatUptime(status.uptime) : "-"}</span>
          <span className="text-muted-foreground">数据目录</span><span className="font-mono text-xs break-all">{status?.home ?? "-"}</span>
          <span className="text-muted-foreground">分组配置</span><span className="font-mono text-xs break-all">{status?.configPath ?? "-"}</span>
          <span className="text-muted-foreground">作品数量</span><span>{status?.historyCount ?? "-"}</span>
        </CardContent>
      </Card>
    </>
  );
}
