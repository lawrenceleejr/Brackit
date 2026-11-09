// Brackit: review Fujifilm film-simulation brackets.
//
//   brackit                      open the app window (default build)
//   brackit --serve [folder]     terminal mode: serve the UI and open a browser
//        [--port 4870] [--no-open]
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod jpeg;
mod library;
mod server;
#[cfg(feature = "gui")]
mod gui;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!(
            "brackit — review Fujifilm film-simulation brackets\n\n\
             usage: brackit [--serve] [folder] [--port 4870] [--no-open]\n\n  \
             --serve    run in the terminal and use Brackit in your browser\n  \
             folder     SD card or folder to open (e.g. /Volumes/Untitled)\n  \
             --port     port to listen on (default 4870)\n  \
             --no-open  don't open a browser window"
        );
        return;
    }
    let serve = args.iter().any(|a| a == "--serve") || !cfg!(feature = "gui");
    if serve {
        serve_mode(&args);
    } else {
        #[cfg(feature = "gui")]
        gui::run(folder_arg(&args).map(|f| encode(&abs(&f))));
    }
}

fn serve_mode(args: &[String]) {
    let port = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(4870u16);
    let folder = folder_arg(args);
    let app = server::App::new("browser");
    let port = server::start(app.clone(), port).expect("could not start server");
    let mut url = format!("http://127.0.0.1:{}/", port);
    if let Some(f) = folder {
        url.push_str(&format!("?open={}", encode(&abs(&f))));
    }
    println!("\n  brackit  →  {}\n  ctrl-c to quit\n", url);
    if !args.iter().any(|a| a == "--no-open") {
        server::open_path(&url);
    }
    let a = app.clone();
    let _ = ctrlc::set_handler(move || {
        a.purge_deletes(); // finish any card deletions still in their undo window
        std::process::exit(0);
    });
    loop {
        std::thread::park();
    }
}

/// First positional argument (macOS may pass `-psn_…` when launched by Finder).
fn folder_arg(args: &[String]) -> Option<String> {
    args.iter()
        .enumerate()
        .find(|(i, a)| !a.starts_with('-') && !(*i > 0 && args[i - 1] == "--port"))
        .map(|(_, a)| a.clone())
}

fn abs(f: &str) -> String {
    std::fs::canonicalize(f).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| f.to_string())
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' | b'~' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}
