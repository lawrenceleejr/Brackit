//! The app window: a system WebView (WKWebView on macOS) pointed at the
//! embedded local server, plus native folder dialogs and window control.

use crate::server;
use serde_json::json;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

pub fn run(open: Option<String>) {
    let srv = server::App::new("tauri");
    let on_exit = srv.clone();

    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_menu).on_menu_event(|app, event| {
        // Brackit's own items: run the same command the keyboard runs
        let id = event.id().as_ref().to_string();
        if let Some(cmd) = id.strip_prefix("cmd:") {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval(&format!("window.brackitCommand && window.brackitCommand({:?})", cmd));
            }
        }
    });

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
            let mut url = format!("http://127.0.0.1:{}/?shell=tauri", port);
            if let Some(f) = &open {
                url.push_str(&format!("&open={}", f));
            }
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

// The menu bar mirrors the in-app Menu: every tool, grouped. Items carry no
// key equivalents, so keys (⌘Z, ⌘⌫, ⌘-digits, letters) still reach the page,
// where the same shortcuts are handled; Undo/Redo are left out for that reason.
#[cfg(target_os = "macos")]
fn build_menu<R: tauri::Runtime>(h: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as P, Submenu};
    let item = |id: &str, label: &str| MenuItem::with_id(h, format!("cmd:{}", id), label, true, None::<&str>);
    Menu::with_items(
        h,
        &[
            &Submenu::with_items(
                h,
                "Brackit",
                true,
                &[&P::about(h, None, None)?, &P::separator(h)?, &P::hide(h, None)?, &P::hide_others(h, None)?, &P::separator(h)?, &P::quit(h, None)?],
            )?,
            &Submenu::with_items(
                h,
                "Card",
                true,
                &[&item("open", "Choose Folder, Dates or Card…   O")?, &item("eject", "Eject Card   ⌘E")?],
            )?,
            &Submenu::with_items(h, "Edit", true, &[&P::cut(h, None)?, &P::copy(h, None)?, &P::paste(h, None)?, &P::select_all(h, None)?])?,
            &Submenu::with_items(
                h,
                "View",
                true,
                &[
                    &item("inspect", "Inspect Look   Space")?,
                    &item("zoom", "Actual Pixels   Z")?,
                    &item("overview", "Overview   G")?,
                    &P::separator(h)?,
                    &item("info", "Camera Settings & Recipe   I")?,
                    &item("histogram", "Histogram   H")?,
                    &item("brackets", "Brackets Only   B")?,
                    &P::separator(h)?,
                    &item("fullscreen", "Full Screen   F")?,
                ],
            )?,
            &Submenu::with_items(
                h,
                "Photo",
                true,
                &[
                    &item("pick1", "Pick Look 1   1")?,
                    &item("pick2", "Pick Look 2   2")?,
                    &item("pick3", "Pick Look 3   3")?,
                    &item("unpick", "Unpick This Shot   0")?,
                    &item("nextunpicked", "Next Unpicked Shot   U")?,
                    &P::separator(h)?,
                    &item("crop", "Crop & Straighten…   C")?,
                    &P::separator(h)?,
                    &item("delete", "Delete from Card   ⌘⌫")?,
                    &item("undo", "Undo Delete   ⌘Z")?,
                ],
            )?,
            &Submenu::with_items(h, "Export", true, &[&item("staged", "Show Picks   S")?, &item("export", "Export Picks   E")?])?,
            &Submenu::with_items(h, "Window", true, &[&P::minimize(h, None)?, &P::close_window(h, None)?])?,
            &Submenu::with_items(h, "Help", true, &[&item("keys", "Keyboard Shortcuts   ?")?])?,
        ],
    )
}
