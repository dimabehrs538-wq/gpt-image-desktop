//! JPEG 缩略图缓存（PNG / JPEG / GIF / WebP），透明部分铺白底，与 Go `internal/thumb` 的缓存策略一致。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use image::{imageops::FilterType, DynamicImage, ImageReader, Rgb, RgbImage};

pub fn get(cache_dir: &Path, src: &Path, max_side: u32) -> Result<PathBuf, String> {
    let meta = fs::metadata(src).map_err(|e| e.to_string())?;
    let max_side = max_side.clamp(64, 1024);
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let key = format!("{}|{}|{}|{}", src.display(), meta.len(), mtime, max_side);
    let out = cache_dir.join(format!("{}.jpg", sha1_smol::Sha1::from(key).digest()));
    if out.exists() {
        return Ok(out);
    }
    let img = ImageReader::open(src)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;
    let dst = scale(&img, max_side);
    fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let tmp = cache_dir.join(format!(".thumb-{}", crate::util::rand_hex(6)));
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 85)
        .encode_image(&dst)
        .map_err(|e| e.to_string())?;
    fs::write(&tmp, &buf).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &out).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(out)
}

/// 按最长边等比缩小，透明部分铺白底。
pub fn scale(src: &DynamicImage, max_side: u32) -> RgbImage {
    let (sw, sh) = (src.width(), src.height());
    let (mut dw, mut dh) = (sw, sh);
    if sw >= sh && sw > max_side {
        dw = max_side;
        dh = (sh as u64 * max_side as u64 / sw as u64).max(1) as u32;
    } else if sh > sw && sh > max_side {
        dw = (sw as u64 * max_side as u64 / sh as u64).max(1) as u32;
        dh = max_side;
    }
    let small = if (dw, dh) == (sw, sh) { src.clone() } else { src.resize_exact(dw, dh, FilterType::Triangle) };
    let rgba = small.to_rgba8();
    let mut out = RgbImage::new(dw, dh);
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let mix = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        out.put_pixel(x, y, Rgb([mix(p[0]), mix(p[1]), mix(p[2])]));
    }
    out
}
