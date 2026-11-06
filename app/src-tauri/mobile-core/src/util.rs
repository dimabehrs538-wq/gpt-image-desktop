//! 与 Go 内核一致的小工具：内容嗅探、扩展名推断、安全文件名、防覆盖保存、WebP 尺寸、ID 生成。

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use rand::RngCore;
use regex::Regex;
use serde::{Deserialize, Deserializer};

/// 与 Go `http.DetectContentType` 在图片类型上的判断一致；非图片统一返回 application/octet-stream。
pub fn detect(b: &[u8]) -> &'static str {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        "image/gif"
    } else if b.len() >= 14 && &b[0..4] == b"RIFF" && &b[8..14] == b"WEBPVP" {
        "image/webp"
    } else if b.starts_with(b"BM") {
        "image/bmp"
    } else if b.starts_with(&[0, 0, 1, 0]) || b.starts_with(&[0, 0, 2, 0]) {
        "image/x-icon"
    } else {
        "application/octet-stream"
    }
}

/// 根据实际内容（优先）或 output_format 推断扩展名。
pub fn ext_for(data: &[u8], output_format: &str) -> &'static str {
    match detect(data) {
        "image/png" => return ".png",
        "image/jpeg" => return ".jpg",
        "image/webp" => return ".webp",
        "image/gif" => return ".gif",
        _ => {}
    }
    match output_format.to_ascii_lowercase().as_str() {
        "jpeg" | "jpg" => ".jpg",
        "webp" => ".webp",
        _ => ".png",
    }
}

static UNSAFE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9._-]+").unwrap());

/// 把任意字符串转成安全的 ASCII 文件名前缀（最长 48）。
pub fn safe_base(s: &str) -> String {
    let s = UNSAFE_RE.replace_all(s.trim(), "-");
    let mut s = s.trim_matches(|c| c == '-' || c == '.').to_string();
    if s.len() > 48 {
        s.truncate(48);
        s = s.trim_end_matches(['-', '.']).to_string();
    }
    s
}

/// 以 create_new（O_EXCL）写入 dir/base+ext；同名已存在时依次尝试 base-2、base-3…，绝不覆盖。
pub fn save_no_overwrite(dir: &Path, base: &str, ext: &str, data: &[u8]) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let base = if base.is_empty() { "image" } else { base };
    for i in 1..100000 {
        let name = if i > 1 { format!("{base}-{i}{ext}") } else { format!("{base}{ext}") };
        let p = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(mut f) => {
                if let Err(e) = f.write_all(data) {
                    drop(f);
                    let _ = fs::remove_file(&p);
                    return Err(e);
                }
                return Ok(p);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::other("无法找到可用的文件名"))
}

/// 原子写入（临时文件 + rename），Unix 上权限 0600。
pub fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    create_private_dir(dir)?;
    let tmp = dir.join(format!(".tmp-{}", rand_hex(6)));
    let res = (|| {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all().ok();
        drop(f);
        fs::rename(&tmp, path)?;
        set_private(path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    if dir.as_os_str().is_empty() || dir.exists() {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

pub fn set_private(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub fn rand_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 与 Go `engine.NewID` 一致：20060102150405-随机 12 位十六进制。
pub fn new_id() -> String {
    format!("{}-{}", chrono::Local::now().format("%Y%m%d%H%M%S"), rand_hex(6))
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 解析 WebP（VP8 / VP8L / VP8X）宽高。
pub fn webp_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 30 || &b[0..4] != b"RIFF" || &b[8..12] != b"WEBP" {
        return None;
    }
    match &b[12..16] {
        b"VP8X" => {
            let w = b[24] as u32 | (b[25] as u32) << 8 | (b[26] as u32) << 16;
            let h = b[27] as u32 | (b[28] as u32) << 8 | (b[29] as u32) << 16;
            Some((w + 1, h + 1))
        }
        b"VP8 " => {
            let w = u16::from_le_bytes([b[26], b[27]]) as u32 & 0x3fff;
            let h = u16::from_le_bytes([b[28], b[29]]) as u32 & 0x3fff;
            Some((w, h))
        }
        b"VP8L" => {
            let bits = u32::from_le_bytes([b[21], b[22], b[23], b[24]]);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        _ => None,
    }
}

/// 图片宽高（PNG / JPEG / GIF / WebP）。
pub fn image_size(data: &[u8]) -> Option<(u32, u32)> {
    image::ImageReader::new(io::Cursor::new(data))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .or_else(|| webp_size(data))
}

/// 去掉 data:...;base64, 前缀并解码（容忍换行空白）。
pub fn decode_b64(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    let mut b = s;
    if b.starts_with("data:") {
        if let Some(i) = b.find(',') {
            b = &b[i + 1..];
        }
    }
    let clean: String = b.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    base64::engine::general_purpose::STANDARD.decode(clean)
}

/// Go 风格：JSON null 视作零值。
pub fn null_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

pub fn file_name(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 与 Go filepath.Ext 一致：最后一个 . 起的后缀（不含路径分隔符）。
pub fn ext_of(name: &str) -> &str {
    match name.rfind(['.', '/', '\\']) {
        Some(i) if name.as_bytes()[i] == b'.' => &name[i..],
        _ => "",
    }
}

pub fn expand_home(p: &str) -> PathBuf {
    if p == "~" || p.starts_with("~/") || p.starts_with("~\\") {
        if let Some(h) = home_dir() {
            return h.join(p[1..].trim_start_matches(['/', '\\']));
        }
    }
    PathBuf::from(p)
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_base_and_ext() {
        assert_eq!(safe_base("  我的 猫/cat?.png "), "cat-.png");
        assert_eq!(safe_base("astro-cat"), "astro-cat");
        assert_eq!(ext_of("a/b.c/d"), "");
        assert_eq!(ext_of("底图.PNG"), ".PNG");
        assert_eq!(ext_for(b"\x89PNG\r\n\x1a\n....", "jpeg"), ".png");
        assert_eq!(ext_for(b"????", "jpeg"), ".jpg");
        assert_eq!(ext_for(b"????", ""), ".png");
    }

    #[test]
    fn no_overwrite() {
        let d = tempfile::tempdir().unwrap();
        let a = save_no_overwrite(d.path(), "x", ".png", b"1").unwrap();
        let b = save_no_overwrite(d.path(), "x", ".png", b"2").unwrap();
        let c = save_no_overwrite(d.path(), "x", ".png", b"3").unwrap();
        assert!(a.ends_with("x.png") && b.ends_with("x-2.png") && c.ends_with("x-3.png"));
        assert_eq!(fs::read(&a).unwrap(), b"1");
    }

    #[test]
    fn b64() {
        assert_eq!(decode_b64("data:image/png;base64,aGk=").unwrap(), b"hi");
        assert_eq!(decode_b64("aG\nk=").unwrap(), b"hi");
        assert!(decode_b64("@@").is_err());
    }
}
