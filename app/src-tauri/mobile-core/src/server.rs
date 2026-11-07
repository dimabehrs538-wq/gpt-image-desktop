//! 仅监听 127.0.0.1、Bearer Token 鉴权的本地 HTTP API 与 SSE 事件流。
//! 路由、请求体、响应 JSON 与 Go `internal/server` 完全一致，前端无需区分桌面 / 移动内核。

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post, put},
    Json, Router,
};
use futures_util::Stream;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::config::{self, codex_config_path, effective_base_url, validate_base_url};
use crate::engine::{Engine, Prepared, Request as GenRequest};
use crate::imageapi::{Client, ProbeResult};
use crate::log::Logger;
use crate::models;
use crate::store::{Item, Query as HQuery, SettingsPatch};
use crate::util::{new_id, now_ms};

pub const VERSION: &str = "0.1.1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub mode: String,
    pub status: String,
    pub group: String,
    pub model: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub size: String,
    pub n: i64,
    pub input_count: usize,
    pub created_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub finished_at: i64,
    pub elapsed_ms: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub error: String,
    pub items: Vec<Item>,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

struct JobEntry {
    job: Job,
    cancel: CancellationToken,
}

pub struct Server {
    token: String,
    engine: Arc<Engine>,
    log: Arc<Logger>,
    start: Instant,
    jobs: Mutex<HashMap<String, JobEntry>>,
    tx: broadcast::Sender<String>,
    sem: Arc<Semaphore>,
    platform: &'static str,
    models: models::Cache,
}

type S = State<Arc<Server>>;

fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, Json(json!({ "error": msg.into() }))).into_response()
}

fn ok<T: Serialize>(v: T) -> Response {
    Json(v).into_response()
}

#[allow(clippy::result_large_err)] // Response 作为错误直接返回给客户端
fn decode<T: DeserializeOwned>(b: &Bytes) -> Result<T, Response> {
    serde_json::from_slice(b).map_err(|e| err(StatusCode::BAD_REQUEST, format!("请求体不是合法 JSON：{e}")))
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

impl Server {
    pub fn new(token: String, engine: Arc<Engine>, log: Arc<Logger>) -> Arc<Self> {
        let (tx, _) = broadcast::channel(64);
        let models = models::Cache::new(engine.home.join("models.json"));
        Arc::new(Self {
            token,
            engine,
            log,
            start: Instant::now(),
            jobs: Mutex::new(HashMap::new()),
            tx,
            sem: Arc::new(Semaphore::new(4)),
            platform: platform(),
            models,
        })
    }

    pub fn router(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/api/status", get(status))
            .route("/api/events", get(events))
            .route("/api/groups", get(list_groups).post(create_group))
            .route("/api/groups/preview", post(preview_group))
            .route("/api/groups/import", post(import_groups))
            .route("/api/groups/export", get(export_groups).post(export_groups_to_file))
            .route("/api/groups/{name}", put(update_group).delete(delete_group))
            .route("/api/groups/{name}/default", post(default_group))
            .route("/api/groups/{name}/test", post(test_group))
            .route("/api/groups/{name}/models", post(refresh_models))
            .route("/api/models", get(list_models))
            .route("/api/settings", get(get_settings).put(put_settings))
            .route("/api/generate", post(|s: S, b: Bytes| submit(s, b, "generate")))
            .route("/api/edit", post(|s: S, b: Bytes| submit(s, b, "edit")))
            .route("/api/uploads", post(upload))
            .route("/api/jobs", get(list_jobs))
            .route("/api/jobs/{id}", get(get_job))
            .route("/api/jobs/{id}/cancel", post(cancel_job))
            .route("/api/history", get(history))
            .route("/api/history/{id}", get(history_item).delete(delete_history))
            .route("/api/files", get(file))
            .route("/api/thumb", get(thumb))
            .layer(middleware::from_fn_with_state(self.clone(), guard))
            .layer(DefaultBodyLimit::max(256 << 20))
            .with_state(self.clone())
    }

    /// 广播事件（订阅者过慢时由 broadcast 丢弃旧消息）。
    pub fn publish(&self, typ: &str, data: Value) {
        let ev = json!({ "type": typ, "data": data, "time": now_ms() });
        let _ = self.tx.send(ev.to_string());
    }

    fn groups_changed(&self) {
        if let Ok((def, groups)) = self.engine.groups.views() {
            self.publish("groups", json!({ "defaultGroup": def, "groups": groups }));
        }
    }

    fn snapshot(e: &JobEntry) -> Job {
        let mut j = e.job.clone();
        if j.status == "running" {
            j.elapsed_ms = now_ms() - j.created_at;
        }
        j
    }

    /// 异步执行已校验的请求。
    pub fn start_job(self: &Arc<Self>, p: Prepared) -> Job {
        let cancel = CancellationToken::new();
        let job = Job {
            id: new_id(),
            mode: p.req.mode.clone(),
            status: "running".into(),
            group: p.req.group.clone(),
            model: p.req.model.clone(),
            prompt: p.req.prompt.clone(),
            size: p.req.size.clone(),
            n: p.req.n,
            input_count: p.images.len(),
            created_at: now_ms(),
            finished_at: 0,
            elapsed_ms: 0,
            error: String::new(),
            items: vec![],
        };
        let id = job.id.clone();
        let snap = {
            let mut jobs = self.jobs.lock().unwrap();
            jobs.insert(id.clone(), JobEntry { job: job.clone(), cancel: cancel.clone() });
            prune(&mut jobs);
            Self::snapshot(&jobs[&id])
        };
        self.log.log(&format!("任务 {} 开始：{} 分组={} 模型={} n={}", id, job.mode, job.group, job.model, job.n));
        self.publish("job", serde_json::to_value(&snap).unwrap());
        let s = self.clone();
        tokio::spawn(async move {
            let res = tokio::select! {
                _ = cancel.cancelled() => None,
                r = async {
                    let _permit = s.sem.acquire().await;
                    s.engine.run(&id, &p).await
                } => Some(r),
            };
            let snap = {
                let mut jobs = s.jobs.lock().unwrap();
                let Some(e) = jobs.get_mut(&id) else { return };
                let j = &mut e.job;
                j.finished_at = now_ms();
                j.elapsed_ms = j.finished_at - j.created_at;
                match &res {
                    None => {
                        j.status = "canceled".into();
                        j.error = "已取消".into();
                    }
                    Some(Err(msg)) => {
                        j.status = "failed".into();
                        j.error = msg.clone();
                    }
                    Some(Ok(items)) => {
                        j.status = "succeeded".into();
                        j.items = items.clone();
                    }
                }
                Self::snapshot(e)
            };
            cancel.cancel();
            match &res {
                Some(Ok(items)) => s.log.log(&format!("任务 {} 完成（{}ms），保存 {} 张", id, snap.elapsed_ms, items.len())),
                _ => s.log.log(&format!("任务 {} 失败（{}ms）：{}", id, snap.elapsed_ms, snap.error)),
            }
            s.publish("job", serde_json::to_value(&snap).unwrap());
            if !snap.items.is_empty() {
                s.publish("history", json!({ "added": snap.items.len() }));
            }
        });
        snap
    }
}

fn prune(jobs: &mut HashMap<String, JobEntry>) {
    if jobs.len() <= 100 {
        return;
    }
    let mut done: Vec<(i64, String)> = jobs
        .values()
        .filter(|e| e.job.status != "running")
        .map(|e| (e.job.created_at, e.job.id.clone()))
        .collect();
    done.sort();
    for (_, id) in done {
        if jobs.len() <= 100 {
            break;
        }
        jobs.remove(&id);
    }
}

fn cors(mut r: Response) -> Response {
    let h = r.headers_mut();
    h.insert("Access-Control-Allow-Origin", HeaderValue::from_static("*"));
    h.insert("Access-Control-Allow-Headers", HeaderValue::from_static("Authorization, Content-Type"));
    h.insert("Access-Control-Allow-Methods", HeaderValue::from_static("GET, POST, PUT, DELETE, OPTIONS"));
    r
}

/// 常量时间比较，避免 token 计时侧信道。
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn query_param(q: Option<&str>, key: &str) -> Option<String> {
    url::form_urlencoded::parse(q?.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

async fn guard(State(s): S, req: Request, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        return cors(StatusCode::NO_CONTENT.into_response());
    }
    let h = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
    let mut tok = h.strip_prefix("Bearer ").unwrap_or(h).to_string();
    if tok.is_empty() {
        tok = query_param(req.uri().query(), "token").unwrap_or_default();
    }
    if s.token.is_empty() || !ct_eq(tok.as_bytes(), s.token.as_bytes()) {
        return cors(err(StatusCode::UNAUTHORIZED, "未授权：token 无效"));
    }
    cors(next.run(req).await)
}

async fn events(State(s): S) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let rx = s.tx.subscribe();
    let hello = json!({ "type": "hello", "data": { "version": VERSION }, "time": now_ms() }).to_string();
    let stream = futures_util::stream::unfold((Some(hello), rx), |(first, mut rx)| async move {
        if let Some(h) = first {
            return Some((Ok(SseEvent::default().data(h)), (None, rx)));
        }
        loop {
            match rx.recv().await {
                Ok(msg) => return Some((Ok(SseEvent::default().data(msg)), (None, rx))),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(20)).text("ping"))
}

async fn status(State(s): S) -> Response {
    let (def, groups) = match s.engine.groups.views() {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let (_, total) = s.engine.store.list(&HQuery::default());
    let active = s.jobs.lock().unwrap().values().filter(|e| e.job.status == "running").count();
    let st = s.engine.store.settings();
    ok(json!({
        "version": VERSION, "pid": std::process::id(), "uptime": s.start.elapsed().as_secs(),
        "home": s.engine.home, "configPath": s.engine.groups.path(), "outputDir": st.output_dir,
        "groups": groups.len(), "defaultGroup": def, "activeJobs": active, "historyCount": total,
        "codexConfigPath": codex_config_path(), "platform": s.platform, "core": "rust",
    }))
}

async fn list_groups(State(s): S) -> Response {
    match s.engine.groups.views() {
        Ok((def, groups)) => ok(json!({ "defaultGroup": def, "groups": groups, "configPath": s.engine.groups.path() })),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn create_group(st: S, b: Bytes) -> Response {
    let s = &st.0;
    let inp: config::Input = match decode(&b) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let name = inp.name.clone();
    if let Err(e) = s.engine.groups.create(inp) {
        return err(StatusCode::BAD_REQUEST, e);
    }
    s.log.log(&format!("创建接口分组 {}", name.trim()));
    s.groups_changed();
    list_groups(st).await
}

async fn update_group(st: S, Path(name): Path<String>, b: Bytes) -> Response {
    let s = &st.0;
    let inp: config::Input = match decode(&b) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let new_name = inp.new_name.trim().to_string();
    if let Err(e) = s.engine.groups.modify(&name, inp) {
        return err(StatusCode::BAD_REQUEST, e);
    }
    if !new_name.is_empty() && new_name != name {
        let _ = s.models.rename(&name, &new_name);
    }
    s.log.log(&format!("更新接口分组 {name}"));
    s.groups_changed();
    list_groups(st).await
}

async fn delete_group(st: S, Path(name): Path<String>) -> Response {
    let s = &st.0;
    if let Err(e) = s.engine.groups.delete(&name) {
        return err(StatusCode::NOT_FOUND, e);
    }
    let _ = s.models.remove(&name);
    s.log.log(&format!("删除接口分组 {name}"));
    s.groups_changed();
    list_groups(st).await
}

async fn default_group(st: S, Path(name): Path<String>) -> Response {
    if let Err(e) = st.0.engine.groups.set_default(&name) {
        return err(StatusCode::NOT_FOUND, e);
    }
    st.0.groups_changed();
    list_groups(st).await
}

async fn preview_group(b: Bytes) -> Response {
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    struct In {
        #[serde(deserialize_with = "crate::util::null_default")]
        base_url: String,
        #[serde(rename = "appendV1", deserialize_with = "crate::util::null_default")]
        append_v1: bool,
    }
    let inp: In = match decode(&b) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let eff = effective_base_url(&inp.base_url, inp.append_v1);
    let mut res = json!({
        "effectiveBaseUrl": eff, "generationsUrl": format!("{eff}/images/generations"),
        "editsUrl": format!("{eff}/images/edits"), "modelsUrl": format!("{eff}/models"),
    });
    if let Err(e) = validate_base_url(&inp.base_url) {
        res["error"] = json!(e);
    }
    ok(res)
}

async fn test_group(State(s): S, Path(name): Path<String>, b: Bytes) -> Response {
    let mut ep = match s.engine.groups.resolve(&name) {
        Ok(ep) => ep,
        Err(e) => return ok(ProbeResult { message: e, ..Default::default() }),
    };
    if !b.is_empty() {
        if let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(&b) {
            if let Some(model) = m.get("model").and_then(Value::as_str).filter(|x| !x.is_empty()) {
                ep.model = model.into();
            }
        }
    }
    let res = Client::new(Duration::from_secs(20)).probe(&ep).await;
    s.log.log(&format!("测试分组 {}：HTTP {} {}ms", ep.group, res.status, res.latency_ms));
    ok(res)
}

/// 各分组已缓存的模型列表（不发起网络请求）。
async fn list_models(State(s): S) -> Response {
    match s.engine.groups.load() {
        Ok(f) => ok(json!({ "groups": s.models.views(&f), "filter": models::FILTER })),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// 用该分组自己的 baseUrl 与密钥请求 GET {effectiveBaseUrl}/models，筛选名称含 image 的模型并缓存。
async fn refresh_models(State(s): S, Path(name): Path<String>) -> Response {
    let f = match s.engine.groups.load() {
        Ok(f) => f,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let Some(g) = f.groups.get(&name) else {
        return err(StatusCode::NOT_FOUND, format!("接口分组不存在：{name:?}"));
    };
    let cur = models::current_of(&name, g);
    let (key, mut kerr) = match g.resolve_key() {
        Ok(k) => (k, None),
        Err(e) => (String::new(), Some(e)),
    };
    if let Err(e) = validate_base_url(&g.base_url) {
        kerr = Some(e);
    }
    let kerr = kerr.map(|e| format!("分组 {name}：{e}"));
    let res = s.models.refresh(&cur, &key, kerr).await;
    if res.ok {
        s.log.log(&format!("拉取分组 {name} 模型列表：{}", res.message));
    } else {
        s.log.log(&format!("拉取分组 {name} 模型列表失败：{}", res.message));
    }
    s.publish("models", serde_json::to_value(&res.cache).unwrap());
    ok(res)
}

async fn import_groups(State(s): S, b: Bytes) -> Response {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct In {
        #[serde(deserialize_with = "crate::util::null_default")]
        path: String,
        #[serde(deserialize_with = "crate::util::null_default")]
        json: String,
        #[serde(deserialize_with = "crate::util::null_default")]
        replace: bool,
    }
    let inp: In = match decode(&b) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let src = if !inp.json.trim().is_empty() {
        match serde_json::from_str::<config::File>(&inp.json) {
            Ok(f) => f,
            Err(e) => return err(StatusCode::BAD_REQUEST, format!("配置内容不是合法 JSON：{e}")),
        }
    } else {
        let p = if inp.path.is_empty() { codex_config_path().to_string_lossy().into_owned() } else { inp.path };
        match config::read_file(&p) {
            Ok(f) => f,
            Err(e) => return err(StatusCode::BAD_REQUEST, format!("读取配置失败：{e}")),
        }
    };
    if src.groups.is_empty() {
        return err(StatusCode::BAD_REQUEST, "配置中没有任何分组（groups 为空）");
    }
    match s.engine.groups.import(&src, inp.replace) {
        Ok(n) => {
            s.log.log(&format!("导入 {n} 个接口分组"));
            s.groups_changed();
            ok(json!({ "imported": n }))
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn export_groups(State(s): S, Query(q): Query<HashMap<String, String>>) -> Response {
    match s.engine.groups.export(q.get("includeKeys").map(String::as_str) == Some("1")) {
        Ok(f) => ok(f),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn export_groups_to_file(State(s): S, b: Bytes) -> Response {
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    struct In {
        #[serde(deserialize_with = "crate::util::null_default")]
        path: String,
        #[serde(deserialize_with = "crate::util::null_default")]
        include_keys: bool,
    }
    let inp: In = match decode(&b) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let path = if inp.path.is_empty() { codex_config_path() } else { crate::util::expand_home(&inp.path) };
    let res = s.engine.groups.export(inp.include_keys).and_then(|f| config::write_file(&path, &f).map(|_| f.groups.len()));
    match res {
        Ok(n) => ok(json!({ "path": if inp.path.is_empty() { path.to_string_lossy().into_owned() } else { inp.path }, "groups": n })),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, format!("导出失败：{e}")),
    }
}

async fn get_settings(State(s): S) -> Response {
    ok(s.engine.store.settings())
}

async fn put_settings(State(s): S, b: Bytes) -> Response {
    let p: SettingsPatch = match decode(&b) {
        Ok(v) => v,
        Err(r) => return r,
    };
    match s.engine.store.update_settings(p) {
        Ok(st) => {
            s.publish("settings", serde_json::to_value(&st).unwrap());
            ok(st)
        }
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

async fn submit(State(s): S, b: Bytes, mode: &'static str) -> Response {
    let mut req: GenRequest = match decode(&b) {
        Ok(v) => v,
        Err(r) => return r,
    };
    req.mode = mode.into();
    let engine = s.engine.clone();
    // 读取 / 解码参考图可能较慢，放到阻塞线程池
    let prepared = tokio::task::spawn_blocking(move || engine.prepare(req)).await.unwrap_or_else(|e| Err(e.to_string()));
    match prepared {
        Ok(p) => (StatusCode::ACCEPTED, Json(s.start_job(p))).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

/// 移动端 / 浏览器直接上传图片文件流（请求体即图片原始字节），保存为内核临时附件并返回本地路径，
/// 之后可在 /api/edit 的 images / mask 中以 {"path": ...} 引用。
async fn upload(State(s): S, Query(q): Query<HashMap<String, String>>, b: Bytes) -> Response {
    if b.is_empty() {
        return err(StatusCode::BAD_REQUEST, "上传内容为空");
    }
    let name = q.get("name").cloned().unwrap_or_default();
    let size = b.len();
    let engine = s.engine.clone();
    let res = tokio::task::spawn_blocking(move || engine.save_upload(&name, &b)).await.unwrap_or_else(|e| Err(e.to_string()));
    match res {
        Ok((name, path)) => ok(json!({ "path": path, "name": name, "size": size })),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

async fn list_jobs(State(s): S) -> Response {
    let mut out: Vec<Job> = s.jobs.lock().unwrap().values().map(Server::snapshot).collect();
    out.sort_by_key(|b| std::cmp::Reverse(b.created_at));
    ok(json!({ "jobs": out }))
}

async fn get_job(State(s): S, Path(id): Path<String>) -> Response {
    match s.jobs.lock().unwrap().get(&id).map(Server::snapshot) {
        Some(j) => ok(j),
        None => err(StatusCode::NOT_FOUND, "任务不存在"),
    }
}

async fn cancel_job(State(s): S, Path(id): Path<String>) -> Response {
    let jobs = s.jobs.lock().unwrap();
    match jobs.get(&id) {
        Some(e) => {
            if e.job.status == "running" {
                e.cancel.cancel();
            }
            ok(json!({ "ok": true }))
        }
        None => err(StatusCode::NOT_FOUND, "任务不存在"),
    }
}

async fn history(State(s): S, Query(q): Query<HashMap<String, String>>) -> Response {
    let g = |k: &str| q.get(k).cloned().unwrap_or_default();
    let (mut items, total) = s.engine.store.list(&HQuery {
        q: g("q"),
        mode: g("mode"),
        group: g("group"),
        limit: g("limit").parse().unwrap_or(0),
    });
    for it in items.iter_mut() {
        if std::fs::metadata(&it.path).is_err() {
            it.file_size = -1; // 文件已被移走或删除
        }
    }
    ok(json!({ "items": items, "total": total, "groups": s.engine.store.groups() }))
}

async fn history_item(State(s): S, Path(id): Path<String>) -> Response {
    match s.engine.store.get(&id) {
        Some(it) => ok(it),
        None => err(StatusCode::NOT_FOUND, "记录不存在"),
    }
}

async fn delete_history(State(s): S, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> Response {
    let del = q.get("deleteFile").map(String::as_str) == Some("1");
    match s.engine.store.delete(&id, del) {
        Ok(it) => {
            s.log.log(&format!("删除记录 {}（删除文件={}）", it.id, del));
            s.publish("history", json!({ "deleted": it.id }));
            ok(json!({ "ok": true }))
        }
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

fn mime_for(p: &FsPath) -> Option<&'static str> {
    match p.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// 只允许读取图片扩展名的常规文件（请求本身已经过 token 鉴权）。
fn allowed_file(p: Option<&String>) -> Option<PathBuf> {
    let p = PathBuf::from(p?);
    if !p.is_absolute() || mime_for(&p).is_none() || !std::fs::metadata(&p).ok()?.is_file() {
        return None;
    }
    Some(p)
}

async fn serve_file(p: &FsPath, mime: &'static str, cache: &'static str, download: bool) -> Response {
    let data = match tokio::fs::read(p).await {
        Ok(d) => d,
        Err(_) => return err(StatusCode::NOT_FOUND, "文件不存在或不是图片"),
    };
    let mut r = data.into_response();
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if download {
        let name = p.file_name().map(|s| s.to_string_lossy().replace('"', "")).unwrap_or_default();
        if let Ok(v) = HeaderValue::from_bytes(format!("attachment; filename=\"{name}\"").as_bytes()) {
            h.insert(header::CONTENT_DISPOSITION, v);
        }
    }
    r
}

async fn file(Query(q): Query<HashMap<String, String>>) -> Response {
    match allowed_file(q.get("path")) {
        Some(p) => serve_file(&p, mime_for(&p).unwrap(), "private, max-age=60", q.get("download").map(String::as_str) == Some("1")).await,
        None => err(StatusCode::NOT_FOUND, "文件不存在或不是图片"),
    }
}

async fn thumb(State(s): S, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(p) = allowed_file(q.get("path")) else {
        return err(StatusCode::NOT_FOUND, "文件不存在或不是图片");
    };
    let mut size: u32 = q.get("w").and_then(|w| w.parse().ok()).unwrap_or(0);
    if size == 0 {
        size = 384;
    }
    let cache = s.engine.home.join("thumbs");
    let src = p.clone();
    match tokio::task::spawn_blocking(move || crate::thumb::get(&cache, &src, size)).await {
        Ok(Ok(out)) => serve_file(&out, "image/jpeg", "private, max-age=86400", false).await,
        // 无法解码时回退原图
        _ => serve_file(&p, mime_for(&p).unwrap(), "private, max-age=60", false).await,
    }
}
