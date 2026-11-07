//! GPT 生图工作室 —— 移动端（Android / iOS）进程内内核。
//!
//! iOS / Android 不能像桌面端那样拉起外部 sidecar 子进程，因此用纯 Rust 实现一套与 Go `imagegend`
//! **100% 兼容 `/api/*` REST + SSE 协议** 的本地服务：仅监听 127.0.0.1，随机端口 + 40 位 Bearer Token，
//! 数据与输出目录位于 App 沙盒（Tauri `app_data_dir()`）内。前端代码无需区分桌面 / 移动内核。

pub mod config;
pub mod engine;
pub mod imageapi;
pub mod log;
pub mod models;
pub mod server;
pub mod store;
pub mod thumb;
pub mod util;

use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::Arc;

pub use server::VERSION;

/// 启动参数。
#[derive(Debug, Clone)]
pub struct Options {
    /// 数据目录（groups.json / settings.json / history.json / inputs / thumbs / logs）
    pub home: PathBuf,
    /// 默认输出目录（为空则为 home/output）
    pub output_dir: Option<PathBuf>,
    /// Bearer Token（为空会拒绝所有请求）
    pub token: String,
    /// 监听端口，0 表示随机
    pub port: u16,
}

/// 生成 40 位随机 token。
pub fn random_token() -> String {
    use rand::{distributions::Alphanumeric, Rng};
    rand::thread_rng().sample_iter(&Alphanumeric).take(40).map(char::from).collect()
}

/// 同步绑定 127.0.0.1:port，并在独立线程（自带 tokio 运行时）中提供服务。返回实际端口。
pub fn start(opts: Options) -> std::io::Result<u16> {
    util::create_private_dir(&opts.home)?;
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], opts.port)))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let out = opts.output_dir.clone().unwrap_or_else(|| opts.home.join("output"));
    let _ = std::fs::create_dir_all(&out);
    let log = Arc::new(log::Logger::new(opts.home.join("logs").join("imagegend.log")));
    log.log(&format!("imagegen 移动内核 {VERSION} 启动：127.0.0.1:{port} 数据目录 {}", opts.home.display()));
    let engine = engine::Engine::new(opts.home.clone(), out);
    // 与 Go 内核一致写入 daemon.json（0600），便于浏览器调试与排障
    let info = serde_json::json!({
        "pid": std::process::id(), "port": port, "token": opts.token, "home": opts.home,
        "outputDir": engine.store.settings().output_dir, "version": VERSION,
        "startedAt": chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    });
    if let Err(e) = util::write_private(&opts.home.join("daemon.json"), serde_json::to_string_pretty(&info).unwrap().as_bytes()) {
        log.log(&format!("写入 daemon.json 失败：{e}"));
    }
    let srv = server::Server::new(opts.token, engine, log.clone());
    std::thread::Builder::new().name("imagegen-core".into()).spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .thread_name("imagegen-worker")
            .build()
            .expect("创建 tokio 运行时失败");
        rt.block_on(async move {
            let l = tokio::net::TcpListener::from_std(listener).expect("监听失败");
            if let Err(e) = axum::serve(l, srv.router()).await {
                log.log(&format!("内核服务退出：{e}"));
            }
        });
    })?;
    Ok(port)
}
