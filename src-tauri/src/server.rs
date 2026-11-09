//! Local HTTP server: serves the UI and a small JSON API. Shared by the app
//! window (Tauri) and the terminal/browser mode (`brackit --serve`).

use crate::jpeg;
use crate::library::{self, Library, Photo, Progress};
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Method, Request, Response, StatusCode};

static WEB: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../web");

const UNDO_MS: u64 = 10_000;
const TRASH: &str = ".brackit-trash";

pub type Picker = Box<dyn Fn(&str, Option<&str>) -> Option<String> + Send + Sync>;
pub type WindowCtl = Box<dyn Fn(&str, &Value) -> Value + Send + Sync>;

#[derive(Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct State {
    flags: Vec<String>,
    exported: Vec<String>,
    edits: serde_json::Map<String, Value>,
    last_dest: Option<String>,
    last_root: Option<String>,
    /// "name:size" of every card file ever exported (for "since last import")
    imported: Vec<String>,
    /// Library view: 0–5 stars and flags, keyed like picks (name:size:time)
    ratings: serde_json::Map<String, Value>,
    flagged: Vec<String>,
}

pub struct App {
    lib: RwLock<Library>,
    /// the export folder, browsed in the Library view
    out: RwLock<Library>,
    progress: Progress,
    out_progress: Progress,
    state: Mutex<State>,
    deleter: Deleter,
    pub shell: &'static str,
    pub picker: std::sync::OnceLock<Picker>,
    pub window: std::sync::OnceLock<WindowCtl>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}
fn state_file() -> PathBuf {
    home().join(".brackit").join("state.json")
}
fn expand(p: &str) -> PathBuf {
    if p == "~" {
        return home();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return home().join(rest);
    }
    PathBuf::from(p)
}
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl App {
    /// `?src=out` addresses the export-folder library; anything else the card.
    fn lib_for(&self, params: &HashMap<String, String>) -> &RwLock<Library> {
        if params.get("src").map(String::as_str) == Some("out") {
            &self.out
        } else {
            &self.lib
        }
    }

    pub fn new(shell: &'static str) -> Arc<App> {
        let state = fs::read(state_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Arc::new(App {
            lib: RwLock::new(Library::default()),
            out: RwLock::new(Library::default()),
            progress: Progress::default(),
            out_progress: Progress::default(),
            state: Mutex::new(state),
            deleter: Deleter::default(),
            shell,
            picker: std::sync::OnceLock::new(),
            window: std::sync::OnceLock::new(),
        })
    }

    fn save_state(&self) {
        let s = self.state.lock().unwrap();
        let path = state_file();
        let _ = fs::create_dir_all(path.parent().unwrap());
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, serde_json::to_vec(&*s).unwrap_or_default()).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }

    /// Finish any card deletions still inside their undo window.
    pub fn purge_deletes(&self) {
        self.deleter.purge_all();
    }
}

/* ------------------------------------------------------------ http plumbing */

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn send_json(req: Request, code: u16, body: Value) {
    let data = serde_json::to_vec(&body).unwrap_or_default();
    let resp = Response::from_data(data)
        .with_status_code(code)
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Cache-Control", "no-store"));
    let _ = req.respond(resp);
}

fn err(req: Request, code: u16, msg: &str) {
    send_json(req, code, json!({ "error": msg }));
}

fn read_body(req: &mut Request, limit: usize) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    req.as_reader().take(limit as u64 + 1).read_to_end(&mut buf)?;
    if buf.len() > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "too large"));
    }
    Ok(buf)
}

fn read_json(req: &mut Request) -> Value {
    read_body(req, 5_000_000).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn split_url(url: &str) -> (String, HashMap<String, String>) {
    let (path, q) = url.split_once('?').unwrap_or((url, ""));
    let mut params = HashMap::new();
    for kv in q.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        params.insert(pct_decode(k), pct_decode(v));
    }
    (pct_decode(path), params)
}

fn get_header<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str())
}

/// A Read fed from a channel: lets a worker thread stream NDJSON progress.
struct ChannelReader {
    rx: mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}
impl Read for ChannelReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        while self.pos >= self.buf.len() {
            match self.rx.recv() {
                Ok(b) => {
                    self.buf = b;
                    self.pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/* ------------------------------------------------------------ server */

pub fn start(app: Arc<App>, port: u16) -> io::Result<u16> {
    let server = tiny_http::Server::http(("127.0.0.1", port))
        .or_else(|_| tiny_http::Server::http(("127.0.0.1", 0)))
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(port);
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let app = app.clone();
            std::thread::spawn(move || handle(app, req));
        }
    });
    Ok(port)
}

fn handle(app: Arc<App>, req: Request) {
    // Only accept requests addressed to this machine (blocks DNS rebinding).
    let host = get_header(&req, "Host").unwrap_or("").split(':').next().unwrap_or("").to_string();
    if host != "127.0.0.1" && host != "localhost" {
        return err(req, 403, "forbidden host");
    }
    let (path, params) = split_url(req.url());
    if path.starts_with("/api/") {
        // Only Brackit's own page may use the API: a web page elsewhere can't
        // send this header without a CORS preflight, which we never grant,
        // and a foreign Origin is refused outright.
        let port = get_header(&req, "Host").and_then(|h| h.rsplit_once(':')).map(|(_, p)| p.to_string()).unwrap_or_default();
        if let Some(origin) = get_header(&req, "Origin") {
            let own = [format!("http://127.0.0.1:{}", port), format!("http://localhost:{}", port)];
            if !own.iter().any(|o| o == origin) {
                return err(req, 403, "forbidden origin");
            }
        }
        if *req.method() != Method::Get && get_header(&req, "X-Brackit") != Some("1") {
            return err(req, 403, "missing X-Brackit header");
        }
        api(&app, req, &path, &params);
    } else {
        serve_static(req, &path);
    }
}

fn serve_static(req: Request, path: &str) {
    let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
    if rel.contains("..") {
        return err(req, 403, "forbidden");
    }
    match WEB.get_file(rel) {
        Some(f) => {
            let mime = match Path::new(rel).extension().and_then(|e| e.to_str()).unwrap_or("") {
                "html" => "text/html; charset=utf-8",
                "js" => "text/javascript; charset=utf-8",
                "css" => "text/css; charset=utf-8",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                _ => "application/octet-stream",
            };
            let resp = Response::from_data(f.contents().to_vec())
                .with_header(header("Content-Type", mime))
                .with_header(header("Cache-Control", "no-cache"));
            let _ = req.respond(resp);
        }
        None => err(req, 404, "not found"),
    }
}

fn api(app: &Arc<App>, mut req: Request, path: &str, params: &HashMap<String, String>) {
    let method = req.method().clone();
    let get = method == Method::Get;
    let post = method == Method::Post;
    let put = method == Method::Put;

    if get {
        if let Some(id) = path.strip_prefix("/api/meta/") {
            // every tag + focus point / faces, for the metadata list and annotations
            let file = app.lib_for(params).read().unwrap().photos.get(id).filter(|p| !p.video).map(|p| p.file.clone());
            return match file {
                Some(f) => send_json(req, 200, crate::jpeg::all_metadata(&f)),
                None => err(req, 404, "not found"),
            };
        }
        if let Some(id) = path.strip_prefix("/api/info/") {
            // camera settings + film recipe, read on demand (not at scan time)
            let file = app.lib_for(params).read().unwrap().photos.get(id).filter(|p| !p.video).map(|p| p.file.clone());
            return match file {
                Some(f) => {
                    let rows: Vec<Value> = crate::jpeg::shot_info(&f).into_iter().map(|(k, v)| json!([k, v])).collect();
                    send_json(req, 200, json!({ "rows": rows }))
                }
                None => err(req, 404, "not found"),
            };
        }
        if path == "/api/thumbs" {
            let photos: Vec<Photo> = {
                let lib = app.lib_for(params).read().unwrap();
                params
                    .get("ids")
                    .map(|ids| ids.split(',').filter_map(|id| lib.photos.get(id)).filter(|p| !p.video).take(200).cloned().collect())
                    .unwrap_or_default()
            };
            return serve_thumbs(req, photos);
        }
        if let Some(id) = path.strip_prefix("/api/img/") {
            let photo = app.lib_for(params).read().unwrap().photos.get(id).cloned();
            return match photo {
                Some(p) if p.video => serve_video(req, &p),
                Some(p) => {
                    let flag = |k: &str| params.get(k).map(|v| v == "1").unwrap_or(false);
                    serve_image(req, &p, if flag("full") { Size::Full } else if flag("thumb") { Size::Thumb } else { Size::Preview })
                }
                None => err(req, 404, "not found"),
            };
        }
    }

    match (path, get, post, put) {
        ("/api/state", true, _, _) => {
            let s = app.state.lock().unwrap();
            let lib = app.lib.read().unwrap();
            let h = home();
            send_json(
                req,
                200,
                json!({
                    "root": lib.root.as_ref().map(|r| r.to_string_lossy()),
                    "lastRoot": s.last_root, "lastDest": s.last_dest,
                    "flags": s.flags, "edits": s.edits, "exported": s.exported,
                    "ratings": s.ratings, "flagged": s.flagged,
                    "canPick": app.picker.get().is_some() || cfg!(target_os = "macos"),
                    "shell": app.shell,
                    "home": h.to_string_lossy(),
                    "defaultDest": h.join("Pictures").join("Brackit").to_string_lossy(),
                    "platform": std::env::consts::OS.replace("macos", "darwin"),
                }),
            )
        }
        ("/api/volumes", true, _, _) => send_json(req, 200, json!({ "volumes": list_volumes() })),
        ("/api/progress", true, _, _) => send_json(
            req,
            200,
            json!({
                "scanning": app.progress.scanning.load(Ordering::SeqCst),
                "done": app.progress.done.load(Ordering::SeqCst),
                "total": app.progress.total.load(Ordering::SeqCst),
            }),
        ),
        ("/api/library", true, _, _) => {
            let body = summary(&app.lib.read().unwrap());
            send_json(req, 200, body)
        }
        ("/api/dest", true, _, _) => {
            // what's already in the export folder (top level only)
            let dir = expand(params.get("path").map(String::as_str).unwrap_or(""));
            let mut files: Vec<(String, u64, f64)> = Vec::new();
            if let Ok(rd) = fs::read_dir(&dir) {
                for e in rd.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') || !(library::is_jpeg(&name) || library::is_video(&name) || library::is_raw(&name)) {
                        continue;
                    }
                    let Ok(md) = e.metadata() else { continue };
                    if !md.is_file() {
                        continue;
                    }
                    let ms = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0);
                    files.push((name, md.len(), ms));
                }
            }
            files.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.0.cmp(&b.0)));
            let files: Vec<Value> = files
                .into_iter()
                .map(|(name, size, mtime)| {
                    let kind = if library::is_video(&name) { "video" } else if library::is_raw(&name) { "raw" } else { "photo" };
                    json!({ "name": name, "size": size, "mtime": mtime, "kind": kind })
                })
                .collect();
            send_json(req, 200, json!({ "dir": dir.to_string_lossy(), "exists": dir.is_dir(), "files": files }))
        }
        ("/api/dest-img", true, _, _) => {
            // small preview of a file in the export folder
            let dir = expand(params.get("path").map(String::as_str).unwrap_or(""));
            let name = params.get("name").cloned().unwrap_or_default();
            if name.is_empty() || name.contains('/') || name.contains('\\') || name.starts_with('.') || !library::is_jpeg(&name) {
                return err(req, 400, "bad name");
            }
            let file = dir.join(&name);
            let Ok(md) = fs::metadata(&file) else { return err(req, 404, "not found") };
            let meta = crate::jpeg::read_meta(&file).unwrap_or_default();
            let p = Photo {
                size: md.len(),
                orientation: meta.orientation.max(1),
                preview: meta.preview.filter(|(s, _)| crate::jpeg::valid_preview(&file, *s)),
                thumb: meta.thumb,
                file,
                name,
                ..Default::default()
            };
            serve_image(req, &p, Size::Thumb)
        }
        ("/api/eject", _, true, _) => {
            let body = read_json(&mut req);
            let Some(p) = body.get("path").and_then(Value::as_str).map(expand) else { return err(req, 400, "no path") };
            let Some(vol) = volume_of(&p).filter(|v| v["ejectable"] == true) else {
                return err(req, 400, "That folder isn't on a removable card");
            };
            let mount = PathBuf::from(vol["path"].as_str().unwrap_or_default());
            // finish deletions still in their undo window, and let go of the card
            app.deleter.purge_all();
            match eject(&mount) {
                Ok(()) => {
                    let mut lib = app.lib.write().unwrap();
                    if lib.root.as_ref().map_or(false, |r| r.starts_with(&mount)) {
                        *lib = Library::default();
                    }
                    drop(lib);
                    send_json(req, 200, json!({ "ok": true, "name": vol["name"], "path": vol["path"] }))
                }
                Err(e) => err(req, 409, &e),
            }
        }
        ("/api/out/open", _, true, _) => {
            // scan the export folder (recursively) for the Library view
            let body = read_json(&mut req);
            let Some(p) = body.get("path").and_then(Value::as_str).map(expand) else { return err(req, 400, "Folder not found") };
            let p = fs::canonicalize(&p).unwrap_or(p);
            if !p.is_dir() {
                return err(req, 404, "The export folder doesn't exist yet — export something first");
            }
            let Some(lib) = library::scan(&p, &library::Scope::default(), &app.out_progress) else {
                return err(req, 409, "superseded by a newer scan");
            };
            let body = summary(&lib);
            *app.out.write().unwrap() = lib;
            send_json(req, 200, body)
        }
        ("/api/rate", _, true, _) => {
            // {key, stars?: 0-5, flag?: bool}
            let body = read_json(&mut req);
            let Some(key) = body.get("key").and_then(Value::as_str).map(String::from) else { return err(req, 400, "no key") };
            {
                let mut s = app.state.lock().unwrap();
                if let Some(st) = body.get("stars").and_then(Value::as_u64) {
                    if st == 0 {
                        s.ratings.remove(&key);
                    } else {
                        s.ratings.insert(key.clone(), st.min(5).into());
                    }
                }
                if let Some(f) = body.get("flag").and_then(Value::as_bool) {
                    s.flagged.retain(|k| k != &key);
                    if f {
                        s.flagged.push(key.clone());
                    }
                }
            }
            app.save_state();
            send_json(req, 200, json!({ "ok": true }))
        }
        ("/api/out/trash", _, true, _) => {
            // move files from the export folder to the system Trash / Recycle Bin
            let body = read_json(&mut req);
            let photos: Vec<Photo> = {
                let lib = app.out.read().unwrap();
                body.get("ids")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|v| v.as_str()).filter_map(|id| lib.photos.get(id).cloned()).collect())
                    .unwrap_or_default()
            };
            let mut moved = Vec::new();
            let mut failed = Vec::new();
            for p in &photos {
                match trash::delete(&p.file) {
                    Ok(()) => moved.push(p.id.clone()),
                    Err(e) => failed.push(json!({ "name": p.name, "error": e.to_string() })),
                }
            }
            {
                let mut lib = app.out.write().unwrap();
                for id in &moved {
                    lib.photos.remove(id);
                }
                for set in lib.sets.iter_mut() {
                    set.photos.retain(|id| !moved.contains(id));
                }
                lib.sets.retain(|s| !s.photos.is_empty());
            }
            send_json(req, 200, json!({ "moved": moved, "failed": failed }))
        }
        ("/api/survey", _, true, _) => {
            let body = read_json(&mut req);
            let Some(p) = body.get("path").and_then(Value::as_str).map(expand) else { return err(req, 400, "Folder not found") };
            let p = fs::canonicalize(&p).unwrap_or(p);
            if !p.is_dir() {
                return err(req, 400, "Folder not found");
            }
            let imported: std::collections::HashSet<String> = app.state.lock().unwrap().imported.iter().cloned().collect();
            let mut sv = library::survey(&p, &imported);
            sv["volume"] = json!(volume_of(&p));
            send_json(req, 200, sv)
        }
        ("/api/open", _, true, _) => {
            let body = read_json(&mut req);
            let Some(p) = body.get("path").and_then(Value::as_str).map(expand) else { return err(req, 400, "Folder not found") };
            let p = fs::canonicalize(&p).unwrap_or(p);
            if !p.is_dir() {
                return err(req, 400, "Folder not found");
            }
            let s = |k: &str| body.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).map(String::from);
            let scope = library::Scope { folder: s("folder"), from: s("from"), to: s("to"), after: body.get("after").and_then(Value::as_f64) };
            // leftovers from a session that quit mid-undo window: finish that delete
            app.deleter.purge_stale(&p);
            app.progress.scanning.store(true, Ordering::SeqCst);
            let Some(lib) = library::scan(&p, &scope, &app.progress) else {
                return err(req, 409, "superseded by a newer scan");
            };
            app.progress.scanning.store(false, Ordering::SeqCst);
            let body = summary(&lib);
            *app.lib.write().unwrap() = lib;
            app.state.lock().unwrap().last_root = Some(p.to_string_lossy().to_string());
            app.save_state();
            send_json(req, 200, body)
        }
        ("/api/pick", _, true, _) => {
            let body = read_json(&mut req);
            let prompt = body.get("prompt").and_then(Value::as_str).unwrap_or("Choose a folder").to_string();
            let default = body.get("defaultPath").and_then(Value::as_str).map(String::from);
            let picked = match app.picker.get() {
                Some(f) => f(&prompt, default.as_deref()),
                None => mac_choose_folder(&prompt),
            };
            send_json(req, 200, json!({ "path": picked }))
        }
        ("/api/flags", _, _, true) => {
            let body = read_json(&mut req);
            let Some(arr) = body.get("flags").and_then(Value::as_array) else { return err(req, 400, "flags must be an array") };
            app.state.lock().unwrap().flags = arr.iter().filter_map(|v| v.as_str().map(String::from)).collect();
            app.save_state();
            send_json(req, 200, json!({ "ok": true }))
        }
        ("/api/edits", _, _, true) => {
            let body = read_json(&mut req);
            let Some(map) = body.get("edits").and_then(Value::as_object) else { return err(req, 400, "edits must be an object") };
            app.state.lock().unwrap().edits = map.clone();
            app.save_state();
            send_json(req, 200, json!({ "ok": true }))
        }
        ("/api/reveal", _, true, _) => {
            let body = read_json(&mut req);
            if let Some(p) = body.get("path").and_then(Value::as_str) {
                let p = expand(p);
                if body.get("select").and_then(Value::as_bool).unwrap_or(false) {
                    reveal_file(&p);
                } else {
                    open_path(&p.to_string_lossy());
                }
            }
            send_json(req, 200, json!({ "ok": true }))
        }
        ("/api/window", _, true, _) => {
            let body = read_json(&mut req);
            let out = match app.window.get() {
                Some(w) => w(body.get("cmd").and_then(Value::as_str).unwrap_or(""), &body),
                None => json!({ "unsupported": true }),
            };
            send_json(req, 200, out)
        }
        ("/api/export", _, true, _) => export(app.clone(), req),
        ("/api/export-edited", _, true, _) => export_edited(app, req, params),
        ("/api/delete", _, true, _) => {
            let body = read_json(&mut req);
            let (root, photos) = {
                let lib = app.lib.read().unwrap();
                let ids = body.get("ids").and_then(Value::as_array).cloned().unwrap_or_default();
                let photos: Vec<Photo> = ids
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from).or_else(|| v.as_u64().map(|n| n.to_string())))
                    .filter_map(|id| lib.photos.get(&id).cloned())
                    .collect();
                (lib.root.clone(), photos)
            };
            let Some(root) = root.filter(|_| !photos.is_empty()) else { return err(req, 400, "Nothing to delete") };
            let keep_raw = body.get("keepRaw").and_then(Value::as_bool).unwrap_or(false);
            let photos: Vec<Photo> = if keep_raw { photos.into_iter().map(|p| Photo { raw: None, ..p }).collect() } else { photos };
            match app.deleter.remove(&root, &photos) {
                Ok(token) => send_json(req, 200, json!({ "token": token, "undoMs": UNDO_MS })),
                Err(e) => err(req, 500, &e),
            }
        }
        ("/api/undo-delete", _, true, _) => {
            let body = read_json(&mut req);
            let token = body.get("token").and_then(Value::as_str).unwrap_or("");
            if app.deleter.undo(token) {
                send_json(req, 200, json!({ "ok": true }))
            } else {
                err(req, 410, "Too late to undo — the files are gone")
            }
        }
        _ => err(req, 404, "not found"),
    }
}

fn summary(lib: &Library) -> Value {
    let volume = lib.root.as_deref().and_then(volume_of);
    let photos: serde_json::Map<String, Value> =
        lib.photos.iter().map(|(id, p)| (id.clone(), serde_json::to_value(p.public()).unwrap_or(Value::Null))).collect();
    json!({
        "root": lib.root.as_ref().map(|r| r.to_string_lossy()),
        "scope": { "folder": lib.scope.folder, "from": lib.scope.from, "to": lib.scope.to, "after": lib.scope.after },
        "volume": volume,
        "sets": lib.sets,
        "photos": photos,
    })
}

/* ------------------------------------------------------------ media */

/// Read an embedded JPEG (thumbnail or preview) out of the file, with the
/// parent photo's orientation grafted on so browsers rotate it.
fn embedded_jpeg(p: &Photo, (start, len): (u64, u64)) -> Option<Vec<u8>> {
    // offsets come from the file's own header: don't trust them blindly
    if len < 4 || len > 64 * 1024 * 1024 || start.checked_add(len)? > p.size {
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    File::open(&p.file)
        .and_then(|mut f| {
            f.seek(SeekFrom::Start(start))?;
            f.read_exact(&mut buf)
        })
        .ok()?;
    if buf[0] != 0xff || buf[1] != 0xd8 {
        return None; // not a JPEG where the header said: caller falls back
    }
    if p.orientation != 1 && buf.len() > 2 {
        let seg = jpeg::orientation_segment(p.orientation);
        let mut out = Vec::with_capacity(buf.len() + seg.len());
        out.extend_from_slice(&buf[..2]);
        out.extend_from_slice(&seg);
        out.extend_from_slice(&buf[2..]);
        buf = out;
    }
    Some(buf)
}

/// Many thumbnails in one response, so a whole card's worth can be fetched
/// in a few requests. Format: one JSON line `[[id, length], …]`, a newline,
/// then the JPEGs back to back in that order.
fn serve_thumbs(req: Request, photos: Vec<Photo>) {
    let mut index = Vec::with_capacity(photos.len());
    let mut body = Vec::new();
    for p in &photos {
        if let Some(jpg) = p.thumb.or(p.preview).and_then(|r| embedded_jpeg(p, r)) {
            index.push(json!([p.id, jpg.len()]));
            body.extend_from_slice(&jpg);
        }
    }
    let mut out = serde_json::to_vec(&index).unwrap_or_default();
    out.push(b'\n');
    out.extend_from_slice(&body);
    let resp = Response::from_data(out)
        .with_header(header("Content-Type", "application/octet-stream"))
        .with_header(header("Cache-Control", "no-store"));
    let _ = req.respond(resp);
}

#[derive(PartialEq)]
enum Size {
    Thumb,
    Preview,
    Full,
}

fn serve_image(req: Request, p: &Photo, size: Size) {
    let cache = header("Cache-Control", "private, max-age=3600");
    let jpeg_type = header("Content-Type", "image/jpeg");
    // embedded JPEGs: the ~160px EXIF thumbnail or the ~1920px MPF preview
    let range = match size {
        Size::Thumb => p.thumb.or(p.preview),
        Size::Preview => p.preview,
        Size::Full => None,
    };
    if let Some(buf) = range.and_then(|r| embedded_jpeg(p, r)) {
        let _ = req.respond(Response::from_data(buf).with_header(jpeg_type).with_header(cache));
        return;
    }
    // (no usable embedded image: the original itself)
    match File::open(&p.file) {
        Ok(f) => {
            let resp = Response::new(StatusCode(200), vec![jpeg_type, cache], f, Some(p.size as usize), None);
            let _ = req.respond(resp);
        }
        Err(_) => err(req, 404, "not found"),
    }
}

// Byte-range streaming so <video> can seek (Safari/WebKit requires it).
fn serve_video(req: Request, p: &Photo) {
    let size = p.size;
    let mime = if library::is_video(&p.name) && p.name.to_ascii_lowercase().ends_with(".mov") {
        if cfg!(feature = "gui") && cfg!(target_os = "macos") { "video/quicktime" } else { "video/mp4" }
    } else {
        "video/mp4"
    };
    let Ok(mut f) = File::open(&p.file) else { return err(req, 404, "not found") };
    let range = get_header(&req, "Range").and_then(|r| r.strip_prefix("bytes=")).map(String::from);
    let mut headers = vec![header("Content-Type", mime), header("Accept-Ranges", "bytes")];
    let Some(r) = range else {
        let _ = req.respond(Response::new(StatusCode(200), headers, f, Some(size as usize), None));
        return;
    };
    let (a, b) = r.split_once('-').unwrap_or((&r, ""));
    let (start, end) = match (a.parse::<u64>().ok(), b.parse::<u64>().ok()) {
        (Some(s), Some(e)) => (s, e.min(size.saturating_sub(1))),
        (Some(s), None) => (s, size.saturating_sub(1)),
        (None, Some(n)) => (size.saturating_sub(n), size.saturating_sub(1)),
        _ => (0, size.saturating_sub(1)),
    };
    if start >= size || start > end {
        headers.push(header("Content-Range", &format!("bytes */{}", size)));
        let _ = req.respond(Response::new(StatusCode(416), headers, io::empty(), Some(0), None));
        return;
    }
    if f.seek(SeekFrom::Start(start)).is_err() {
        return err(req, 500, "seek failed");
    }
    let len = end - start + 1;
    headers.push(header("Content-Range", &format!("bytes {}-{}/{}", start, end, size)));
    let _ = req.respond(Response::new(StatusCode(206), headers, f.take(len), Some(len as usize), None));
}

/* ------------------------------------------------------------ export */

/// Next free name in `dir`; if a same-sized file already has the name, that's
/// treated as "already exported" and returned with exists=true.
/// Next free name in `dir`. A file already there counts as "this one" only if
/// both size and modification time match (FAT stores times to 2 s): file
/// numbers repeat across cameras and counter resets, and uncompressed RAWs
/// are all the same size.
fn unique_dest(dir: &Path, name: &str, size: u64, mtime: f64) -> io::Result<(PathBuf, bool)> {
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{}", e)).unwrap_or_default();
    for i in 0..1000 {
        let cand = dir.join(if i == 0 { name.to_string() } else { format!("{}-{}{}", stem, i, ext) });
        match fs::metadata(&cand) {
            Ok(md) if md.len() == size && same_time(&md, mtime) => return Ok((cand, true)),
            Ok(_) => continue,
            Err(_) => return Ok((cand, false)),
        }
    }
    Err(io::Error::new(io::ErrorKind::Other, "too many name collisions"))
}

fn same_time(md: &fs::Metadata, ms: f64) -> bool {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(false, |d| (d.as_millis() as f64 - ms).abs() <= 2000.0)
}

/// Write via a hidden temporary name, renamed into place when complete, so
/// an interrupted export never leaves a truncated file that looks finished.
fn partial_path(target: &Path) -> PathBuf {
    let name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    target.with_file_name(format!(".{}.partial", name))
}

fn set_mtime(path: &Path, ms: f64) {
    if let Ok(f) = OpenOptions::new().write(true).open(path) {
        let _ = f.set_modified(UNIX_EPOCH + Duration::from_millis(ms as u64));
    }
}

fn copy_one(p: &Photo, dest: &Path) -> io::Result<bool> {
    let (target, exists) = unique_dest(dest, &p.name, p.size, p.mtime)?;
    if exists {
        return Ok(false);
    }
    let tmp = partial_path(&target);
    let mut src = File::open(&p.file)?;
    let mut out = OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
    let r = io::copy(&mut src, &mut out).and_then(|_| out.sync_all());
    drop(out);
    if let Err(e) = r {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    set_mtime(&tmp, p.mtime);
    fs::rename(&tmp, &target)?;
    Ok(true)
}

fn export(app: Arc<App>, mut req: Request) {
    let body = read_json(&mut req);
    let Some(dest) = body.get("dest").and_then(Value::as_str).map(expand) else { return err(req, 400, "No destination") };
    let photos: Vec<Photo> = {
        let lib = app.lib.read().unwrap();
        body.get("ids")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str()).filter_map(|id| lib.photos.get(id).cloned()).collect())
            .unwrap_or_default()
    };
    // RAW files to copy too (one per set; several picks can share it)
    let raws: Vec<Photo> = {
        let lib = app.lib.read().unwrap();
        let mut seen = std::collections::HashSet::new();
        body.get("rawFor")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .filter_map(|id| lib.photos.get(id))
                    .filter_map(|p| {
                        let raw = p.raw.clone()?;
                        if !seen.insert(raw.clone()) {
                            return None;
                        }
                        Some(Photo {
                            name: raw.file_name()?.to_string_lossy().to_string(),
                            size: p.raw_size,
                            mtime: fs::metadata(&raw).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(p.mtime),
                            file: raw,
                            key: String::new(),
                            ..Default::default()
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let photos: Vec<Photo> = photos.into_iter().chain(raws).collect();
    if let Err(e) = fs::create_dir_all(&dest) {
        return err(req, 500, &e.to_string());
    }
    app.state.lock().unwrap().last_dest = Some(dest.to_string_lossy().to_string());
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let worker_app = app.clone();
    std::thread::spawn(move || {
        let (mut copied, mut skipped) = (0, 0);
        let mut failed = Vec::new();
        let mut done_keys = Vec::new();
        let mut imported = Vec::new();
        let total = photos.len();
        for (i, p) in photos.iter().enumerate() {
            match copy_one(p, &dest) {
                Ok(true) => copied += 1,
                Ok(false) => skipped += 1,
                Err(e) => failed.push(json!({ "name": p.name, "error": e.to_string() })),
            }
            if !p.key.is_empty() && failed.last().map_or(true, |f| f["name"] != p.name) {
                done_keys.push(p.key.clone());
                imported.push(format!("{}:{}", p.name, p.size));
            }
            let _ = tx.send(format!("{}\n", json!({ "done": i + 1, "total": total, "name": p.name })).into_bytes());
        }
        {
            let mut s = worker_app.state.lock().unwrap();
            for k in done_keys {
                if !s.exported.contains(&k) {
                    s.exported.push(k);
                }
            }
            for k in imported {
                if !s.imported.contains(&k) {
                    s.imported.push(k);
                }
            }
        }
        worker_app.save_state();
        let _ = tx.send(
            format!(
                "{}\n",
                json!({ "finished": true, "copied": copied, "skipped": skipped, "failed": failed, "dest": dest.to_string_lossy() })
            )
            .into_bytes(),
        );
    });
    let reader = ChannelReader { rx, buf: Vec::new(), pos: 0 };
    let resp = Response::new(
        StatusCode(200),
        vec![header("Content-Type", "application/x-ndjson"), header("Cache-Control", "no-store")],
        reader,
        None,
        None,
    );
    let _ = req.respond(resp);
}

// Body: the edited JPEG rendered by the UI. We restore the camera's EXIF
// (incl. film simulation) and write it next to the plain copies.
fn export_edited(app: &Arc<App>, mut req: Request, params: &HashMap<String, String>) {
    let photo = params.get("id").and_then(|id| app.lib.read().unwrap().photos.get(id).cloned());
    let (Some(photo), Some(dest)) = (photo, params.get("dest").map(|d| expand(d))) else { return err(req, 400, "bad request") };
    let w = params.get("w").and_then(|v| v.parse().ok()).unwrap_or(0);
    let h = params.get("h").and_then(|v| v.parse().ok()).unwrap_or(0);
    let Ok(body) = read_body(&mut req, 512_000_000) else { return err(req, 400, "bad body") };
    if body.len() < 4 || body[0] != 0xff || body[1] != 0xd8 {
        return err(req, 400, "not a jpeg");
    }
    let seg = jpeg::exif_for_edited(&photo.file, w, h);
    let out = jpeg::graft_segment(&body, seg.as_deref());
    let result = (|| -> io::Result<(PathBuf, bool)> {
        fs::create_dir_all(&dest)?;
        let (target, exists) = unique_dest(&dest, &photo.name, out.len() as u64, photo.mtime)?;
        if !exists {
            let tmp = partial_path(&target);
            let mut f = OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
            f.write_all(&out)?;
            f.sync_all()?;
            drop(f);
            set_mtime(&tmp, photo.mtime);
            fs::rename(&tmp, &target)?;
        }
        Ok((target, exists))
    })();
    match result {
        Ok((target, exists)) => {
            {
                let mut s = app.state.lock().unwrap();
                s.last_dest = Some(dest.to_string_lossy().to_string());
                if !s.exported.contains(&photo.key) {
                    s.exported.push(photo.key.clone());
                }
                let k = format!("{}:{}", photo.name, photo.size);
                if !s.imported.contains(&k) {
                    s.imported.push(k);
                }
            }
            app.save_state();
            send_json(req, 200, json!({ "ok": true, "skipped": exists, "path": target.to_string_lossy() }))
        }
        Err(e) => err(req, 500, &e.to_string()),
    }
}

/* ------------------------------------------------------------ delete with undo */

/// Deleting from the card is permanent, so it happens in two steps: files are
/// renamed (instant, same volume) into a hidden holding folder on the card,
/// then removed for good after UNDO_MS unless undone. Quitting finishes any
/// pending delete; a crash leaves it to be finished on the card's next open.
#[derive(Default)]
struct Deleter {
    pending: Arc<Mutex<HashMap<String, Job>>>,
    seq: Mutex<u64>,
}

struct Job {
    root: PathBuf,
    dir: PathBuf,
    moves: Vec<(PathBuf, PathBuf)>,
}

fn cleanup_trash_root(root: &Path) {
    let _ = fs::remove_dir(root.join(TRASH)); // only succeeds when empty
}

fn purge_job(job: Job) {
    let _ = fs::remove_dir_all(&job.dir);
    cleanup_trash_root(&job.root);
}

impl Deleter {
    fn remove(&self, root: &Path, photos: &[Photo]) -> Result<String, String> {
        let token = {
            let mut s = self.seq.lock().unwrap();
            *s += 1;
            format!("{:x}-{}", now_ms(), *s)
        };
        let dir = root.join(TRASH).join(&token);
        let mut moves: Vec<(PathBuf, PathBuf)> = Vec::new();
        let mut seen_raw = std::collections::HashSet::new();
        let mut run = || -> io::Result<()> {
            for p in photos {
                let mut files = vec![p.file.clone()];
                // the RAW is another version of the same photo: it goes too
                if let Some(raw) = &p.raw {
                    if seen_raw.insert(raw.clone()) && raw.exists() {
                        files.push(raw.clone());
                    }
                }
                let dot = p.dir.join(format!("._{}", p.name)); // macOS AppleDouble sidecar
                if dot.exists() {
                    files.push(dot);
                }
                for from in files {
                    let rel = from.strip_prefix(root).unwrap_or(&from).to_path_buf();
                    let to = dir.join(rel);
                    fs::create_dir_all(to.parent().unwrap())?;
                    fs::rename(&from, &to)?;
                    moves.push((from, to));
                }
            }
            Ok(())
        };
        if let Err(e) = run() {
            for (from, to) in moves.iter().rev() {
                let _ = fs::rename(to, from);
            }
            let _ = fs::remove_dir_all(&dir);
            cleanup_trash_root(root);
            return Err(match e.kind() {
                io::ErrorKind::PermissionDenied => "The card is locked or read-only".into(),
                _ if e.raw_os_error() == Some(30) => "The card is locked or read-only".into(), // EROFS
                _ => e.to_string(),
            });
        }
        self.pending.lock().unwrap().insert(token.clone(), Job { root: root.to_path_buf(), dir, moves });
        let pending = self.pending.clone();
        let t = token.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(UNDO_MS));
            let job = pending.lock().unwrap().remove(&t);
            if let Some(job) = job {
                purge_job(job);
            }
        });
        Ok(token)
    }

    /// Put the files back. Reports failure (and keeps what's left in the
    /// holding folder) if any of them can't be restored.
    fn undo(&self, token: &str) -> bool {
        let Some(job) = self.pending.lock().unwrap().remove(token) else { return false };
        let mut ok = true;
        for (from, to) in &job.moves {
            if fs::rename(to, from).is_err() {
                ok = false;
            }
        }
        if ok {
            let _ = fs::remove_dir_all(&job.dir);
            cleanup_trash_root(&job.root);
        }
        ok
    }

    /// Leftovers from a session that quit (or crashed) mid-undo-window: finish
    /// those deletes, but never touch a delete that can still be undone.
    fn purge_stale(&self, root: &Path) {
        let live: Vec<PathBuf> = self.pending.lock().unwrap().values().map(|j| j.dir.clone()).collect();
        if let Ok(rd) = fs::read_dir(root.join(TRASH)) {
            for e in rd.flatten() {
                if !live.contains(&e.path()) {
                    let _ = fs::remove_dir_all(e.path());
                }
            }
        }
        cleanup_trash_root(root);
    }

    fn purge_all(&self) {
        let jobs: Vec<Job> = self.pending.lock().unwrap().drain().map(|(_, j)| j).collect();
        for j in jobs {
            purge_job(j);
        }
    }
}

/* ------------------------------------------------------------ platform */

fn list_volumes() -> Vec<Value> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        roots.push("/Volumes".into());
    } else if cfg!(target_os = "linux") {
        let user = std::env::var("USER").unwrap_or_default();
        roots.extend([format!("/media/{}", user), format!("/run/media/{}", user), "/mnt".into(), "/media".into()].map(PathBuf::from));
    } else if cfg!(windows) {
        for c in b'D'..=b'Z' {
            let p = PathBuf::from(format!("{}:\\", c as char));
            if p.join("DCIM").is_dir() {
                return vec![json!({ "name": format!("{}:", c as char), "path": p.to_string_lossy() })];
            }
        }
    }
    let mut out = Vec::new();
    for r in roots {
        let Ok(rd) = fs::read_dir(&r) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.join("DCIM").is_dir() {
                let ejectable = volume_of(&p).map_or(false, |v| v["ejectable"] == true);
                out.push(json!({ "name": e.file_name().to_string_lossy(), "path": p.to_string_lossy(), "ejectable": ejectable }));
            }
        }
    }
    out
}

/// The removable volume a path lives on, if any: {path, name, ejectable}.
/// Internal disks and ordinary folders return ejectable=false (or None).
fn volume_of(path: &Path) -> Option<Value> {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if cfg!(target_os = "macos") {
        // /Volumes/<name>/… (the boot disk's /Volumes entry resolves to "/")
        let rel = path.strip_prefix("/Volumes").ok()?;
        let name = rel.components().next()?.as_os_str().to_string_lossy().to_string();
        let mount = Path::new("/Volumes").join(&name);
        let info = std::process::Command::new("diskutil").args(["info", "-plist"]).arg(&mount).output().ok()?;
        let plist = String::from_utf8_lossy(&info.stdout);
        let flag = |k: &str| {
            plist
                .split(&format!("<key>{}</key>", k))
                .nth(1)
                .map_or(false, |rest| rest.trim_start().starts_with("<true/>"))
        };
        let ejectable = flag("Ejectable") || flag("RemovableMedia") || flag("Removable");
        return Some(json!({ "path": mount.to_string_lossy(), "name": name, "ejectable": ejectable }));
    }
    if cfg!(target_os = "linux") {
        let out = std::process::Command::new("findmnt").args(["-n", "-o", "TARGET", "--target"]).arg(&path).output().ok()?;
        let mount = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if mount.is_empty() {
            return None;
        }
        let ejectable = mount.starts_with("/media/") || mount.starts_with("/run/media/");
        let name = Path::new(&mount).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        return Some(json!({ "path": mount, "name": name, "ejectable": ejectable }));
    }
    None
}

fn eject(mount: &Path) -> Result<(), String> {
    let run = |cmd: &str, args: &[&str]| -> Result<(), String> {
        let out = std::process::Command::new(cmd).args(args).arg(mount).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let msg = if msg.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { msg };
            Err(if msg.is_empty() { "The card couldn't be ejected".into() } else { msg })
        }
    };
    if cfg!(target_os = "macos") {
        run("diskutil", &["eject"])
    } else if cfg!(target_os = "linux") {
        run("gio", &["mount", "-e"]).or_else(|_| run("umount", &[]))
    } else {
        Err("Eject isn't supported on this system — use your system's eject instead".into())
    }
}

fn mac_choose_folder(prompt: &str) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let script = format!("POSIX path of (choose folder with prompt {})", serde_json::to_string(prompt).ok()?);
    let out = std::process::Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to activate", "-e", &script])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().trim_end_matches('/').to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Show a file selected in Finder / Explorer / the file manager.
fn reveal_file(p: &Path) {
    let r = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg("-R").arg(p).spawn()
    } else if cfg!(windows) {
        std::process::Command::new("explorer").arg(format!("/select,{}", p.to_string_lossy())).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(p.parent().unwrap_or(p)).spawn()
    };
    let _ = r;
}

pub fn open_path(p: &str) {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(cmd).arg(p).spawn();
}
