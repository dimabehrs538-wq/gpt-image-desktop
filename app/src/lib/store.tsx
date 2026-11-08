import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, countLine, eventSourceURL, getCore, jobCounts, notify, setTray, type GenParams, type GroupsResp, type GroupView, type ImageInput, type Job, type ModelCache, type ModelRefreshResult, type ModelsResp, type Settings, type Status } from "./api";
import { autoKey, needsAutoFetch } from "./models";

export type Page = "create" | "edit" | "gallery" | "groups" | "settings";

/** 跨页面传递：复用参数 / 作为参考图继续编辑 */
export interface Handoff { params?: Partial<GenParams>; images?: ImageInput[]; mask?: ImageInput | null; nonce: number; page: Page }

interface Ctx {
  connected: boolean;
  status: Status | null;
  groups: GroupView[];
  defaultGroup: string;
  settings: Settings | null;
  jobs: Job[];
  historyVersion: number;
  page: Page;
  handoff: Handoff | null;
  go: (p: Page, h?: Omit<Handoff, "nonce" | "page">) => void;
  clearHandoff: () => void;
  refresh: () => Promise<void>;
  setGroups: (r: GroupsResp) => void;
  run: <T>(fn: () => Promise<T>, ok?: string) => Promise<T | undefined>;
  /** 各分组的模型列表缓存（来自内核 models.json，重启后可用） */
  models: Record<string, ModelCache>;
  modelsLoading: Record<string, boolean>;
  /** 手动 / 自动刷新某个分组的模型列表；同一分组进行中时复用同一个请求 */
  refreshModels: (group: string, opts?: { silent?: boolean }) => Promise<ModelRefreshResult | undefined>;
  groupOpen: { open: boolean; edit?: GroupView | null };
  openGroupDialog: (edit?: GroupView | null) => void;
  closeGroupDialog: () => void;
}

const DataCtx = createContext<Ctx>(null!);
export const useData = () => useContext(DataCtx);

export function DataProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [groups, setGroupList] = useState<GroupView[]>([]);
  const [defaultGroup, setDefault] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [historyVersion, setHV] = useState(0);
  const [page, setPage] = useState<Page>(() => (new URLSearchParams(location.search).get("page") as Page) || "create");
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [groupOpen, setGroupOpen] = useState<{ open: boolean; edit?: GroupView | null }>({ open: false });
  const seenDone = useRef(new Set<string>());
  const [models, setModels] = useState<Record<string, ModelCache>>({});
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({});
  const inflight = useRef(new Map<string, Promise<ModelRefreshResult | undefined>>());
  const autoTried = useRef(new Set<string>());
  const [modelsLoaded, setModelsLoaded] = useState(false);

  const loadModels = useCallback(async () => {
    try {
      const r = await api<ModelsResp>("GET", "/api/models");
      setModels(r.groups ?? {});
      setModelsLoaded(true);
    } catch { /* 旧版内核不支持时保持空，用户仍可手动输入模型 */ }
  }, []);

  const refreshModels = useCallback((group: string, opts?: { silent?: boolean }) => {
    const running = inflight.current.get(group);
    if (running) return running;
    const p = (async () => {
      setModelsLoading((m) => ({ ...m, [group]: true }));
      try {
        const r = await api<ModelRefreshResult>("POST", `/api/groups/${encodeURIComponent(group)}/models`);
        setModels((m) => ({ ...m, [group]: r.cache }));
        if (!opts?.silent) {
          if (r.ok) toast.success("模型列表已更新", { description: r.message });
          else toast.error("拉取模型列表失败", { description: r.message, duration: 8000 });
        }
        return r;
      } catch (e) {
        if (!opts?.silent) toast.error((e as Error).message || String(e));
        return undefined;
      } finally {
        inflight.current.delete(group);
        setModelsLoading((m) => ({ ...m, [group]: false }));
      }
    })();
    inflight.current.set(group, p);
    return p;
  }, []);

  const setGroups = useCallback((r: GroupsResp) => { setGroupList(r.groups ?? []); setDefault(r.defaultGroup ?? ""); }, []);

  const refresh = useCallback(async () => {
    const [st, gs, se, js] = await Promise.all([
      api<Status>("GET", "/api/status"), api<GroupsResp>("GET", "/api/groups"), api<Settings>("GET", "/api/settings"), api<{ jobs: Job[] }>("GET", "/api/jobs"),
    ]);
    setStatus(st); setGroups(gs); setSettings(se);
    loadModels();
    js.jobs.forEach((j) => j.status !== "running" && seenDone.current.add(j.id));
    setJobs(js.jobs);
  }, [setGroups, loadModels]);

  // 连接内核 + SSE（断线自动重连）
  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = async () => {
      try {
        await getCore();
        await refresh();
        setConnected(true);
        es = new EventSource(await eventSourceURL());
        es.onmessage = (m) => {
          const ev = JSON.parse(m.data) as { type: string; data: unknown };
          if (ev.type === "job") {
            const j = ev.data as Job;
            setJobs((list) => [j, ...list.filter((x) => x.id !== j.id)].sort((a, b) => b.createdAt - a.createdAt));
            if (j.status !== "running" && !seenDone.current.has(j.id)) {
              seenDone.current.add(j.id);
              const what = j.mode === "edit" ? "图生图" : "文生图";
              const c = jobCounts(j);
              if (j.status === "succeeded") {
                toast.success(`${what}完成`, { description: [`已保存 ${c.saved} 张图片`, ...c.notes].join("；") });
                notify("GPT 生图完成", `${what} · ${c.saved} 张 · ${(j.elapsedMs / 1000).toFixed(1)} 秒`);
              } else if (j.status === "partial") {
                // 张数不足不算完整成功：明确提示期望 / 实际张数与原因
                toast.warning(`${what}只完成了一部分`, { description: `${countLine(j)}${j.error ? `：${j.error}` : ""}`, duration: 12000 });
                notify("GPT 生图部分完成", `${what} · ${countLine(j)}`);
              } else if (j.status === "failed") {
                toast.error(`${what}失败`, { description: j.error, duration: 10000 });
                notify("GPT 生图失败", j.error ?? "");
              }
            }
          } else if (ev.type === "history") setHV((v) => v + 1);
          else if (ev.type === "groups") { setGroups(ev.data as GroupsResp); loadModels(); }
          else if (ev.type === "models") { const c = ev.data as ModelCache; setModels((m) => ({ ...m, [c.group]: c })); }
          else if (ev.type === "settings") setSettings(ev.data as Settings);
        };
        es.onerror = () => {
          es?.close(); setConnected(false);
          if (!closed) timer = setTimeout(connect, 2000);
        };
      } catch {
        setConnected(false);
        if (!closed) timer = setTimeout(connect, 1500);
      }
    };
    connect();
    return () => { closed = true; es?.close(); clearTimeout(timer); };
  }, [refresh, setGroups, loadModels]);

  // 新增分组 / 尚无缓存 / 端点变化导致缓存失效时，每个会话每个端点只自动拉取一次（失败不自动重试，避免高频请求）
  useEffect(() => {
    if (!connected || !modelsLoaded) return;
    for (const g of groups) {
      if (needsAutoFetch(g, models[g.name], autoTried.current)) {
        autoTried.current.add(autoKey(g));
        refreshModels(g.name, { silent: true });
      }
    }
  }, [connected, modelsLoaded, groups, models, refreshModels]);

  // 托盘提示
  const running = jobs.filter((j) => j.status === "running").length;
  useEffect(() => { setTray(running ? `生成中…（${running} 个任务）` : connected ? "空闲" : "正在连接内核"); }, [running, connected]);

  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string) => {
    try {
      const r = await fn();
      if (ok) toast.success(ok);
      return r;
    } catch (e) {
      toast.error((e as Error).message || String(e));
      return undefined;
    }
  }, []);

  const go = useCallback((p: Page, h?: Omit<Handoff, "nonce" | "page">) => {
    if (h) setHandoff({ ...h, nonce: Date.now(), page: p });
    setPage(p);
  }, []);

  return (
    <DataCtx.Provider value={{
      connected, status, groups, defaultGroup, settings, jobs, historyVersion, page, handoff, go, clearHandoff: () => setHandoff(null), refresh, setGroups, run,
      models, modelsLoading, refreshModels,
      groupOpen, openGroupDialog: (edit) => setGroupOpen({ open: true, edit }), closeGroupDialog: () => setGroupOpen({ open: false }),
    }}>
      {children}
    </DataCtx.Provider>
  );
}
