//! 简单的按大小轮转日志（5MB × 3），与 Go `internal/rotlog` 行为一致。绝不记录密钥。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Logger {
    path: PathBuf,
    max: u64,
    keep: usize,
    f: Mutex<Option<File>>,
}

impl Logger {
    pub fn new(path: PathBuf) -> Self {
        if let Some(d) = path.parent() {
            let _ = fs::create_dir_all(d);
        }
        Self { path, max: 5 << 20, keep: 3, f: Mutex::new(None) }
    }

    pub fn log(&self, msg: &str) {
        let line = format!("{} {}\n", chrono::Local::now().format("%Y/%m/%d %H:%M:%S"), msg);
        eprint!("[imagegen-mobile] {line}");
        let mut g = self.f.lock().unwrap();
        if g.is_none() {
            *g = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        }
        let size = g.as_ref().and_then(|f| f.metadata().ok()).map(|m| m.len()).unwrap_or(0);
        if size + line.len() as u64 > self.max {
            *g = None;
            for i in (1..self.keep).rev() {
                let _ = fs::rename(self.rotated(i), self.rotated(i + 1));
            }
            let _ = fs::rename(&self.path, self.rotated(1));
            *g = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        }
        if let Some(f) = g.as_mut() {
            let _ = f.write_all(line.as_bytes());
        }
    }

    fn rotated(&self, i: usize) -> PathBuf {
        PathBuf::from(format!("{}.{}", self.path.display(), i))
    }
}
