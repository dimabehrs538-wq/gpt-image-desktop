//! 拉取并缓存各接口分组的模型列表（GET {effectiveBaseUrl}/models），对齐 Go `internal/models`。
//!
//! 只保留模型 ID 中（不区分大小写）包含 "image" 的条目：这是**名称匹配**，不是能力检测，
//! 不会调用任何付费生图接口去探测。缓存按分组隔离，并记录 baseUrl + 密钥指纹，端点或密钥变化后
//! 旧列表不会被复用。缓存文件 models.json 以 0600 写入，不含任何密钥。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{effective_base_url, redact, File as ConfigFile, Group};
use crate::imageapi::parse_error;
use crate::util::{now_ms, write_private};

pub const FILTER: &str = "image";
pub const TIMEOUT: Duration = Duration::from_secs(20);
pub const DEDUPE_MS: i64 = 3000;
const UA: &str = "GPTImageStudio/1.0";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Entry {
    pub fingerprint: String,
    pub effective_base_url: String,
    pub models: Vec<String>,
    /// 接口返回的不同模型 ID 数（空 id 忽略、重复 id 去重后计数），不是原始 data 数组长度
    pub total: usize,
    pub fetched_at: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub error: String,
    #[serde(skip_serializing_if = "is_zero_u16")]
    pub error_status: u16,
    #[serde(skip_serializing_if = "is_zero_i64")]
    pub error_at: i64,
}

fn is_zero_u16(n: &u16) -> bool {
    *n == 0
}
fn is_zero_i64(n: &i64) -> bool {
    *n == 0
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct CacheFile {
    version: u32,
    groups: BTreeMap<String, Entry>,
}

/// 对外视图（字段固定，与 Go 内核一致）。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub group: String,
    pub models: Vec<String>,
    pub total: usize,
    pub fetched_at: i64,
    pub effective_base_url: String,
    pub stale: bool,
    pub error: String,
    pub error_status: u16,
    pub error_at: i64,
    pub filter: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefreshResult {
    pub ok: bool,
    pub message: String,
    pub cache: View,
}

/// 由最终请求前缀与密钥计算的截断 SHA-1（不可逆，仅用于判断端点是否变化）。
pub fn fingerprint(eff: &str, key: &str) -> String {
    if eff.is_empty() || key.is_empty() {
        return String::new();
    }
    let d = sha1_smol::Sha1::from(format!("{eff}\n{key}").as_bytes()).digest().bytes();
    d[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// 解析标准 OpenAI 模型列表 {"data":[{"id":"..."}]}，返回去重后的全部 ID。
pub fn parse_list(raw: &[u8]) -> Result<Vec<String>, String> {
    let Ok(Value::Object(top)) = serde_json::from_slice::<Value>(raw) else {
        return Err("响应不是标准的模型列表 JSON".into());
    };
    let Some(data) = top.get("data") else {
        return Err("响应不是标准的模型列表（缺少 data 数组）".into());
    };
    let Value::Array(data) = data else {
        return Err("响应不是标准的模型列表（data 不是数组）".into());
    };
    let mut seen = HashSet::new();
    let mut ids = vec![];
    for d in data {
        let Some(id) = d.get("id").and_then(Value::as_str) else { continue };
        let id = id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        ids.push(id.to_string());
    }
    if !data.is_empty() && ids.is_empty() {
        return Err("模型列表格式不正确（data 中没有字符串 id）".into());
    }
    Ok(ids)
}

/// 筛选名称包含 image 的模型（不区分大小写），去重并按名称排序（不区分大小写，相同再按原文）。
pub fn filter_image(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out: Vec<String> = ids
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.to_lowercase().contains(FILTER) && seen.insert(s.clone()))
        .collect();
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
    out
}

/// 分组当前端点。
#[derive(Debug, Clone, Default)]
pub struct Current {
    pub name: String,
    pub effective_base_url: String,
    /// 密钥解析失败时为空
    pub fingerprint: String,
}

pub fn current_of(name: &str, g: &Group) -> Current {
    let eff = effective_base_url(&g.base_url, g.append_v1);
    let fp = g.resolve_key().map(|k| fingerprint(&eff, &k)).unwrap_or_default();
    Current { name: name.into(), effective_base_url: eff, fingerprint: fp }
}

/// 端点或密钥变化（指纹不一致）时 stale=true 且不返回旧列表。
pub fn view_of(cur: &Current, e: Option<&Entry>) -> View {
    let mut v = View {
        group: cur.name.clone(),
        effective_base_url: cur.effective_base_url.clone(),
        filter: FILTER.into(),
        ..Default::default()
    };
    let Some(e) = e else { return v };
    if e.fingerprint.is_empty() || e.fingerprint != cur.fingerprint {
        v.stale = e.fetched_at > 0 || !e.error.is_empty();
        return v;
    }
    v.models = e.models.clone();
    v.total = e.total;
    v.fetched_at = e.fetched_at;
    v.error = e.error.clone();
    v.error_status = e.error_status;
    v.error_at = e.error_at;
    v
}

fn summary(e: &Entry) -> String {
    if e.total == 0 {
        "接口返回的模型列表为空，可直接手动输入模型名".into()
    } else if e.models.is_empty() {
        format!("接口返回 {} 个不同模型（已去重），但名称都不含 image，可直接手动输入模型名", e.total)
    } else {
        format!("接口返回 {} 个不同模型（已去重），其中 {} 个名称包含 image", e.total, e.models.len())
    }
}

pub struct Cache {
    path: PathBuf,
    file: Mutex<()>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    http: reqwest::Client,
}

impl Cache {
    pub fn new(path: PathBuf) -> Self {
        Self::with_timeout(path, TIMEOUT)
    }

    pub fn with_timeout(path: PathBuf, timeout: Duration) -> Self {
        let http = reqwest::Client::builder().timeout(timeout).user_agent(UA).build().unwrap_or_default();
        Self { path, file: Mutex::new(()), locks: Mutex::new(HashMap::new()), http }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn load(&self) -> CacheFile {
        std::fs::read(&self.path).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default()
    }

    fn save(&self, mut f: CacheFile) -> Result<(), String> {
        f.version = 1;
        let raw = serde_json::to_vec_pretty(&f).map_err(|e| e.to_string())?;
        write_private(&self.path, &raw).map_err(|e| e.to_string())
    }

    fn get(&self, name: &str) -> Option<Entry> {
        let _g = self.file.lock().unwrap();
        self.load().groups.get(name).cloned()
    }

    fn put(&self, name: &str, e: Entry) -> Result<(), String> {
        let _g = self.file.lock().unwrap();
        let mut f = self.load();
        f.groups.insert(name.into(), e);
        self.save(f)
    }

    /// 分组改名时迁移缓存。
    pub fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        let _g = self.file.lock().unwrap();
        let mut f = self.load();
        let Some(e) = f.groups.remove(from) else { return Ok(()) };
        f.groups.insert(to.into(), e);
        self.save(f)
    }

    /// 删除分组时清除缓存。
    pub fn remove(&self, name: &str) -> Result<(), String> {
        let _g = self.file.lock().unwrap();
        let mut f = self.load();
        if f.groups.remove(name).is_none() {
            return Ok(());
        }
        self.save(f)
    }

    /// 全部现存分组的视图。
    pub fn views(&self, cfg: &ConfigFile) -> BTreeMap<String, View> {
        let f = {
            let _g = self.file.lock().unwrap();
            self.load()
        };
        cfg.groups.iter().map(|(n, g)| (n.clone(), view_of(&current_of(n, g), f.groups.get(n)))).collect()
    }

    pub fn view(&self, cur: &Current) -> View {
        view_of(cur, self.get(&cur.name).as_ref())
    }

    /// 拉取分组模型列表并保存；失败时保留上次成功的列表（端点未变化时）并记录错误，绝不切换到其它分组。
    pub async fn refresh(&self, cur: &Current, key: &str, key_err: Option<String>) -> RefreshResult {
        let lock = self.locks.lock().unwrap().entry(cur.name.clone()).or_default().clone();
        let _guard = lock.lock().await;
        let now = now_ms();
        let old = self.get(&cur.name);
        let same = old.as_ref().is_some_and(|o| !o.fingerprint.is_empty() && o.fingerprint == cur.fingerprint);
        let fail = |status: u16, msg: String| {
            let mut e = if same {
                old.clone().unwrap()
            } else {
                Entry { fingerprint: cur.fingerprint.clone(), effective_base_url: cur.effective_base_url.clone(), ..Default::default() }
            };
            e.error = msg.clone();
            e.error_status = status;
            e.error_at = now;
            let _ = self.put(&cur.name, e.clone());
            RefreshResult { ok: false, message: msg, cache: view_of(cur, Some(&e)) }
        };
        if let Some(e) = key_err {
            return fail(0, e);
        }
        if let Some(o) = old.as_ref().filter(|o| same && o.error.is_empty() && o.fetched_at > 0 && now - o.fetched_at < DEDUPE_MS) {
            return RefreshResult { ok: true, message: summary(o), cache: view_of(cur, Some(o)) };
        }
        let url = format!("{}/models", cur.effective_base_url);
        let resp = match self.http.get(&url).bearer_auth(key).header("Accept", "application/json").send().await {
            Ok(r) => r,
            Err(e) if e.is_timeout() => return fail(0, format!("拉取模型列表超时（{} 秒）", TIMEOUT.as_secs())),
            Err(e) if e.is_builder() => return fail(0, format!("请求地址不正确：{}", redact(&e.to_string(), &[key]))),
            Err(e) => {
                let mut s = e.to_string();
                let mut src = std::error::Error::source(&e);
                while let Some(c) = src {
                    s.push_str(": ");
                    s.push_str(&c.to_string());
                    src = c.source();
                }
                return fail(0, format!("无法连接：{}", redact(&s, &[key])));
            }
        };
        let status = resp.status().as_u16();
        let raw = match resp.bytes().await {
            Ok(b) if b.len() <= 8 << 20 => b,
            Ok(_) => return fail(status, "读取响应失败：响应过大".into()),
            Err(e) if e.is_timeout() => return fail(0, format!("拉取模型列表超时（{} 秒）", TIMEOUT.as_secs())),
            Err(e) => return fail(status, format!("读取响应失败：{}", redact(&e.to_string(), &[key]))),
        };
        if !(200..300).contains(&status) {
            let mut msg = parse_error(status, &raw, key).to_string();
            if status == 404 || status == 405 {
                msg.push_str("（该接口可能不支持 GET /models，可直接手动输入模型名）");
            }
            return fail(status, msg);
        }
        let ids = match parse_list(&raw) {
            Ok(v) => v,
            Err(e) => return fail(status, format!("{e}，可直接手动输入模型名")),
        };
        let e = Entry {
            fingerprint: cur.fingerprint.clone(),
            effective_base_url: cur.effective_base_url.clone(),
            models: filter_image(&ids),
            total: ids.len(),
            fetched_at: now,
            ..Default::default()
        };
        if let Err(err) = self.put(&cur.name, e.clone()) {
            return RefreshResult { ok: false, message: format!("保存模型缓存失败：{err}"), cache: view_of(cur, Some(&e)) };
        }
        RefreshResult { ok: true, message: summary(&e), cache: view_of(cur, Some(&e)) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const KEY_A: &str = "sk-groupA-SECRET-1111aaaa";
    const KEY_B: &str = "sk-groupB-SECRET-2222bbbb";

    #[test]
    fn parse_and_filter() {
        let ids = parse_list(br#"{"object":"list","data":[{"id":"gpt-image-1"},{"id":"dall-e-3"},{"id":"GPT-Image-2"},{"id":"gpt-image-1"},{"id":" chatgpt-image-latest "},{"id":42},{"name":"x"},{"id":""},"str",{"id":"text-embedding-3-small"},{"id":"Imagen-4"}]}"#).unwrap();
        assert_eq!(ids.len(), 6, "{ids:?}");
        let mut all = ids.clone();
        all.extend(["gpt-image-1", "IMAGE-x", "image-x"].map(String::from));
        assert_eq!(filter_image(&all), ["chatgpt-image-latest", "gpt-image-1", "GPT-Image-2", "IMAGE-x", "image-x", "Imagen-4"]);
        for bad in ["", "null", "[]", r#"{"models":["gpt-image-1"]}"#, r#"{"data":{"id":"x"}}"#, r#"{"data":null}"#, "<html>502</html>", r#"{"data":[1,2]}"#] {
            assert!(parse_list(bad.as_bytes()).is_err(), "{bad}");
        }
        assert!(parse_list(br#"{"data":[]}"#).unwrap().is_empty());
    }

    #[test]
    fn fingerprint_changes() {
        let a = fingerprint("https://a.com/v1", KEY_A);
        assert_eq!(a.len(), 16);
        assert_ne!(a, fingerprint("https://b.com/v1", KEY_A));
        assert_ne!(a, fingerprint("https://a.com/v1", KEY_B));
        assert_eq!(fingerprint("https://a.com/v1", ""), "");
        // 与 Go 内核相同算法（sha1 前 8 字节）
        assert_eq!(fingerprint("https://x/v1", "k"), {
            let d = sha1_smol::Sha1::from("https://x/v1\nk").digest().bytes();
            d[..8].iter().map(|b| format!("{b:02x}")).collect::<String>()
        });
    }

    /// 极简 HTTP 上游：按路径前缀与 Authorization 返回不同内容。
    fn upstream(mode: Arc<Mutex<&'static str>>, hits: Arc<AtomicUsize>) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                let mode = mode.clone();
                let hits = hits.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 4096];
                    let n = s.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    hits.fetch_add(1, Ordering::SeqCst);
                    let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                    let auth = req.lines().find_map(|l| l.strip_prefix("authorization: ").or_else(|| l.strip_prefix("Authorization: "))).unwrap_or("").trim().to_string();
                    let want = if path.starts_with("/a/") { KEY_A } else { KEY_B };
                    let m = *mode.lock().unwrap();
                    let (code, body) = if auth != format!("Bearer {want}") {
                        (401, format!(r#"{{"error":{{"message":"Incorrect API key provided: {}","code":"invalid_api_key"}}}}"#, auth.trim_start_matches("Bearer ")))
                    } else {
                        match m {
                            "500" => (500, "upstream exploded".to_string()),
                            "html" => (200, "<html>not json</html>".to_string()),
                            "nomodels" => (404, r#"{"error":{"message":"Invalid URL (GET /v1/models)"}}"#.to_string()),
                            "slow" => {
                                std::thread::sleep(Duration::from_millis(400));
                                (200, r#"{"data":[]}"#.to_string())
                            }
                            _ if path.starts_with("/a/") => (200, r#"{"data":[{"id":"gpt-image-1"},{"id":"gpt-4o"},{"id":"gpt-image-1"},{"id":"dall-e-3"}]}"#.to_string()),
                            _ => (200, r#"{"data":[{"id":"flux-image-pro"},{"id":"seedream-image-3"}]}"#.to_string()),
                        }
                    };
                    let _ = write!(s, "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                });
            }
        });
        format!("http://{addr}")
    }

    fn cur(name: &str, base: &str, key: &str) -> Current {
        Current { name: name.into(), effective_base_url: base.into(), fingerprint: fingerprint(base, key) }
    }

    #[tokio::test]
    async fn refresh_isolation_persistence_errors() {
        let mode = Arc::new(Mutex::new("ok"));
        let hits = Arc::new(AtomicUsize::new(0));
        let up = upstream(mode.clone(), hits.clone());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models.json");
        let c = Cache::new(path.clone());
        let (ca, cb) = (cur("A", &format!("{up}/a/v1"), KEY_A), cur("B", &format!("{up}/b/v1"), KEY_B));

        let r = c.refresh(&ca, KEY_A, None).await;
        assert!(r.ok, "{r:?}");
        assert_eq!(r.cache.models, ["gpt-image-1"]);
        assert_eq!(r.cache.total, 3);
        let r = c.refresh(&cb, KEY_B, None).await;
        assert_eq!(r.cache.models, ["flux-image-pro", "seedream-image-3"]);
        let n = hits.load(Ordering::SeqCst);
        assert!(c.refresh(&ca, KEY_A, None).await.ok);
        assert_eq!(hits.load(Ordering::SeqCst), n, "3 秒内重复刷新不应再请求上游");

        // 重启后可用、不含密钥、0600
        let c2 = Cache::new(path.clone());
        let v = c2.view(&ca);
        assert_eq!(v.models, ["gpt-image-1"]);
        assert!(!v.stale && v.fetched_at > 0);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("SECRET"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }

        // 失败保留旧缓存
        for m in ["500", "html", "nomodels"] {
            *mode.lock().unwrap() = m;
            let mut e = c2.get("A").unwrap();
            e.fetched_at -= 10_000;
            c2.put("A", e).unwrap();
            let r = c2.refresh(&ca, KEY_A, None).await;
            assert!(!r.ok && !r.message.is_empty() && !r.cache.error.is_empty() && r.cache.error_at > 0, "{m}: {r:?}");
            assert_eq!(r.cache.models, ["gpt-image-1"], "{m}");
            if m == "nomodels" {
                assert!(r.message.contains("不支持 GET /models") && r.cache.error_status == 404);
            }
            if m == "html" {
                assert!(r.message.contains("手动输入"));
            }
        }
        *mode.lock().unwrap() = "ok";

        // 401 脱敏
        let wrong = "sk-wrong-SECRET-9999zzzz";
        let r = c.refresh(&cur("W", &format!("{up}/a/v1"), wrong), wrong, None).await;
        assert!(!r.ok && r.cache.error_status == 401 && !r.message.contains(wrong) && r.cache.models.is_empty(), "{r:?}");

        // 端点 / 密钥变化
        let moved = cur("A", &format!("{up}/b/v1"), KEY_A);
        let v = c.view(&moved);
        assert!(v.stale && v.models.is_empty());
        let r = c.refresh(&moved, KEY_A, None).await;
        assert!(!r.ok && r.cache.models.is_empty() && !r.cache.stale);
        assert!(c.view(&cur("B", &format!("{up}/b/v1"), "sk-other-key-000000")).stale);

        // 密钥解析失败不发请求
        let n = hits.load(Ordering::SeqCst);
        let r = c.refresh(&Current { name: "E".into(), effective_base_url: format!("{up}/a/v1"), fingerprint: String::new() }, "", Some("环境变量 X 为空".into())).await;
        assert!(!r.ok);
        assert_eq!(hits.load(Ordering::SeqCst), n);

        // 改名 / 删除
        c.rename("B", "B2").unwrap();
        assert_eq!(c.view(&cur("B2", &format!("{up}/b/v1"), KEY_B)).models.len(), 2);
        assert!(c.view(&cb).models.is_empty());
        c.remove("B2").unwrap();
        assert_eq!(c.view(&cur("B2", &format!("{up}/b/v1"), KEY_B)).fetched_at, 0);

        // 空列表
        *mode.lock().unwrap() = "slow";
        let r = c.refresh(&cur("S", &format!("{up}/a/v1"), KEY_A), KEY_A, None).await;
        assert!(r.ok && r.cache.total == 0 && r.message.contains("为空"), "{r:?}");

        // 超时
        let ct = Cache::with_timeout(dir.path().join("t.json"), Duration::from_millis(80));
        let r = ct.refresh(&cur("T", &format!("{up}/a/v1"), KEY_A), KEY_A, None).await;
        assert!(!r.ok && r.message.contains("超时"), "{r:?}");
    }
}
