//! 调用 OpenAI 兼容的 /images/generations、/images/edits 与 /models 接口（对齐 Go `internal/imageapi`）。

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::config::{redact, Endpoint};
use crate::util::{decode_b64, detect, file_name};

const UA: &str = "GPTImageStudio/1.0";

/// 生图公共参数；空字符串表示不发送该字段。
#[derive(Debug, Clone, Default)]
pub struct Params {
    pub model: String,
    pub prompt: String,
    pub size: String,
    pub quality: String,
    pub background: String,
    pub output_format: String,
    pub n: i64,
}

#[derive(Debug, Clone)]
pub struct InputImage {
    pub name: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct Image {
    pub data: Vec<u8>,
    pub source_url: String,
    pub revised_prompt: String,
}

/// 接口返回的错误（已脱敏）。
#[derive(Debug, Clone, Default)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
    pub code: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.status == 0 {
            write!(f, "网络错误")?;
        } else {
            write!(f, "HTTP {}", self.status)?;
        }
        if !self.code.is_empty() {
            write!(f, " [{}]", self.code)?;
        }
        write!(f, "：{}", self.message)
    }
}

pub struct Client {
    http: reqwest::Client,
}

fn snippet(s: &str) -> String {
    let r: Vec<char> = s.chars().collect();
    if r.len() > 300 {
        r[..300].iter().collect::<String>() + "…"
    } else {
        s.to_string()
    }
}

/// 剥离 reqwest 错误链，得到尽量完整的原因描述。
fn err_chain(e: &reqwest::Error) -> String {
    let mut s = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(c) = src {
        s.push_str(": ");
        s.push_str(&c.to_string());
        src = c.source();
    }
    s
}

fn validate(p: &Params) -> Result<(), String> {
    if p.prompt.trim().is_empty() {
        return Err("提示词不能为空".into());
    }
    if p.model.is_empty() {
        return Err("模型不能为空".into());
    }
    if p.n < 0 || p.n > 10 {
        return Err("生成张数需在 1–10 之间".into());
    }
    if !p.size.is_empty() && p.size != "auto" {
        let bad = || format!("尺寸格式不正确：{}（应为 宽x高，例如 1024x1024）", p.size);
        let (w, h) = p.size.split_once('x').ok_or_else(bad)?;
        if w.parse::<i64>().is_err() || h.parse::<i64>().is_err() {
            return Err(bad());
        }
    }
    Ok(())
}

/// 解析 OpenAI 风格错误体并脱敏。
pub fn parse_error(status: u16, raw: &[u8], key: &str) -> ApiError {
    let mut e = ApiError { status, ..Default::default() };
    if let Ok(Value::Object(body)) = serde_json::from_slice::<Value>(raw) {
        match body.get("error") {
            Some(Value::Object(o)) if o.get("message").and_then(Value::as_str).is_some_and(|m| !m.is_empty()) => {
                e.message = o["message"].as_str().unwrap_or_default().into();
                e.code = match o.get("code") {
                    None | Some(Value::Null) => String::new(),
                    Some(Value::String(s)) => s.clone(),
                    Some(v) => v.to_string(),
                };
            }
            Some(Value::String(s)) if !s.is_empty() => e.message = s.clone(),
            _ => {
                if let Some(m) = body.get("message").and_then(Value::as_str) {
                    e.message = m.into();
                }
            }
        }
    }
    if e.message.is_empty() {
        e.message = snippet(String::from_utf8_lossy(raw).trim());
        if e.message.is_empty() {
            e.message = reqwest::StatusCode::from_u16(status)
                .ok()
                .and_then(|s| s.canonical_reason())
                .unwrap_or("")
                .into();
        }
    }
    e.message = redact(&e.message, &[key]);
    e
}

/// 测试连接结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    pub status: u16,
    pub latency_ms: i64,
    pub message: String,
    pub url: String,
    pub model_count: usize,
    pub model_listed: bool,
    pub models_returned: bool,
}

impl Client {
    pub fn new(timeout: Duration) -> Self {
        let timeout = if timeout.is_zero() { Duration::from_secs(600) } else { timeout };
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .user_agent(UA)
            .build()
            .unwrap_or_default();
        Self { http }
    }

    pub async fn generate(&self, ep: &Endpoint, p: &Params) -> Result<Vec<Image>, String> {
        validate(p)?;
        let mut body = Map::new();
        body.insert("model".into(), json!(p.model));
        body.insert("prompt".into(), json!(p.prompt));
        if p.n > 0 {
            body.insert("n".into(), json!(p.n));
        }
        for (k, v) in [("size", &p.size), ("quality", &p.quality), ("background", &p.background), ("output_format", &p.output_format)] {
            if !v.is_empty() {
                body.insert(k.into(), json!(v));
            }
        }
        let req = self
            .http
            .post(format!("{}/images/generations", ep.base_url))
            .header("Content-Type", "application/json")
            .body(serde_json::to_vec(&Value::Object(body)).unwrap());
        self.send(ep, req).await
    }

    /// 图生图 / 图像编辑：单图用 image 字段，多图按顺序用 image[] 字段。
    pub async fn edit(&self, ep: &Endpoint, p: &Params, images: &[InputImage], mask: Option<&InputImage>) -> Result<Vec<Image>, String> {
        validate(p)?;
        if images.is_empty() {
            return Err("请至少提供一张参考图".into());
        }
        let mut form = reqwest::multipart::Form::new()
            .text("model", p.model.clone())
            .text("prompt", p.prompt.clone());
        if p.n > 0 {
            form = form.text("n", p.n.to_string());
        }
        for (k, v) in [("size", &p.size), ("quality", &p.quality), ("background", &p.background), ("output_format", &p.output_format)] {
            if !v.is_empty() {
                form = form.text(k, v.clone());
            }
        }
        let field = if images.len() > 1 { "image[]" } else { "image" };
        for im in images {
            form = form.part(field, part(im)?);
        }
        if let Some(m) = mask.filter(|m| !m.data.is_empty()) {
            form = form.part("mask", part(m)?);
        }
        let req = self.http.post(format!("{}/images/edits", ep.base_url)).multipart(form);
        self.send(ep, req).await
    }

    async fn send(&self, ep: &Endpoint, req: reqwest::RequestBuilder) -> Result<Vec<Image>, String> {
        let key = ep.key.as_str();
        let resp = req
            .bearer_auth(key)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| ApiError { message: redact(&err_chain(&e), &[key]), ..Default::default() }.to_string())?;
        let status = resp.status().as_u16();
        let raw = resp.bytes().await.map_err(|e| {
            ApiError { status, message: format!("读取响应失败：{}", redact(&err_chain(&e), &[key])), ..Default::default() }.to_string()
        })?;
        if !(200..300).contains(&status) {
            return Err(parse_error(status, &raw, key).to_string());
        }
        #[derive(Deserialize)]
        struct D {
            #[serde(default)]
            b64_json: Option<String>,
            #[serde(default)]
            url: Option<String>,
            #[serde(default)]
            revised_prompt: Option<String>,
        }
        #[derive(Deserialize)]
        struct R {
            #[serde(default)]
            data: Option<Vec<D>>,
        }
        let ir: R = serde_json::from_slice(&raw).map_err(|_| {
            ApiError { status, message: format!("响应不是合法 JSON：{}", snippet(&redact(&String::from_utf8_lossy(&raw), &[key]))), ..Default::default() }
                .to_string()
        })?;
        let data = ir.data.unwrap_or_default();
        if data.is_empty() {
            return Err(ApiError { status, message: "接口未返回任何图片（data 为空）".into(), ..Default::default() }.to_string());
        }
        let mut out = Vec::with_capacity(data.len());
        for (i, d) in data.into_iter().enumerate() {
            let mut im = Image { revised_prompt: d.revised_prompt.unwrap_or_default(), ..Default::default() };
            let b64 = d.b64_json.unwrap_or_default();
            let url = d.url.unwrap_or_default();
            if !b64.is_empty() {
                im.data = decode_b64(&b64).map_err(|e| format!("第 {} 张图片 b64_json 解码失败：{}", i + 1, e))?;
            } else if !url.is_empty() {
                im.data = self
                    .download(&url)
                    .await
                    .map_err(|e| format!("第 {} 张图片下载失败：{}", i + 1, redact(&e, &[key])))?;
                im.source_url = url;
            } else {
                return Err(format!("第 {} 张图片既没有 b64_json 也没有 url", i + 1));
            }
            out.push(im);
        }
        Ok(out)
    }

    async fn download(&self, u: &str) -> Result<Vec<u8>, String> {
        let resp = self.http.get(u).send().await.map_err(|e| err_chain(&e))?;
        if resp.status().as_u16() != 200 {
            return Err(format!("HTTP {}", resp.status().as_u16()));
        }
        Ok(resp.bytes().await.map_err(|e| err_chain(&e))?.to_vec())
    }

    /// 向 {base}/models 发起鉴权探测。
    pub async fn probe(&self, ep: &Endpoint) -> ProbeResult {
        let mut r = ProbeResult { url: format!("{}/models", ep.base_url), ..Default::default() };
        let start = Instant::now();
        let resp = self
            .http
            .get(&r.url)
            .bearer_auth(&ep.key)
            .timeout(Duration::from_secs(20))
            .send()
            .await;
        r.latency_ms = start.elapsed().as_millis() as i64;
        let resp = match resp {
            Ok(x) => x,
            Err(e) => {
                r.message = format!("无法连接：{}", redact(&err_chain(&e), &[&ep.key]));
                return r;
            }
        };
        r.status = resp.status().as_u16();
        let raw = resp.bytes().await.unwrap_or_default();
        if !(200..300).contains(&r.status) {
            r.message = parse_error(r.status, &raw, &ep.key).to_string();
            return r;
        }
        r.ok = true;
        if let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(&raw) {
            if let Some(Value::Array(list)) = m.get("data") {
                r.models_returned = true;
                // 与模型列表缓存的 total 语义一致：统计不同的非空模型 ID（重复 ID 只计一次）
                r.model_count = list
                    .iter()
                    .filter_map(|x| x.get("id").and_then(Value::as_str))
                    .filter(|id| !id.is_empty())
                    .collect::<std::collections::HashSet<_>>()
                    .len();
                r.model_listed = list.iter().any(|x| x.get("id").and_then(Value::as_str) == Some(ep.model.as_str()));
            }
        }
        r.message = if !r.models_returned {
            "连接成功（接口未返回模型列表）".into()
        } else if r.model_listed {
            format!("连接成功，模型 {} 可用（共 {} 个不同模型）", ep.model, r.model_count)
        } else {
            format!("连接成功，共 {} 个不同模型，但列表中未找到 {}（部分中转站不列出生图模型，可直接尝试）", r.model_count, ep.model)
        };
        r
    }
}

fn part(im: &InputImage) -> Result<reqwest::multipart::Part, String> {
    let mut name = file_name(&im.name);
    if name.is_empty() || name == "." {
        name = "image.png".into();
    }
    reqwest::multipart::Part::bytes(im.data.clone())
        .file_name(name.replace('"', ""))
        .mime_str(detect(&im.data))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors() {
        let e = parse_error(400, br#"{"error":{"message":"bad sk-abcdefghijklmn","code":"invalid_size"}}"#, "");
        assert_eq!(e.to_string(), "HTTP 400 [invalid_size]：bad sk-••••klmn");
        assert_eq!(parse_error(401, br#"{"error":"nope"}"#, "").to_string(), "HTTP 401：nope");
        assert_eq!(parse_error(500, br#"{"message":"m","error":{"code":5}}"#, "").message, "m");
        assert_eq!(parse_error(502, b"", "").message, "Bad Gateway");
        assert_eq!(parse_error(400, br#"{"error":{"message":"x","code":400}}"#, "").code, "400");
        assert_eq!(ApiError { message: "x".into(), ..Default::default() }.to_string(), "网络错误：x");
    }

    #[test]
    fn validation() {
        let p = |size: &str| Params { model: "m".into(), prompt: "p".into(), size: size.into(), ..Default::default() };
        assert!(validate(&p("1024x1024")).is_ok());
        assert!(validate(&p("auto")).is_ok());
        assert!(validate(&p("big")).is_err());
        assert!(validate(&p("10x")).is_err());
        assert!(validate(&Params { n: 11, ..p("") }).is_err());
    }
}
