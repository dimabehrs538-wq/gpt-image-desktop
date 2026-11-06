use std::net::TcpListener;
use std::sync::Mutex;

use rand::{distributions::Alphanumeric, Rng};
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, State, WindowEvent,
};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

const APP_TITLE: &str = "GPT 生图";

#[derive(Clone, Serialize)]
struct CoreInfo {
    port: u16,
    token: String,
}

struct AppState {
    core: CoreInfo,
    child: Mutex<Option<CommandChild>>,
}

/// 前端获取本地内核 API 地址与 token
#[tauri::command]
fn core_info(state: State<AppState>) -> CoreInfo {
    state.core.clone()
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        std::time::Duration::from_millis(200),
    )
    .is_ok()
}

/// 安装更新前调用：关闭 stdin 让内核优雅退出，等待端口关闭后返回，避免安装时文件被占用。
#[tauri::command]
async fn stop_core(state: State<'_, AppState>) -> Result<bool, String> {
    let child = state.child.lock().unwrap().take();
    let port = state.core.port;
    if let Some(child) = child {
        drop(child); // 关闭 stdin -> 内核优雅退出
    }
    for _ in 0..50 {
        if !port_open(port) {
            std::thread::sleep(std::time::Duration::from_millis(300));
            return Ok(true);
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Ok(false)
}

/// 更新失败等情况下重新拉起内核（沿用相同端口与 token）
#[tauri::command]
fn restart_core(app: AppHandle, state: State<AppState>) -> bool {
    let mut guard = state.child.lock().unwrap();
    if guard.is_some() && port_open(state.core.port) {
        return true;
    }
    *guard = spawn_core(&app, &state.core);
    guard.is_some()
}

/// 前端根据任务状态更新托盘提示，例如“GPT 生图 - 空闲 / 生成中…”
#[tauri::command]
fn set_tray_status(app: AppHandle, text: String) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("{APP_TITLE} - {text}")));
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(38491)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn spawn_core(app: &AppHandle, info: &CoreInfo) -> Option<CommandChild> {
    let cmd = app.shell().sidecar("imagegend").ok()?.args([
        "serve",
        "--api-port",
        &info.port.to_string(),
        "--token",
        &info.token,
        "--exit-on-stdin-close",
    ]);
    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| eprintln!("启动内核失败: {e}"))
        .ok()?;
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(l) | CommandEvent::Stderr(l) => {
                    eprintln!("[imagegend] {}", String::from_utf8_lossy(&l).trim_end())
                }
                CommandEvent::Terminated(t) => eprintln!("[imagegend] 已退出: {:?}", t.code),
                _ => {}
            }
        }
    });
    Some(child)
}

/// 托盘图标：macOS 使用黑白模板图标（自动适配浅色 / 深色菜单栏），其它平台使用彩色图标
fn tray_icon() -> tauri::Result<tauri::image::Image<'static>> {
    #[cfg(target_os = "macos")]
    let bytes: &[u8] = include_bytes!("../icons/tray-template.png");
    #[cfg(not(target_os = "macos"))]
    let bytes: &[u8] = include_bytes!("../icons/tray.png");
    tauri::image::Image::from_bytes(bytes)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let core = CoreInfo {
        port: free_port(),
        token: rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(40)
            .map(char::from)
            .collect(),
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            core: core.clone(),
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            core_info,
            set_tray_status,
            stop_core,
            restart_core
        ])
        .setup(move |app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let handle = app.handle().clone();
            let child = spawn_core(&handle, &core);
            *app.state::<AppState>().child.lock().unwrap() = child;

            let open = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &sep, &quit])?;
            let builder = TrayIconBuilder::with_id("main")
                .icon(tray_icon()?)
                .tooltip(format!("{APP_TITLE} - 启动中"))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = e
                    {
                        show_main(tray.app_handle());
                    }
                });
            #[cfg(target_os = "macos")]
            let builder = builder.icon_as_template(true);
            builder.build(app)?;

            // 开机自启时带 --minimized，只驻留托盘
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭窗口时隐藏到托盘（macOS 上 Dock 图标保留，点击可重新打开），而不是退出
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("启动 Tauri 失败");

    app.run(|handle, event| match event {
        // macOS：窗口隐藏后点击 Dock 图标重新唤起主窗口
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                show_main(handle);
            }
        }
        RunEvent::Exit => {
            // 丢弃 CommandChild 会关闭内核 stdin，内核据此优雅退出
            if let Some(child) = handle.state::<AppState>().child.lock().unwrap().take() {
                drop(child);
                std::thread::sleep(std::time::Duration::from_millis(800));
            }
        }
        _ => {}
    });
}
