//! 在桌面上运行移动端 Rust 内核，用于与 Go 内核共用同一套端到端测试（scripts/e2e.sh CORE=rust）。
//! 用法：cargo run --example serve -- serve --home DIR --api-port PORT --token TOKEN [--output-dir DIR]

use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let get = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let home = PathBuf::from(get("--home").expect("缺少 --home"));
    let opts = imagegen_mobile_core::Options {
        output_dir: get("--output-dir").map(PathBuf::from),
        token: get("--token").unwrap_or_else(imagegen_mobile_core::random_token),
        port: get("--api-port").and_then(|p| p.parse().ok()).unwrap_or(0),
        home,
    };
    let port = imagegen_mobile_core::start(opts).expect("启动失败");
    println!("imagegen 移动内核（Rust）已启动：http://127.0.0.1:{port}");
    loop {
        std::thread::park();
    }
}
