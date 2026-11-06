import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, eventSourceURL, getCore, notify, setTray, type GenParams, type GroupsResp, type GroupView, type ImageInput, type Job, type Settings, type Status } from "./api";

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

  const setGroups = useCallback((r: GroupsResp) => { setGroupList(r.groups ?? []); setDefault(r.defaultGroup ?? ""); }, []);

  const refresh = useCallback(async () => {
    const [st, gs, se, js] = await Promise.all([
      api<Status>("GET", "/api/status"), api<GroupsResp>("GET", "/api/groups"), api<Settings>("GET", "/api/settings"), api<{ jobs: Job[] }>("GET", "/api/jobs"),
    ]);
    setStatus(st); setGroups(gs); setSettings(se);
    js.jobs.forEach((j) => j.status !== "running" && seenDone.current.add(j.id));
    setJobs(js.jobs);
  }, [setGroups]);

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
              if (j.status === "succeeded") {
                toast.success(`${what}完成`, { description: `已保存 ${j.items.length} 张图片` });
                notify("GPT 生图完成", `${what} · ${j.items.length} 张 · ${(j.elapsedMs / 1000).toFixed(1)} 秒`);
              } else if (j.status === "failed") {
                toast.error(`${what}失败`, { description: j.error, duration: 10000 });
                notify("GPT 生图失败", j.error ?? "");
              }
            }
          } else if (ev.type === "history") setHV((v) => v + 1);
          else if (ev.type === "groups") setGroups(ev.data as GroupsResp);
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
  }, [refresh, setGroups]);

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
      groupOpen, openGroupDialog: (edit) => setGroupOpen({ open: true, edit }), closeGroupDialog: () => setGroupOpen({ open: false }),
    }}>
      {children}
    </DataCtx.Provider>
  );
}
