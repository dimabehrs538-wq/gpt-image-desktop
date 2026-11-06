import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FolderOpen, ImagePlus, RotateCcw, Share2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Tip } from "@/components/ui/tooltip";
import { api, baseName, canShareImages, fileURL, formatBytes, formatMs, formatTime, isDesktopApp, isIOS, isMobileApp, openPath, revealFile, saveImage, shareImage, thumbURL, type HistoryItem } from "@/lib/api";
import { useData } from "@/lib/store";

function Meta({ k, v, mono }: { k: string; v?: React.ReactNode; mono?: boolean }) {
  if (v === undefined || v === "" || v === null) return null;
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={mono ? "font-mono break-all" : "break-all"}>{v}</dd>
    </>
  );
}

export function Lightbox({ items, index, onIndex, onClose }: { items: HistoryItem[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  const { go, groups } = useData();
  const it = index !== null ? items[index] : undefined;
  const [confirm, setConfirm] = useState(false);
  const [delFile, setDelFile] = useState(false);

  useEffect(() => {
    if (index === null) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [index, items.length, onIndex]);

  const touch = useRef<{ x: number; y: number } | null>(null);
  if (!it) return null;
  const g = groups.find((x) => x.name === it.group);
  const params = { group: it.group, model: it.model, prompt: it.prompt, size: it.size ?? "", quality: it.quality ?? "", background: it.background ?? "", outputFormat: it.outputFormat ?? "", n: it.n || 1 };
  const safe = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { toast.error(String((e as Error).message ?? e)); } };
  const mobile = isMobileApp();
  const doSave = () => safe(async () => {
    const r = await saveImage(it.path);
    if (r === "saved") toast.success("已保存到系统相册", { description: "相册 › Pictures/GPTImageStudio" });
    else if (r === "downloaded") toast.success("已开始下载原图");
  });
  const doShare = () => safe(async () => { const r = await shareImage(it.path); if (r === "downloaded") toast.success("当前环境不支持分享，已改为下载原图"); });
  // 移动端左右滑动切换
  const onTouchStart = (e: React.TouchEvent) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
  const onTouchEnd = (e: React.TouchEvent) => {
    const t = touch.current; touch.current = null;
    if (!t) return;
    const dx = e.changedTouches[0].clientX - t.x, dy = e.changedTouches[0].clientY - t.y;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0 && index! < items.length - 1) onIndex(index! + 1);
    if (dx > 0 && index! > 0) onIndex(index! - 1);
  };

  return (
    <>
      <Dialog open={index !== null} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="h-[min(92vh,900px)] gap-0 overflow-hidden p-0 sm:max-w-[min(1280px,95vw)] max-md:h-dvh max-md:max-h-dvh max-md:max-w-full max-md:rounded-none max-md:border-0 max-md:pt-safe max-md:[&>button]:top-[calc(env(safe-area-inset-top)+0.75rem)] max-md:[&>button]:z-10 max-md:[&>button]:rounded-full max-md:[&>button]:bg-black/50 max-md:[&>button]:p-2 max-md:[&>button]:text-white">
          <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,48%)_minmax(0,1fr)] md:grid-cols-[1fr_340px] md:grid-rows-1">
            <div className="checker relative flex min-h-0 touch-pan-y items-center justify-center overflow-hidden" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
              {it.fileSize < 0 ? <div className="text-sm text-muted-foreground">图片文件已被移动或删除</div> : (
                <img key={it.id} src={fileURL(it.path)} alt={it.prompt} className="max-h-full max-w-full object-contain animate-in fade-in-0" />
              )}
              {index! > 0 && <Button size="icon" variant="secondary" className="absolute left-3 rounded-full opacity-80 hover:opacity-100" onClick={() => onIndex(index! - 1)}><ChevronLeft /></Button>}
              {index! < items.length - 1 && <Button size="icon" variant="secondary" className="absolute right-3 rounded-full opacity-80 hover:opacity-100" onClick={() => onIndex(index! + 1)}><ChevronRight /></Button>}
              <div className="absolute bottom-3 left-3 rounded-md bg-black/55 px-2 py-0.5 text-xs text-white">{index! + 1} / {items.length}</div>
            </div>
            <div className="flex min-h-0 flex-col bg-background max-md:border-t md:border-l">
              <div className="space-y-2 border-b p-4 pr-10">
                <DialogTitle className="truncate text-sm" title={baseName(it.path)}>{baseName(it.path)}</DialogTitle>
                <DialogDescription className="flex flex-wrap gap-1.5">
                  <Badge variant={it.mode === "edit" ? "warning" : "brand"}>{it.mode === "edit" ? "图生图" : "文生图"}</Badge>
                  <Badge variant="secondary">{g?.displayName || it.group}</Badge>
                  <Badge variant="outline" className="font-mono">{it.model}</Badge>
                </DialogDescription>
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs">
                <div>
                  <div className="mb-1 flex items-center justify-between font-medium text-muted-foreground">Prompt
                    <button className="flex items-center gap-1 text-primary hover:underline" onClick={() => navigator.clipboard.writeText(it.prompt).then(() => toast.success("已复制提示词"))}><Copy className="size-3" />复制</button>
                  </div>
                  <p className="rounded-md bg-muted/50 p-2.5 text-sm leading-relaxed whitespace-pre-wrap">{it.prompt}</p>
                </div>
                {it.revisedPrompt && (
                  <div>
                    <div className="mb-1 flex items-center justify-between font-medium text-muted-foreground">Revised Prompt
                      <button className="flex items-center gap-1 text-primary hover:underline" onClick={() => navigator.clipboard.writeText(it.revisedPrompt!).then(() => toast.success("已复制"))}><Copy className="size-3" />复制</button>
                    </div>
                    <p className="rounded-md bg-muted/50 p-2.5 leading-relaxed whitespace-pre-wrap">{it.revisedPrompt}</p>
                  </div>
                )}
                <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5">
                  <Meta k="生成时间" v={formatTime(it.createdAt)} />
                  <Meta k="接口分组" v={`${g?.displayName || it.group}（${it.group}）`} />
                  <Meta k="请求地址" v={it.baseUrl} mono />
                  <Meta k="模型" v={it.model} mono />
                  <Meta k="尺寸" v={[it.size || "默认", it.width ? `实际 ${it.width}×${it.height}` : ""].filter(Boolean).join(" · ")} />
                  <Meta k="画质" v={it.quality || "默认"} />
                  <Meta k="背景" v={it.background || "默认"} />
                  <Meta k="格式" v={it.outputFormat || "默认"} />
                  <Meta k="张数" v={`第 ${it.index + 1} / ${it.n} 张`} />
                  <Meta k="耗时" v={formatMs(it.elapsedMs)} />
                  <Meta k="文件大小" v={formatBytes(it.fileSize)} />
                  <Meta k="文件路径" v={it.path} mono />
                </dl>
                {!!it.inputImages?.length && (
                  <div>
                    <div className="mb-1.5 font-medium text-muted-foreground">参考图（按上传顺序）</div>
                    <div className="flex flex-wrap gap-1.5">
                      {it.inputImages.map((p, i) => (
                        <div key={p + i} className="relative">
                          <img src={thumbURL(p, 128)} className="size-14 rounded-md border object-cover" alt="" />
                          <span className="absolute top-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] text-white">{i + 1}</span>
                        </div>
                      ))}
                      {it.mask && <div className="relative"><img src={thumbURL(it.mask, 128)} className="checker size-14 rounded-md border object-cover" alt="" /><span className="absolute top-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] text-white">蒙版</span></div>}
                    </div>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 border-t p-3 max-md:pb-[calc(env(safe-area-inset-bottom)+0.75rem)] max-md:[&_button]:h-10">
                <Button size="sm" onClick={() => { onClose(); go(it.mode === "edit" ? "edit" : "create", { params, images: it.mode === "edit" ? it.inputImages?.map((p) => ({ path: p })) : undefined, mask: it.mask ? { path: it.mask } : null }); }}><RotateCcw />复用参数再来一张</Button>
                <Button size="sm" variant="secondary" onClick={() => { onClose(); go("edit", { params: { ...params, prompt: "" }, images: [{ path: it.path }] }); }}><ImagePlus />作为参考图编辑</Button>
                {isDesktopApp() ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => safe(() => revealFile(it.path))}><FolderOpen />打开所在目录</Button>
                    <Button size="sm" variant="outline" onClick={() => safe(() => openPath(it.path))}><ExternalLink />系统看图打开</Button>
                  </>
                ) : mobile ? (
                  <>
                    <Button size="sm" variant="outline" disabled={it.fileSize < 0} onClick={doSave}><Download />{isIOS() ? "存储到相册" : "保存到相册"}</Button>
                    <Button size="sm" variant="outline" disabled={it.fileSize < 0} onClick={doShare}><Share2 />分享图片</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="outline" asChild><a href={fileURL(it.path, true)}><Download />下载原图</a></Button>
                    {canShareImages() ? <Button size="sm" variant="outline" onClick={doShare}><Share2 />分享图片</Button>
                      : <Button size="sm" variant="outline" onClick={() => openPath(it.path)}><ExternalLink />新标签打开</Button>}
                  </>
                )}
                <Tip content="删除这条记录，可选择同时删除本地图片文件">
                  <Button size="sm" variant="ghost" className="col-span-2 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => { setDelFile(false); setConfirm(true); }}><Trash2 />删除</Button>
                </Tip>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条作品记录？</AlertDialogTitle>
            <AlertDialogDescription>记录删除后无法恢复。默认只删除记录，图片文件仍保留在输出目录中。</AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 rounded-lg border p-3 text-sm"><Switch checked={delFile} onCheckedChange={setDelFile} />同时删除本地图片文件<span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">{baseName(it.path)}</span></label>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button variant="destructive" onClick={() => safe(async () => {
              await api("DELETE", `/api/history/${it.id}${delFile ? "?deleteFile=1" : ""}`);
              toast.success(delFile ? "已删除记录和图片文件" : "已删除记录");
              setConfirm(false);
              if (items.length <= 1) onClose(); else if (index! >= items.length - 1) onIndex(index! - 1);
            })}><Trash2 />删除</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
