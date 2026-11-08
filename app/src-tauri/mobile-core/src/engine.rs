//! 生图引擎：分组解析 → 输入图片读取 → 调用接口 → 防覆盖落盘 → 写入历史（对齐 Go `internal/engine`）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::config::{self, redact, Endpoint};
use crate::imageapi::{Client, InputImage, Params};
use crate::store::{self, Item};
use crate::util::{decode_b64, detect, ext_for, ext_of, file_name, new_id, null_default, safe_base, save_no_overwrite};

/// 参考图 / 蒙版：path（本地文件）或 dataUrl（data:image/png;base64,...）二选一。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageInput {
    #[serde(deserialize_with = "null_default")]
    pub path: String,
    #[serde(deserialize_with = "null_default")]
    pub data_url: String,
    #[serde(deserialize_with = "null_default")]
    pub name: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Request {
    #[serde(deserialize_with = "null_default")]
    pub mode: String,
    #[serde(deserialize_with = "null_default")]
    pub group: String,
    #[serde(deserialize_with = "null_default")]
    pub model: String,
    #[serde(deserialize_with = "null_default")]
    pub prompt: String,
    #[serde(deserialize_with = "null_default")]
    pub size: String,
    #[serde(deserialize_with = "null_default")]
    pub quality: String,
    #[serde(deserialize_with = "null_default")]
    pub background: String,
    #[serde(deserialize_with = "null_default")]
    pub output_format: String,
    #[serde(deserialize_with = "null_default")]
    pub n: i64,
    #[serde(deserialize_with = "null_default")]
    pub name: String,
    #[serde(deserialize_with = "null_default")]
    pub images: Vec<ImageInput>,
    pub mask: Option<ImageInput>,
}

pub struct Prepared {
    pub req: Request,
    pub endpoint: Endpoint,
    pub images: Vec<InputImage>,
    pub paths: Vec<String>,
    pub mask: Option<InputImage>,
    pub mask_path: String,
}

pub struct Engine {
    pub groups: config::Store,
    pub store: store::Store,
    pub home: PathBuf,
}

impl Engine {
    pub fn new(home: PathBuf, default_out: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            groups: config::Store::new(home.join("groups.json")),
            store: store::Store::new(home.clone(), default_out),
            home,
        })
    }

    /// 校验请求并解析分组、读取输入图片（同步执行，便于立即返回参数错误）。
    pub fn prepare(&self, mut req: Request) -> Result<Prepared, String> {
        if req.mode.is_empty() {
            req.mode = "generate".into();
        }
        if req.mode != "generate" && req.mode != "edit" {
            return Err(format!("未知的模式：{}", req.mode));
        }
        if req.prompt.trim().is_empty() {
            return Err("提示词不能为空".into());
        }
        if req.n == 0 {
            req.n = 1;
        }
        if !(1..=10).contains(&req.n) {
            return Err("生成张数需在 1–10 之间".into());
        }
        let mut ep = self.groups.resolve(&req.group)?;
        req.group = ep.group.clone();
        if !req.model.trim().is_empty() {
            ep.model = req.model.trim().into(); // 严格使用用户指定的模型
        }
        req.model = ep.model.clone();
        let mut p = Prepared { req, endpoint: ep, images: vec![], paths: vec![], mask: None, mask_path: String::new() };
        if p.req.mode == "edit" {
            if p.req.images.is_empty() {
                return Err("图生图需要至少一张参考图".into());
            }
            if p.req.images.len() > 16 {
                return Err("参考图最多 16 张".into());
            }
            for (i, inp) in p.req.images.iter().enumerate() {
                let (im, path) = self.load_input(inp).map_err(|e| format!("参考图 {}：{}", i + 1, e))?;
                p.images.push(im);
                p.paths.push(path);
            }
            if let Some(m) = p.req.mask.as_ref().filter(|m| !m.path.is_empty() || !m.data_url.is_empty()) {
                let (im, path) = self.load_input(m).map_err(|e| format!("蒙版：{e}"))?;
                p.mask = Some(im);
                p.mask_path = path;
            }
        }
        Ok(p)
    }

    fn load_input(&self, inp: &ImageInput) -> Result<(InputImage, String), String> {
        if !inp.path.is_empty() {
            let data = fs::read(&inp.path).map_err(|e| format!("无法读取 {}：{}", inp.path, e))?;
            if !detect(&data).starts_with("image/") {
                return Err(format!("{} 不是图片文件", file_name(&inp.path)));
            }
            return Ok((InputImage { name: file_name(&inp.path), data }, inp.path.clone()));
        }
        if inp.data_url.is_empty() {
            return Err("缺少图片数据".into());
        }
        let data = decode_b64(&inp.data_url).map_err(|_| "图片数据解码失败".to_string())?;
        let (name, path) = self.save_upload(&inp.name, &data)?;
        Ok((InputImage { name, data }, path))
    }

    /// 保存上传的参考图副本到 home/inputs/YYYY-MM（便于“复用参数”与历史追溯），返回 (文件名, 路径)。
    pub fn save_upload(&self, name: &str, data: &[u8]) -> Result<(String, String), String> {
        if !detect(data).starts_with("image/") {
            return Err("上传的文件不是图片".into());
        }
        let name = if name.is_empty() { format!("input{}", ext_for(data, "")) } else { name.to_string() };
        let mut ext = ext_of(&name).to_string();
        if ext.is_empty() {
            ext = ext_for(data, "").into();
        }
        let mut base = safe_base(name.strip_suffix(ext.as_str()).unwrap_or(&name));
        if base.is_empty() {
            base = "input".into();
        }
        let dir = self.home.join("inputs").join(chrono::Local::now().format("%Y-%m").to_string());
        let path = save_no_overwrite(&dir, &base, &ext.to_lowercase(), data).map_err(|e| format!("保存参考图副本失败：{e}"))?;
        Ok((name, path.to_string_lossy().into_owned()))
    }

    /// 执行请求：调用接口 → 防覆盖落盘 → 逐张写入历史（对齐 Go `Engine.Execute`）。
    /// 接口返回张数少于 n 时按设置 missingPolicy=fill 逐张补请求（每次 n=1），总请求次数不超过 n；
    /// 任一请求出错、返回 0 张、有图片无法使用或被取消时立即停止，不无限重试。已保存的图片始终保留。
    pub async fn execute(&self, job_id: &str, p: &Prepared, cancel: &CancellationToken, mut progress: impl FnMut(&Outcome)) -> Outcome {
        let st = self.store.settings();
        let client = Client::new(Duration::from_secs(st.request_timeout_sec.max(1) as u64));
        let r = &p.req;
        let mut o = Outcome { requested: r.n, ..Default::default() };
        let start = chrono::Local::now();
        let mut base = safe_base(&r.name);
        if base.is_empty() {
            let mut prefix = safe_base(&st.filename_prefix);
            if prefix.is_empty() {
                prefix = "imagegen".into();
            }
            if r.mode == "edit" {
                prefix.push_str("-edit");
            }
            base = format!("{prefix}-{}", start.format("%Y%m%d-%H%M%S"));
        }
        let max_requests = if st.missing_policy == store::MISSING_FILL { r.n } else { 1 };
        while o.received < o.requested && o.requests < max_requests {
            // 补图请求每次只要 1 张：接口忽略 n 时不会按大 n 重复计费
            let n = if o.requests > 0 { 1 } else { o.requested - o.received };
            let params = Params {
                model: r.model.clone(),
                prompt: r.prompt.clone(),
                size: r.size.clone(),
                quality: r.quality.clone(),
                background: r.background.clone(),
                output_format: r.output_format.clone(),
                n,
            };
            o.requests += 1;
            let call = async {
                if r.mode == "edit" {
                    client.edit(&p.endpoint, &params, &p.images, p.mask.as_ref()).await
                } else {
                    client.generate(&p.endpoint, &params).await
                }
            };
            let res = tokio::select! {
                _ = cancel.cancelled() => None,
                x = call => Some(x),
            };
            let batch = match res {
                None => {
                    o.canceled = true;
                    break;
                }
                Some(Err(e)) => {
                    let mut msg = redact(&e, &[&p.endpoint.key]);
                    if o.requests > 1 {
                        msg = format!("第 {} 次请求（补图）失败：{}", o.requests, msg);
                    }
                    o.err = msg;
                    break;
                }
                Some(Ok(b)) => b,
            };
            if batch.images.is_empty() && batch.failures.is_empty() {
                o.err = "接口未返回任何图片（data 为空）".into();
                break;
            }
            o.received += (batch.images.len() + batch.failures.len()) as i64;
            if !batch.failures.is_empty() {
                o.failed += batch.failures.len() as i64;
                o.err = redact(&batch.failure_text(), &[&p.endpoint.key]);
            }
            let total = batch.images.len();
            for (k, im) in batch.images.iter().enumerate() {
                // 接口多返回的图片也保存（已生成，可能已计费）
                match self.save_one(&st, &base, &start, job_id, p, o.saved, im) {
                    Ok(it) => {
                        o.items.push(it);
                        o.saved += 1;
                        progress(&o);
                    }
                    Err(e) => {
                        o.failed += (total - k) as i64;
                        o.err = e;
                        break;
                    }
                }
            }
            if cancel.is_cancelled() {
                o.canceled = true;
            }
            if !o.err.is_empty() || o.canceled {
                break; // 有图片无法使用 / 保存失败：这些图片接口已生成（可能已计费），不自动补，如实报告
            }
            if o.requests == 1 && o.received < o.requested {
                o.notes.push(format!("接口只返回了 {}/{} 张（该接口可能不支持一次生成多张）", o.received, o.requested));
            }
        }
        if o.requests > 1 {
            o.notes.push(format!("已逐张补请求 {} 次", o.requests - 1));
        }
        if !o.canceled && o.err.is_empty() && o.saved < o.requested && st.missing_policy == store::MISSING_REPORT {
            o.notes.push("未自动补图（默认只报告，可在设置中开启“张数不足时逐张补图”）".into());
        }
        if o.canceled {
            o.notes.push(format!("已取消，保留已生成的 {} 张", o.saved));
        }
        progress(&o);
        o
    }

    #[allow(clippy::too_many_arguments)]
    fn save_one(&self, st: &store::Settings, base: &str, start: &chrono::DateTime<chrono::Local>, job_id: &str, p: &Prepared, index: i64, im: &crate::imageapi::Image) -> Result<Item, String> {
        let r = &p.req;
        let b = if r.n > 1 { format!("{base}-{}", index + 1) } else { base.to_string() };
        let path = save_no_overwrite(Path::new(&st.output_dir), &b, ext_for(&im.data, &r.output_format), &im.data)
            .map_err(|e| format!("保存第 {} 张图片失败：{e}", index + 1))?;
        let (w, h) = crate::util::image_size(&im.data).unwrap_or((0, 0));
        let it = Item {
            id: new_id(),
            job_id: job_id.into(),
            created_at: start.timestamp_millis(),
            mode: r.mode.clone(),
            group: r.group.clone(),
            base_url: p.endpoint.base_url.clone(),
            model: r.model.clone(),
            prompt: r.prompt.clone(),
            revised_prompt: im.revised_prompt.clone(),
            size: r.size.clone(),
            quality: r.quality.clone(),
            background: r.background.clone(),
            output_format: r.output_format.clone(),
            n: r.n,
            index,
            path: path.to_string_lossy().into_owned(),
            file_size: im.data.len() as i64,
            width: w,
            height: h,
            elapsed_ms: (chrono::Local::now() - *start).num_milliseconds(),
            source_url: im.source_url.clone(),
            input_images: p.paths.clone(),
            mask: p.mask_path.clone(),
        };
        self.store.add_items(std::slice::from_ref(&it)).map_err(|e| format!("写入历史失败：{e}"))?;
        Ok(it)
    }
}

/// 一次任务的实际结果（期望 / 接口返回 / 已保存 / 失败 张数与请求次数），与 Go `engine.Outcome` 一致。
#[derive(Debug, Clone, Default)]
pub struct Outcome {
    pub requested: i64,
    pub received: i64,
    pub saved: i64,
    pub failed: i64,
    pub requests: i64,
    pub notes: Vec<String>,
    pub items: Vec<Item>,
    pub err: String,
    pub canceled: bool,
}

impl Outcome {
    /// succeeded（张数齐全）/ partial（只得到部分）/ failed / canceled
    pub fn status(&self) -> &'static str {
        if self.canceled {
            "canceled"
        } else if self.saved >= self.requested && self.err.is_empty() {
            "succeeded"
        } else if self.saved > 0 {
            "partial"
        } else {
            "failed"
        }
    }

    pub fn summary(&self) -> String {
        let mut parts = Vec::new();
        if !self.err.is_empty() {
            parts.push(self.err.clone());
        }
        parts.extend(self.notes.iter().cloned());
        parts.join("；")
    }
}
