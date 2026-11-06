import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Layers, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { baseName, fileToDataURL, isDesktopApp, isMobileApp, pickImages, thumbURL, uploadImage, type ImageInput } from "@/lib/api";
import { cn } from "@/lib/utils";

const MAX = 16;

export function previewSrc(im: ImageInput) {
  return im.dataUrl ?? (im.path ? thumbURL(im.path, 256) : "");
}

async function filesToInputs(files: FileList | File[]): Promise<ImageInput[]> {
  const out: ImageInput[] = [];
  for (const f of Array.from(files)) {
    if (!f.type.startsWith("image/")) { toast.error(`${f.name} 不是图片`); continue; }
    if (f.size > 50 * 1024 * 1024) { toast.error(`${f.name} 超过 50MB`); continue; }
    // 直接上传文件流为内核附件（移动端 / 浏览器拿不到系统路径）；上传失败时回退为 Base64 随请求提交
    try { out.push(await uploadImage(f)); }
    catch { out.push({ dataUrl: await fileToDataURL(f), name: f.name }); }
  }
  return out;
}

function Drop({ onFiles, children, className }: { onFiles: (f: File[]) => void; children: React.ReactNode; className?: string }) {
  const [over, setOver] = useState(false);
  return (
    <div className={cn(className, over && "border-primary bg-primary/5")}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files)); }}>
      {children}
    </div>
  );
}

export function RefImages({ images, onChange, mask, onMask }: { images: ImageInput[]; onChange: (v: ImageInput[]) => void; mask: ImageInput | null; onMask: (m: ImageInput | null) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const maskRef = useRef<HTMLInputElement>(null);

  const add = (more: ImageInput[]) => {
    const next = [...images, ...more];
    if (next.length > MAX) toast.warning(`参考图最多 ${MAX} 张，已忽略多余图片`);
    onChange(next.slice(0, MAX));
  };
  const [busy, setBusy] = useState(false);
  const mobile = isMobileApp();
  const addFiles = async (files: FileList | File[]) => {
    setBusy(true);
    try { add(await filesToInputs(files)); } finally { setBusy(false); }
  };
  const pick = async () => {
    if (isDesktopApp()) {
      try { add((await pickImages(true, "选择参考图（可多选，按顺序上传）")).map((p) => ({ path: p, name: baseName(p) }))); }
      catch (e) { toast.error(String(e)); }
    } else fileRef.current?.click();
  };
  const pickMask = async () => {
    if (isDesktopApp()) {
      const [p] = await pickImages(false, "选择蒙版图（透明区域为需要编辑的部分）");
      if (p) onMask({ path: p, name: baseName(p) });
    } else maskRef.current?.click();
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= images.length) return;
    const next = [...images];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex flex-row items-center px-4">
        <CardTitle className="flex flex-1 items-center gap-2 text-sm"><Layers className="size-4 text-primary" />参考图 <span className="text-xs font-normal text-muted-foreground">{images.length}/{MAX}</span></CardTitle>
        {images.length > 0 && <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => onChange([])}><Trash2 />清空</Button>}
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={async (e) => { const fs = e.target.files ? Array.from(e.target.files) : []; e.target.value = ""; if (fs.length) await addFiles(fs); }} />
        <input ref={maskRef} type="file" accept="image/png,image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { const [m] = await filesToInputs([f]); if (m) onMask(m); } }} />

        {images.length > 0 && (
          <ol className="space-y-1.5">
            {images.map((im, i) => (
              <li key={(im.path ?? im.name ?? "") + i} className="flex items-center gap-2 rounded-lg border bg-background p-1.5 max-md:p-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">{i + 1}</span>
                <img src={previewSrc(im)} className="checker size-11 shrink-0 rounded-md object-cover" alt="" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">{im.name || (im.path ? baseName(im.path) : `图片 ${i + 1}`)}</div>
                  <div className="text-[10px] text-muted-foreground">{i === 0 ? "图 1 · 通常作为主体 / 底图" : `图 ${i + 1}`}{im.dataUrl ? " · 随请求上传" : " · 已就绪"}</div>
                </div>
                <div className="flex shrink-0">
                  <Button size="icon-sm" variant="ghost" className="size-7 max-md:size-9" disabled={i === 0} onClick={() => move(i, -1)} title="上移"><ArrowUp /></Button>
                  <Button size="icon-sm" variant="ghost" className="size-7 max-md:size-9" disabled={i === images.length - 1} onClick={() => move(i, 1)} title="下移"><ArrowDown /></Button>
                  <Button size="icon-sm" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive max-md:size-9" onClick={() => onChange(images.filter((_, k) => k !== i))} title="移除"><X /></Button>
                </div>
              </li>
            ))}
          </ol>
        )}

        <Drop onFiles={addFiles}
          className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-3 py-5 text-center transition-colors">
          <Upload className="size-5 text-muted-foreground" />
          <div className="text-xs text-muted-foreground">{mobile ? "从相册或文件中选择，可多选（按选择顺序排列）" : "拖拽图片到这里，或"}</div>
          <Button size="sm" variant="outline" className="max-md:h-10 max-md:px-4" disabled={busy} onClick={pick}><ImagePlus />{busy ? "正在上传…" : mobile ? "从相册选择" : "选择图片"}</Button>
        </Drop>

        <div className="rounded-lg border bg-muted/30 p-2.5">
          <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">蒙版 mask（可选）
            {mask && <button className="text-destructive hover:underline" onClick={() => onMask(null)}>移除</button>}
          </div>
          {mask ? (
            <div className="flex items-center gap-2">
              <img src={previewSrc(mask)} className="checker size-11 rounded-md border object-cover" alt="" />
              <div className="min-w-0 flex-1 truncate text-xs">{mask.name || (mask.path ? baseName(mask.path) : "mask.png")}</div>
            </div>
          ) : (
            <Drop onFiles={async (f) => { const [m] = await filesToInputs(f.slice(0, 1)); if (m) onMask(m); }} className="rounded-md border border-dashed p-2 text-center transition-colors">
              <Button size="sm" variant="ghost" className="h-7 text-xs max-md:h-10" onClick={pickMask}>{mobile ? "选择 PNG 蒙版" : "选择 / 拖入 PNG 蒙版"}</Button>
              <div className="text-[10px] text-muted-foreground">透明区域表示需要重绘的部分，尺寸需与图 1 一致</div>
            </Drop>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
