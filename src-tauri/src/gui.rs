//! The app window: a system WebView (WKWebView on macOS) pointed at the
//! embedded local server, plus native folder dialogs and window control.

use crate::server;
use serde_json::json;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

pub fn run() {
    let srv = server::App::new("tauri");
    let on_exit = srv.clone();

    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_menu);

    let app = builder
        .setup(move |app| {
            let h = app.handle().clone();
            let _ = srv.picker.set(Box::new(move |prompt, default| {
                let mut d = h.dialog().file().set_title(prompt);
                if let Some(p) = default {
                    d = d.set_directory(p);
                }
                d.blocking_pick_folder().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string())
            }));
            let h = app.handle().clone();
            let _ = srv.window.set(Box::new(move |cmd, body| {
                let Some(w) = h.get_webview_window("main") else { return json!({}) };
                match cmd {
                    "fullscreen" => {
                        let on = body.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
                        let _ = w.set_fullscreen(on);
                        json!({ "fullscreen": on })
                    }
                    _ => json!({ "fullscreen": w.is_fullscreen().unwrap_or(false) }),
                }
            }));

            let port = server::start(srv.clone(), 0)?;
            let url = format!("http://127.0.0.1:{}/?shell=tauri", port);
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("Brackit")
                .inner_size(1600.0, 1000.0)
                .min_inner_size(900.0, 600.0)
                .background_color(tauri::window::Color(13, 13, 12, 255));
            #[cfg(target_os = "macos")]
            let builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent).hidden_title(true);
            builder.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting Brackit");

    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            on_exit.purge_deletes(); // finish card deletions still in their undo window
        }
    });
}

// A deliberately small menu: no Undo/Redo items, so ⌘Z, ⌘⌫ and ⌘-digits
// reach the page instead of being swallowed by the menu bar.
#[cfg(target_os = "macos")]
fn build_menu<R: tauri::Runtime>(h: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, PredefinedMenuItem as P, Submenu};
    Menu::with_items(
        h,
        &[
            &Submenu::with_items(
                h,
                "Brackit",
                true,
                &[&P::about(h, None, None)?, &P::separator(h)?, &P::hide(h, None)?, &P::hide_others(h, None)?, &P::separator(h)?, &P::quit(h, None)?],
            )?,
            &Submenu::with_items(h, "Edit", true, &[&P::cut(h, None)?, &P::copy(h, None)?, &P::paste(h, None)?, &P::select_all(h, None)?])?,
            &Submenu::with_items(h, "Window", true, &[&P::minimize(h, None)?, &P::fullscreen(h, None)?, &P::close_window(h, None)?])?,
        ],
    )
}
