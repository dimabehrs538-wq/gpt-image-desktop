//! GPT 生图工作室 Tauri 外壳。
//!
//! - 桌面端（`cfg(desktop)`）：拉起 Go `imagegend` sidecar + 托盘 + 单实例 + 开机自启 + 自动更新。
//! - 移动端（`cfg(mobile)`，Android / iOS）：系统不允许拉起外部子进程，改为在进程内启动纯 Rust 内核
//!   `imagegen-mobile-core`（与 Go 内核 `/api/*` REST + SSE 协议 100% 兼容），数据位于 App 沙盒 `app_data_dir()`。
//!
//! 两端共用 `core_info` 命令返回 `{ port, token, platform }`，前端代码完全一致。

use std::sync::Mutex;

use rand::{distributions::Alphanumeric, Rng};
use serde::Serialize;
use tauri::{AppHandle, State};

#[cfg(desktop)]
mod desktop;

#[derive(Clone, Serialize)]
pub struct CoreInfo {
    port: u16,
    token: String,
    /// windows / macos / linux / android / ios
    platform: &'static str,
}

pub struct AppState {
    core: Mutex<CoreInfo>,
    #[cfg(desktop)]
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// 前端获取本地内核 API 地址与 token
#[tauri::command]
fn core_info(state: State<AppState>) -> CoreInfo {
    state.core.lock().unwrap().clone()
}

/// 安装更新前调用：桌面端关闭内核并等待端口释放；移动端无需处理。
#[tauri::command]
async fn stop_core(state: State<'_, AppState>) -> Result<bool, String> {
    #[cfg(desktop)]
    return Ok(desktop::stop_core(&state));
    #[cfg(mobile)]
    {
        let _ = state;
        Ok(true)
    }
}

/// 更新失败等情况下重新拉起内核（沿用相同端口与 token）
#[tauri::command]
fn restart_core(app: AppHandle, state: State<AppState>) -> bool {
    #[cfg(desktop)]
    return desktop::restart_core(&app, &state);
    #[cfg(mobile)]
    {
        let _ = (app, state);
        true
    }
}

/// 前端根据任务状态更新托盘提示（移动端没有托盘，忽略）
#[tauri::command]
fn set_tray_status(app: AppHandle, text: String) {
    #[cfg(desktop)]
    desktop::set_tray_status(&app, &text);
    #[cfg(mobile)]
    let _ = (app, text);
}

fn random_token() -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(40).map(char::from).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState {
        core: Mutex::new(CoreInfo { port: 0, token: random_token(), platform: platform() }),
        #[cfg(desktop)]
        child: Mutex::new(None),
    };

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = desktop::plugins(builder);
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![core_info, set_tray_status, stop_core, restart_core])
        .setup(|app| {
            #[cfg(desktop)]
            desktop::setup(app)?;
            #[cfg(mobile)]
            start_mobile_core(app)?;
            Ok(())
        });
    #[cfg(desktop)]
    let builder = builder.on_window_event(desktop::on_window_event);

    let app = builder.build(tauri::generate_context!()).expect("启动 Tauri 失败");
    app.run(|_handle, _event| {
        #[cfg(desktop)]
        desktop::on_run_event(_handle, _event);
    });
}

/// 移动端：在进程内启动 Rust 内核，数据与输出目录位于 App 沙盒内（完整读写权限）。
#[cfg(mobile)]
fn start_mobile_core(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    let home = app.path().app_data_dir()?;
    let state = app.state::<AppState>();
    let token = state.core.lock().unwrap().token.clone();
    let port = imagegen_mobile_core::start(imagegen_mobile_core::Options {
        output_dir: Some(home.join("output")),
        home,
        token,
        port: 0,
    })?;
    state.core.lock().unwrap().port = port;
    Ok(())
}
