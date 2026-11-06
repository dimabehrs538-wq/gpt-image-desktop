//! 接口分组配置（兼容 ~/.codex/image-api-groups.json），与 Go `internal/config` 逐项对齐。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};

use crate::util::{expand_home, home_dir, now_ms, null_default, write_private};

pub const DEFAULT_MODEL: &str = "gpt-image-2";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct KeyRef {
    #[serde(default, deserialize_with = "null_default")]
    pub path: String,
    #[serde(default, deserialize_with = "null_default")]
    pub field: String,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Group {
    #[serde(default, deserialize_with = "null_default")]
    pub base_url: String,
    #[serde(default, deserialize_with = "null_default")]
    pub append_v1: bool,
    #[serde(default, deserialize_with = "null_default", skip_serializing_if = "String::is_empty")]
    pub api_key: String,
    #[serde(default, deserialize_with = "null_default", skip_serializing_if = "String::is_empty")]
    pub api_key_env: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_ref: Option<KeyRef>,
    #[serde(default, deserialize_with = "null_default")]
    pub model: String,
    #[serde(default, deserialize_with = "null_default", skip_serializing_if = "String::is_empty")]
    pub display_name: String,
    #[serde(default, deserialize_with = "null_default", skip_serializing_if = "String::is_empty")]
    pub note: String,
    #[serde(default, deserialize_with = "null_default", skip_serializing_if = "is_zero")]
    pub created_at: i64,
}

fn de_groups<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<String, Group>, D::Error> {
    let m = Option::<BTreeMap<String, Option<Group>>>::deserialize(d)?.unwrap_or_default();
    Ok(m.into_iter().filter_map(|(k, v)| v.map(|g| (k, g))).collect())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct File {
    #[serde(default, deserialize_with = "null_default")]
    pub default_group: String,
    #[serde(default, deserialize_with = "de_groups")]
    pub groups: BTreeMap<String, Group>,
    #[serde(default, deserialize_with = "null_default", skip_serializing_if = "String::is_empty")]
    pub imagegen_script: String,
    #[serde(default, deserialize_with = "null_default", skip_serializing_if = "String::is_empty")]
    pub python: String,
}

static NAME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$").unwrap());
static SK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(sk|ak|key)-[A-Za-z0-9_\-]{8,}").unwrap());
static BEARER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}").unwrap());

pub fn valid_name(n: &str) -> bool {
    NAME_RE.is_match(n)
}

/// 规范化最终请求前缀：去掉末尾 /；append_v1 开启或官方域名未带路径时补 /v1，已以 /v1 结尾则不重复。
pub fn effective_base_url(base: &str, append_v1: bool) -> String {
    let mut b = base.trim().trim_end_matches('/').to_string();
    if b.is_empty() {
        return b;
    }
    if !b.ends_with("/v1") {
        if append_v1 {
            b.push_str("/v1");
        } else if let Ok(u) = url::Url::parse(&b) {
            let official = u.host_str().is_some_and(|h| h.eq_ignore_ascii_case("api.openai.com"));
            if official && (u.path().is_empty() || u.path() == "/") {
                b.push_str("/v1");
            }
        }
    }
    b
}

pub fn validate_base_url(base: &str) -> Result<(), String> {
    match url::Url::parse(base.trim()) {
        Ok(u) if (u.scheme() == "http" || u.scheme() == "https") && u.host_str().is_some_and(|h| !h.is_empty()) => Ok(()),
        _ => Err("baseUrl 必须是 http:// 或 https:// 开头的完整地址".into()),
    }
}

/// 脱敏密钥，例如 sk-••••abcd。
pub fn mask_key(k: &str) -> String {
    let k = k.trim();
    if k.is_empty() {
        return String::new();
    }
    if k.len() <= 8 {
        return "••••".into();
    }
    let prefix = match k.find('-') {
        Some(i) if i > 0 && i <= 4 => &k[..=i],
        _ => "",
    };
    let chars: Vec<char> = k.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    format!("{prefix}••••{tail}")
}

/// 从任意文本中抹去密钥（精确匹配 + 常见 sk- / Bearer 形式）。
pub fn redact(s: &str, keys: &[&str]) -> String {
    let mut s = s.to_string();
    for k in keys {
        if k.len() >= 4 {
            s = s.replace(k, &mask_key(k));
        }
    }
    let s = SK_RE.replace_all(&s, |c: &regex::Captures| mask_key(&c[0]));
    BEARER_RE.replace_all(&s, "${1}••••").into_owned()
}

impl Group {
    pub fn key_source(&self) -> &'static str {
        if !self.api_key_env.is_empty() {
            "env"
        } else if !self.api_key.is_empty() {
            "literal"
        } else if self.api_key_ref.as_ref().is_some_and(|r| !r.path.is_empty()) {
            "ref"
        } else {
            "none"
        }
    }

    /// 按 api_key_env → api_key → api_key_ref 顺序解析密钥。错误信息不含密钥。
    pub fn resolve_key(&self) -> Result<String, String> {
        if !self.api_key_env.is_empty() {
            return match std::env::var(&self.api_key_env) {
                Ok(v) if !v.is_empty() => Ok(v),
                _ => Err(format!("环境变量 {} 为空，未能读取 API Key", self.api_key_env)),
            };
        }
        if !self.api_key.is_empty() {
            return Ok(self.api_key.clone());
        }
        let r = match &self.api_key_ref {
            Some(r) if !r.path.is_empty() => r,
            _ => return Err("该分组未配置 API Key（api_key / api_key_env / api_key_ref 均为空）".into()),
        };
        let raw = fs::read(expand_home(&r.path)).map_err(|e| format!("无法读取 api_key_ref 文件 {}：{}", r.path, e))?;
        let data: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|_| format!("api_key_ref 文件不是合法 JSON：{}", r.path))?;
        let mut cur = &data;
        for c in r.field.split('.') {
            cur = cur
                .as_object()
                .and_then(|m| m.get(c))
                .ok_or_else(|| format!("api_key_ref 字段不存在：{}", r.field))?;
        }
        match cur.as_str() {
            Some(s) if !s.is_empty() => Ok(s.to_string()),
            _ => Err(format!("api_key_ref 字段为空：{}", r.field)),
        }
    }

    pub fn view(&self, name: &str, is_default: bool) -> GroupView {
        let eff = effective_base_url(&self.base_url, self.append_v1);
        let mut v = GroupView {
            name: name.into(),
            display_name: self.display_name.clone(),
            note: self.note.clone(),
            base_url: self.base_url.clone(),
            append_v1: self.append_v1,
            model: if self.model.is_empty() { DEFAULT_MODEL.into() } else { self.model.clone() },
            key_source: self.key_source().into(),
            key_mask: String::new(),
            key_env: self.api_key_env.clone(),
            key_ref: self.api_key_ref.clone(),
            key_ok: false,
            key_error: String::new(),
            generations_url: format!("{eff}/images/generations"),
            edits_url: format!("{eff}/images/edits"),
            effective_base_url: eff,
            is_default,
            created_at: self.created_at,
        };
        match self.resolve_key() {
            Ok(k) => {
                v.key_ok = true;
                v.key_mask = mask_key(&k);
            }
            Err(e) => v.key_error = e,
        }
        v
    }
}

/// 对外展示的分组（密钥已脱敏）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    pub name: String,
    pub display_name: String,
    pub note: String,
    pub base_url: String,
    #[serde(rename = "appendV1")]
    pub append_v1: bool,
    pub model: String,
    pub key_source: String,
    pub key_mask: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub key_env: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<KeyRef>,
    pub key_ok: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub key_error: String,
    pub effective_base_url: String,
    pub generations_url: String,
    pub edits_url: String,
    pub is_default: bool,
    pub created_at: i64,
}

/// 解析后的请求端点（含明文密钥，仅在内存中使用）。
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub group: String,
    pub base_url: String,
    pub key: String,
    pub model: String,
}

/// 创建 / 更新分组的入参。apiKey 为空表示保持原密钥。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Input {
    #[serde(deserialize_with = "null_default")]
    pub name: String,
    #[serde(deserialize_with = "null_default")]
    pub new_name: String,
    #[serde(deserialize_with = "null_default")]
    pub display_name: String,
    #[serde(deserialize_with = "null_default")]
    pub note: String,
    #[serde(deserialize_with = "null_default")]
    pub base_url: String,
    #[serde(rename = "appendV1", deserialize_with = "null_default")]
    pub append_v1: bool,
    #[serde(deserialize_with = "null_default")]
    pub model: String,
    #[serde(deserialize_with = "null_default")]
    pub key_source: String,
    #[serde(deserialize_with = "null_default")]
    pub api_key: String,
    #[serde(deserialize_with = "null_default")]
    pub api_key_env: String,
    pub api_key_ref: Option<KeyRef>,
    #[serde(deserialize_with = "null_default")]
    pub make_default: bool,
}

fn apply_input(g: &mut Group, inp: &Input, creating: bool) -> Result<(), String> {
    validate_base_url(&inp.base_url)?;
    g.base_url = inp.base_url.trim().into();
    g.append_v1 = inp.append_v1;
    g.model = inp.model.trim().into();
    if g.model.is_empty() {
        g.model = DEFAULT_MODEL.into();
    }
    g.display_name = inp.display_name.trim().into();
    g.note = inp.note.trim().into();
    let src = if inp.key_source.is_empty() { "literal" } else { inp.key_source.as_str() };
    match src {
        "literal" => {
            let k = inp.api_key.trim();
            if k.is_empty() && (creating || g.api_key.is_empty()) {
                return Err("请填写 API Key".into());
            }
            if !k.is_empty() {
                g.api_key = k.into();
            }
            g.api_key_env.clear();
            g.api_key_ref = None;
        }
        "env" => {
            if inp.api_key_env.trim().is_empty() {
                return Err("请填写保存 API Key 的环境变量名".into());
            }
            g.api_key_env = inp.api_key_env.trim().into();
            g.api_key.clear();
            g.api_key_ref = None;
        }
        "ref" => match &inp.api_key_ref {
            Some(r) if !r.path.is_empty() && !r.field.is_empty() => {
                g.api_key_ref = Some(r.clone());
                g.api_key.clear();
                g.api_key_env.clear();
            }
            _ => return Err("请填写 api_key_ref 的文件路径与字段".into()),
        },
        other => return Err(format!("未知的密钥来源：{other}")),
    }
    Ok(())
}

pub fn read_file(path: &str) -> Result<File, String> {
    let raw = fs::read(expand_home(path)).map_err(|e| e.to_string())?;
    serde_json::from_slice::<File>(&raw).map_err(|e| format!("配置文件不是合法 JSON：{e}"))
}

/// 原子写入配置文件，权限 0600。
pub fn write_file(path: &Path, f: &File) -> Result<(), String> {
    let mut raw = serde_json::to_vec_pretty(f).map_err(|e| e.to_string())?;
    raw.push(b'\n');
    write_private(path, &raw).map_err(|e| e.to_string())
}

pub fn sorted_names(f: &File) -> Vec<String> {
    let mut names: Vec<&String> = f.groups.keys().collect();
    names.sort_by(|a, b| {
        let (ga, gb) = (&f.groups[*a], &f.groups[*b]);
        ga.created_at.cmp(&gb.created_at).then_with(|| a.cmp(b))
    });
    names.into_iter().cloned().collect()
}

/// $CODEX_HOME/image-api-groups.json（默认 ~/.codex）。
pub fn codex_config_path() -> PathBuf {
    let dir = match std::env::var("CODEX_HOME") {
        Ok(d) if !d.is_empty() => expand_home(&d),
        _ => home_dir().unwrap_or_default().join(".codex"),
    };
    dir.join("image-api-groups.json")
}

/// 线程安全的分组存储（每次操作都从磁盘重新读取）。
pub struct Store {
    mu: Mutex<()>,
    path: PathBuf,
}

impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self { mu: Mutex::new(()), path }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn load_unlocked(&self) -> Result<File, String> {
        match fs::read(&self.path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(File::default()),
            Err(e) => Err(e.to_string()),
            Ok(raw) => serde_json::from_slice(&raw).map_err(|e| format!("配置文件不是合法 JSON：{e}")),
        }
    }

    pub fn load(&self) -> Result<File, String> {
        let _g = self.mu.lock().unwrap();
        self.load_unlocked()
    }

    pub fn update<F: FnOnce(&mut File) -> Result<(), String>>(&self, f: F) -> Result<(), String> {
        let _g = self.mu.lock().unwrap();
        let mut file = self.load_unlocked()?;
        f(&mut file)?;
        if file.default_group.is_empty() || !file.groups.contains_key(&file.default_group) {
            file.default_group = sorted_names(&file).into_iter().next().unwrap_or_default();
        }
        write_file(&self.path, &file)
    }

    pub fn views(&self) -> Result<(String, Vec<GroupView>), String> {
        let f = self.load()?;
        let out = sorted_names(&f)
            .iter()
            .map(|n| f.groups[n].view(n, *n == f.default_group))
            .collect();
        Ok((f.default_group, out))
    }

    /// 解析指定分组（为空则用默认分组）。严格不回退到其它分组。
    pub fn resolve(&self, name: &str) -> Result<Endpoint, String> {
        let f = self.load()?;
        let mut name = name.to_string();
        if name.is_empty() {
            name = std::env::var("IMAGE_API_GROUP").unwrap_or_default();
        }
        if name.is_empty() {
            name = f.default_group.clone();
        }
        let g = match f.groups.get(&name) {
            Some(g) if !name.is_empty() => g,
            _ => return Err(format!("接口分组不存在：{name:?}，请先在「接口配置」中创建")),
        };
        validate_base_url(&g.base_url).map_err(|e| format!("分组 {name}：{e}"))?;
        let key = g.resolve_key().map_err(|e| format!("分组 {name}：{e}"))?;
        let model = if g.model.is_empty() { DEFAULT_MODEL.to_string() } else { g.model.clone() };
        Ok(Endpoint { base_url: effective_base_url(&g.base_url, g.append_v1), group: name, key, model })
    }

    pub fn create(&self, mut inp: Input) -> Result<(), String> {
        inp.name = inp.name.trim().into();
        if !valid_name(&inp.name) {
            return Err("分组标识只能包含字母、数字、. _ -，且以字母或数字开头（最长 64）".into());
        }
        self.update(|f| {
            if f.groups.contains_key(&inp.name) {
                return Err(format!("分组 {} 已存在", inp.name));
            }
            let mut g = Group { created_at: now_ms(), ..Default::default() };
            apply_input(&mut g, &inp, true)?;
            f.groups.insert(inp.name.clone(), g);
            if inp.make_default || f.groups.len() == 1 {
                f.default_group = inp.name.clone();
            }
            Ok(())
        })
    }

    pub fn modify(&self, name: &str, inp: Input) -> Result<(), String> {
        self.update(|f| {
            let mut cp = f.groups.get(name).cloned().ok_or_else(|| format!("分组不存在：{name}"))?;
            apply_input(&mut cp, &inp, false)?;
            let mut target = name.to_string();
            let nn = inp.new_name.trim();
            if !nn.is_empty() && nn != name {
                if !valid_name(nn) {
                    return Err("新的分组标识不合法".into());
                }
                if f.groups.contains_key(nn) {
                    return Err(format!("分组 {nn} 已存在"));
                }
                f.groups.remove(name);
                if f.default_group == name {
                    f.default_group = nn.into();
                }
                target = nn.into();
            }
            f.groups.insert(target.clone(), cp);
            if inp.make_default {
                f.default_group = target;
            }
            Ok(())
        })
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        self.update(|f| {
            if f.groups.remove(name).is_none() {
                return Err(format!("分组不存在：{name}"));
            }
            if f.default_group == name {
                f.default_group.clear();
            }
            Ok(())
        })
    }

    pub fn set_default(&self, name: &str) -> Result<(), String> {
        self.update(|f| {
            if !f.groups.contains_key(name) {
                return Err(format!("分组不存在：{name}"));
            }
            f.default_group = name.into();
            Ok(())
        })
    }

    /// 从外部配置合并（merge）或替换（replace）。返回导入的分组数。
    pub fn import(&self, src: &File, replace: bool) -> Result<usize, String> {
        let mut n = 0usize;
        self.update(|f| {
            if replace {
                f.groups.clear();
                f.default_group.clear();
            }
            let now = now_ms();
            for name in sorted_names(src) {
                if !valid_name(&name) {
                    continue;
                }
                let mut cp = src.groups[&name].clone();
                if cp.created_at == 0 {
                    cp.created_at = now + n as i64;
                }
                if cp.model.is_empty() {
                    cp.model = DEFAULT_MODEL.into();
                }
                f.groups.insert(name, cp);
                n += 1;
            }
            if !src.default_group.is_empty()
                && f.groups.contains_key(&src.default_group)
                && (replace || f.default_group.is_empty())
            {
                f.default_group = src.default_group.clone();
            }
            if !src.imagegen_script.is_empty() {
                f.imagegen_script = src.imagegen_script.clone();
            }
            if !src.python.is_empty() {
                f.python = src.python.clone();
            }
            Ok(())
        })?;
        Ok(n)
    }

    /// 导出为技能兼容格式。include_keys=false 时去掉明文 api_key（env / ref 引用保留）。
    pub fn export(&self, include_keys: bool) -> Result<File, String> {
        let mut f = self.load()?;
        if !include_keys {
            for g in f.groups.values_mut() {
                g.api_key.clear();
            }
        }
        Ok(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url() {
        assert_eq!(effective_base_url("https://api.openai.com/", false), "https://api.openai.com/v1");
        assert_eq!(effective_base_url("https://x.com/api/", true), "https://x.com/api/v1");
        assert_eq!(effective_base_url("https://x.com/v1/", true), "https://x.com/v1");
        assert_eq!(effective_base_url("https://x.com", false), "https://x.com");
        assert!(validate_base_url("ftp://x").is_err());
        assert!(validate_base_url("http://").is_err());
        assert!(validate_base_url(" https://a.b ").is_ok());
    }

    #[test]
    fn mask_and_redact() {
        assert_eq!(mask_key("sk-abcdefgh1234"), "sk-••••1234");
        assert_eq!(mask_key("short"), "••••");
        assert_eq!(mask_key("abcdefghijkl"), "••••ijkl");
        let r = redact("bad key sk-SECRETSECRET99 and Bearer abcdefghijk", &["sk-SECRETSECRET99"]);
        assert!(!r.contains("SECRETSECRET99") && !r.contains("abcdefghijk"), "{r}");
    }

    #[test]
    fn store_flow() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().join("groups.json"));
        let inp = |name: &str, key: &str| Input {
            name: name.into(),
            base_url: "https://api.openai.com".into(),
            api_key: key.into(),
            ..Default::default()
        };
        assert!(s.create(inp("bad name", "sk-x")).is_err());
        s.create(inp("a", "sk-aaaaaaaaaaaa")).unwrap();
        s.create(inp("b", "sk-bbbbbbbbbbbb")).unwrap();
        assert!(s.create(inp("a", "k")).is_err());
        let (def, v) = s.views().unwrap();
        assert_eq!(def, "a");
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].effective_base_url, "https://api.openai.com/v1");
        assert_eq!(v[0].key_mask, "sk-••••aaaa");
        // 空密钥保持原值，可重命名
        s.modify("a", Input { new_name: "a2".into(), ..inp("a", "") }).unwrap();
        assert_eq!(s.resolve("").unwrap().key, "sk-aaaaaaaaaaaa");
        assert_eq!(s.resolve("").unwrap().group, "a2");
        assert!(s.resolve("zzz").unwrap_err().contains("\"zzz\""));
        s.delete("a2").unwrap();
        assert_eq!(s.views().unwrap().0, "b");
        let exp = s.export(false).unwrap();
        assert!(exp.groups["b"].api_key.is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(s.path()).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // 兼容技能配置：null 值、api_key_env、api_key_ref
        let src: File = serde_json::from_str(r#"{"default_group":"r","groups":{"e":{"base_url":"https://x.com","api_key_env":"NOPE_ENV_X","model":null},"r":{"base_url":"https://y.com","api_key_ref":{"path":"/nonexistent.json","field":"a.b"}},"n":null}}"#).unwrap();
        assert_eq!(s.import(&src, true).unwrap(), 2);
        let (def, v) = s.views().unwrap();
        assert_eq!(def, "r");
        assert!(v.iter().all(|g| !g.key_ok && g.model == DEFAULT_MODEL));
    }
}
