//! 系统设置与作品历史（JSON 文件，原子写入，0600），对齐 Go `internal/store`。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::util::{file_name, null_default, write_private};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    #[serde(deserialize_with = "null_default")]
    pub output_dir: String,
    #[serde(deserialize_with = "null_default")]
    pub request_timeout_sec: i64,
    #[serde(deserialize_with = "null_default")]
    pub filename_prefix: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub output_dir: Option<String>,
    pub request_timeout_sec: Option<i64>,
    pub filename_prefix: Option<String>,
}

fn is_zero_u(n: &u32) -> bool {
    *n == 0
}

/// 一张生成结果的历史记录（字段与 Go store.Item 的 JSON 完全一致）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    pub id: String,
    pub job_id: String,
    pub created_at: i64,
    pub mode: String,
    pub group: String,
    pub base_url: String,
    pub model: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "String::is_empty", deserialize_with = "null_default")]
    pub revised_prompt: String,
    #[serde(skip_serializing_if = "String::is_empty", deserialize_with = "null_default")]
    pub size: String,
    #[serde(skip_serializing_if = "String::is_empty", deserialize_with = "null_default")]
    pub quality: String,
    #[serde(skip_serializing_if = "String::is_empty", deserialize_with = "null_default")]
    pub background: String,
    #[serde(skip_serializing_if = "String::is_empty", deserialize_with = "null_default")]
    pub output_format: String,
    pub n: i64,
    pub index: i64,
    pub path: String,
    pub file_size: i64,
    #[serde(skip_serializing_if = "is_zero_u")]
    pub width: u32,
    #[serde(skip_serializing_if = "is_zero_u")]
    pub height: u32,
    pub elapsed_ms: i64,
    #[serde(skip_serializing_if = "String::is_empty", deserialize_with = "null_default")]
    pub source_url: String,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_default")]
    pub input_images: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty", deserialize_with = "null_default")]
    pub mask: String,
}

#[derive(Debug, Clone, Default)]
pub struct Query {
    pub q: String,
    pub mode: String,
    pub group: String,
    pub limit: usize,
}

pub struct Store {
    mu: Mutex<()>,
    dir: PathBuf,
    default_out: PathBuf,
}

fn write_json<T: Serialize>(path: &Path, v: &T) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    write_private(path, &raw).map_err(|e| e.to_string())
}

impl Store {
    pub fn new(dir: PathBuf, default_out: PathBuf) -> Self {
        Self { mu: Mutex::new(()), dir, default_out }
    }

    fn settings_unlocked(&self) -> Settings {
        let mut st: Settings = fs::read(self.dir.join("settings.json"))
            .ok()
            .and_then(|r| serde_json::from_slice(&r).ok())
            .unwrap_or_default();
        if st.output_dir.is_empty() {
            st.output_dir = self.default_out.to_string_lossy().into_owned();
        }
        if st.request_timeout_sec <= 0 {
            st.request_timeout_sec = 600;
        }
        st
    }

    pub fn settings(&self) -> Settings {
        let _g = self.mu.lock().unwrap();
        self.settings_unlocked()
    }

    pub fn update_settings(&self, p: SettingsPatch) -> Result<Settings, String> {
        let _g = self.mu.lock().unwrap();
        let mut st = self.settings_unlocked();
        if let Some(d) = p.output_dir {
            let mut d = d.trim().to_string();
            if d.is_empty() {
                d = self.default_out.to_string_lossy().into_owned();
            }
            if !Path::new(&d).is_absolute() {
                return Err("输出目录必须是绝对路径".into());
            }
            fs::create_dir_all(&d).map_err(|e| format!("无法创建输出目录：{e}"))?;
            st.output_dir = d;
        }
        if let Some(t) = p.request_timeout_sec {
            if !(10..=3600).contains(&t) {
                return Err("请求超时需在 10–3600 秒之间".into());
            }
            st.request_timeout_sec = t;
        }
        if let Some(fp) = p.filename_prefix {
            st.filename_prefix = fp.trim().into();
        }
        write_json(&self.dir.join("settings.json"), &st)?;
        Ok(st)
    }

    fn history_path(&self) -> PathBuf {
        self.dir.join("history.json")
    }

    fn load_history(&self) -> Vec<Item> {
        fs::read(self.history_path())
            .ok()
            .and_then(|r| serde_json::from_slice::<Option<Vec<Item>>>(&r).ok())
            .flatten()
            .unwrap_or_default()
    }

    pub fn add_items(&self, items: &[Item]) -> Result<(), String> {
        let _g = self.mu.lock().unwrap();
        let mut all = self.load_history();
        all.extend_from_slice(items);
        write_json(&self.history_path(), &all)
    }

    /// 按时间倒序返回匹配记录与总数。
    pub fn list(&self, q: &Query) -> (Vec<Item>, usize) {
        let all = {
            let _g = self.mu.lock().unwrap();
            self.load_history()
        };
        let kw = q.q.trim().to_lowercase();
        let mut out: Vec<Item> = all
            .into_iter()
            .filter(|it| q.mode.is_empty() || it.mode == q.mode)
            .filter(|it| q.group.is_empty() || it.group == q.group)
            .filter(|it| {
                kw.is_empty()
                    || format!("{}\n{}\n{}\n{}", it.prompt, it.revised_prompt, it.model, file_name(&it.path))
                        .to_lowercase()
                        .contains(&kw)
            })
            .collect();
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.index.cmp(&b.index)));
        let total = out.len();
        if q.limit > 0 && out.len() > q.limit {
            out.truncate(q.limit);
        }
        (out, total)
    }

    pub fn get(&self, id: &str) -> Option<Item> {
        let _g = self.mu.lock().unwrap();
        self.load_history().into_iter().find(|it| it.id == id)
    }

    /// 删除记录；delete_file 为 true 时同时删除本地图片。
    pub fn delete(&self, id: &str, delete_file: bool) -> Result<Item, String> {
        let _g = self.mu.lock().unwrap();
        let mut all = self.load_history();
        let i = all.iter().position(|it| it.id == id).ok_or("记录不存在")?;
        let it = all[i].clone();
        if delete_file && !it.path.is_empty() {
            if let Err(e) = fs::remove_file(&it.path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("删除图片文件失败：{e}"));
                }
            }
        }
        all.remove(i);
        write_json(&self.history_path(), &all)?;
        Ok(it)
    }

    /// 历史中出现过的分组名。
    pub fn groups(&self) -> Vec<String> {
        let _g = self.mu.lock().unwrap();
        self.load_history()
            .into_iter()
            .map(|it| it.group)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_and_settings() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().into(), d.path().join("out"));
        assert_eq!(s.settings().request_timeout_sec, 600);
        assert!(s.update_settings(SettingsPatch { request_timeout_sec: Some(5), ..Default::default() }).is_err());
        assert!(s.update_settings(SettingsPatch { output_dir: Some("rel".into()), ..Default::default() }).is_err());
        let st = s.update_settings(SettingsPatch { filename_prefix: Some(" p ".into()), ..Default::default() }).unwrap();
        assert_eq!(st.filename_prefix, "p");
        let mk = |id: &str, t: i64, i: i64, mode: &str, prompt: &str| Item {
            id: id.into(),
            created_at: t,
            index: i,
            mode: mode.into(),
            group: "g".into(),
            prompt: prompt.into(),
            path: format!("/x/{id}.png"),
            ..Default::default()
        };
        s.add_items(&[mk("a", 1, 0, "generate", "橘猫"), mk("b", 2, 1, "edit", "狗"), mk("c", 2, 0, "generate", "橘猫2")]).unwrap();
        let (l, n) = s.list(&Query::default());
        assert_eq!(n, 3);
        assert_eq!(l.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["c", "b", "a"]);
        assert_eq!(s.list(&Query { q: "橘猫".into(), ..Default::default() }).1, 2);
        assert_eq!(s.list(&Query { mode: "edit".into(), ..Default::default() }).1, 1);
        assert_eq!(s.list(&Query { limit: 1, ..Default::default() }).0.len(), 1);
        s.delete("b", true).unwrap();
        assert!(s.delete("b", false).is_err());
        assert_eq!(s.groups(), ["g"]);
        let raw = fs::read_to_string(d.path().join("history.json")).unwrap();
        assert!(!raw.contains("revisedPrompt") && raw.contains("\"fileSize\""));
    }
}
