//! 桌面端专属：Go imagegend sidecar、托盘、单实例、开机自启、自动更新、关闭隐藏到托盘、macOS Dock 重新打开。

use std::net::TcpListener;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Builder, Manager, RunEvent, Window, WindowEvent, Wry,
};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

use crate::{AppState, CoreInfo};

const APP_TITLE: &str = "GPT 生图";

pub fn plugins(b: Builder<Wry>) -> Builder<Wry> {
    b.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_process::init())
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(200)).is_ok()
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(38491)
}

/// 关闭 stdin 让内核优雅退出，等待端口关闭后返回，避免安装更新时文件被占用。
pub fn stop_core(state: &AppState) -> bool {
    let child = state.child.lock().unwrap().take();
    let port = state.core.lock().unwrap().port;
    drop(child); // 关闭 stdin -> 内核优雅退出
    for _ in 0..50 {
        if !port_open(port) {
            std::thread::sleep(Duration::from_millis(300));
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

pub fn restart_core(app: &AppHandle, state: &AppState) -> bool {
    let info = state.core.lock().unwrap().clone();
    let mut guard = state.child.lock().unwrap();
    if guard.is_some() && port_open(info.port) {
        return true;
    }
    *guard = spawn_core(app, &info);
    guard.is_some()
}

pub fn set_tray_status(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("{APP_TITLE} - {text}")));
    }
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
    let (mut rx, child) = cmd.spawn().map_err(|e| eprintln!("启动内核失败: {e}")).ok()?;
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

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
    let state = app.state::<AppState>();
    let info = {
        let mut c = state.core.lock().unwrap();
        c.port = free_port();
        c.clone()
    };
    *state.child.lock().unwrap() = spawn_core(app.handle(), &info);

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
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
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
}

/// 关闭窗口时隐藏到托盘（macOS 上 Dock 图标保留，点击可重新打开），而不是退出
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
}

pub fn on_run_event(handle: &AppHandle, event: RunEvent) {
    match event {
        // macOS：窗口隐藏后点击 Dock 图标重新唤起主窗口
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows, .. } => {
            if !has_visible_windows {
                show_main(handle);
            }
        }
        RunEvent::Exit => {
            // 丢弃 CommandChild 会关闭内核 stdin，内核据此优雅退出
            if let Some(child) = handle.state::<AppState>().child.lock().unwrap().take() {
                drop(child);
                std::thread::sleep(Duration::from_millis(800));
            }
        }
        _ => {}
    }
}
