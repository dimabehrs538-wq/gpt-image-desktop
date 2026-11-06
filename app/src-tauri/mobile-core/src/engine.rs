//! 生图引擎：分组解析 → 输入图片读取 → 调用接口 → 防覆盖落盘 → 写入历史（对齐 Go `internal/engine`）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

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

    /// 执行请求：调用接口 → 防覆盖落盘 → 写入历史。
    pub async fn run(&self, job_id: &str, p: &Prepared) -> Result<Vec<Item>, String> {
        let st = self.store.settings();
        let client = Client::new(Duration::from_secs(st.request_timeout_sec.max(1) as u64));
        let r = &p.req;
        let params = Params {
            model: r.model.clone(),
            prompt: r.prompt.clone(),
            size: r.size.clone(),
            quality: r.quality.clone(),
            background: r.background.clone(),
            output_format: r.output_format.clone(),
            n: r.n,
        };
        let start = chrono::Local::now();
        let res = if r.mode == "edit" {
            client.edit(&p.endpoint, &params, &p.images, p.mask.as_ref()).await
        } else {
            client.generate(&p.endpoint, &params).await
        };
        let elapsed = (chrono::Local::now() - start).num_milliseconds();
        let imgs = res.map_err(|e| redact(&e, &[&p.endpoint.key]))?;
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
        let out_dir = Path::new(&st.output_dir);
        let mut items = Vec::with_capacity(imgs.len());
        for (i, im) in imgs.iter().enumerate() {
            let b = if imgs.len() > 1 { format!("{base}-{}", i + 1) } else { base.clone() };
            let path = match save_no_overwrite(out_dir, &b, ext_for(&im.data, &r.output_format), &im.data) {
                Ok(x) => x,
                Err(e) => return Err(format!("保存图片失败：{e}")),
            };
            let (w, h) = crate::util::image_size(&im.data).unwrap_or((0, 0));
            items.push(Item {
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
                index: i as i64,
                path: path.to_string_lossy().into_owned(),
                file_size: im.data.len() as i64,
                width: w,
                height: h,
                elapsed_ms: elapsed,
                source_url: im.source_url.clone(),
                input_images: p.paths.clone(),
                mask: p.mask_path.clone(),
            });
        }
        self.store.add_items(&items).map_err(|e| format!("写入历史失败：{e}"))?;
        Ok(items)
    }
}
