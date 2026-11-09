//! Scans a folder (typically an SD card's DCIM tree), reads JPEG headers in
//! parallel and groups film-simulation brackets into sets.

use crate::jpeg;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, Default)]
pub struct Photo {
    pub id: String,
    pub file: PathBuf,
    pub name: String,
    pub dir: PathBuf,
    pub rel: String,
    pub num: u64,
    pub size: u64,
    pub mtime: f64,
    pub key: String,
    pub date_time: Option<String>,
    pub sub_sec: Option<String>,
    pub film_sim: Option<String>,
    pub model: Option<String>,
    pub orientation: u16,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub preview: Option<(u64, u64)>,
    pub thumb: Option<(u64, u64)>,
    pub video: bool,
    /// The set's RAW file (.RAF), if the camera wrote one.
    pub raw: Option<PathBuf>,
    pub raw_size: u64,
    pub cam_rating: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicPhoto<'a> {
    id: &'a str,
    name: &'a str,
    rel: &'a str,
    num: u64,
    size: u64,
    mtime: f64,
    key: &'a str,
    date_time: &'a Option<String>,
    sub_sec: &'a Option<String>,
    film_sim: &'a Option<String>,
    model: &'a Option<String>,
    orientation: u16,
    width: Option<u32>,
    height: Option<u32>,
    kind: &'static str,
    has_preview: bool,
    has_thumb: bool,
    raw_name: Option<String>,
    raw_size: Option<u64>,
    cam_rating: Option<u32>,
}

impl Photo {
    pub fn public(&self) -> PublicPhoto<'_> {
        PublicPhoto {
            id: &self.id,
            name: &self.name,
            rel: &self.rel,
            num: self.num,
            size: self.size,
            mtime: self.mtime,
            key: &self.key,
            date_time: &self.date_time,
            sub_sec: &self.sub_sec,
            film_sim: &self.film_sim,
            model: &self.model,
            orientation: self.orientation,
            width: self.width,
            height: self.height,
            kind: if self.video { "video" } else { "photo" },
            has_preview: self.preview.is_some(),
            has_thumb: self.thumb.is_some(),
            raw_name: self.raw.as_ref().and_then(|r| r.file_name()).map(|n| n.to_string_lossy().to_string()),
            raw_size: self.raw.as_ref().map(|_| self.raw_size),
            cam_rating: self.cam_rating,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Set {
    pub index: usize,
    pub date_time: Option<String>,
    pub kind: &'static str,
    pub photos: Vec<String>,
}

#[derive(Default)]
pub struct Library {
    pub root: Option<PathBuf>,
    pub scope: Scope,
    pub photos: HashMap<String, Photo>,
    pub sets: Vec<Set>,
}

/// Progress of the current scan. Each scan takes a new generation number;
/// starting another scan cancels the previous one, whose workers stop and
/// no longer touch the counters.
pub struct Progress {
    pub scanning: std::sync::atomic::AtomicBool,
    pub done: AtomicUsize,
    pub total: AtomicUsize,
    pub generation: std::sync::atomic::AtomicU64,
}

impl Default for Progress {
    fn default() -> Self {
        Progress { scanning: false.into(), done: 0.into(), total: 0.into(), generation: 0.into() }
    }
}

/// Which part of a card to load: a subfolder (relative to the card root)
/// and/or an inclusive range of local capture days ("YYYY-MM-DD").
#[derive(Default, Clone, Debug)]
pub struct Scope {
    pub folder: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    /// only files written after this time (ms since epoch): "since last import"
    pub after: Option<f64>,
}

impl Scope {
    fn day_ok(&self, day: &str) -> bool {
        self.from.as_deref().map_or(true, |f| day >= f) && self.to.as_deref().map_or(true, |t| day <= t)
    }
}

fn mtime_ms(md: &std::fs::Metadata) -> f64 {
    md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn local_day(ms: f64) -> String {
    use chrono::{Local, TimeZone};
    Local.timestamp_millis_opt(ms as i64).single().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

/// Cheap overview of a card for choosing what to load: only directory
/// listings and file times are read (a camera writes the file time at
/// capture), never the photos themselves.
/// `imported` holds "name:size" of every card file exported before; the newest
/// of those found on this card marks where "since last import" starts.
pub fn survey(root: &Path, imported: &std::collections::HashSet<String>) -> serde_json::Value {
    let mut files = Vec::new();
    walk(root, 0, &mut files);
    files.retain(|f| !f.file_name().map_or(false, |n| is_raw(&n.to_string_lossy())));
    let mut groups: std::collections::BTreeMap<(String, String), (u64, u64)> = Default::default();
    let mut times: Vec<f64> = Vec::with_capacity(files.len());
    let mut last_imported: Option<f64> = None;
    for f in &files {
        let Ok(md) = std::fs::metadata(f) else { continue };
        let ms = mtime_ms(&md);
        times.push(ms);
        let fname = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if imported.contains(&format!("{}:{}", fname, md.len())) {
            last_imported = Some(last_imported.map_or(ms, |l: f64| l.max(ms)));
        }
        let day = local_day(ms);
        let folder = f.parent().and_then(|p| p.strip_prefix(root).ok()).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let e = groups.entry((folder, day)).or_default();
        if is_video(&name) { e.1 += 1 } else { e.0 += 1 }
    }
    let groups: Vec<_> = groups
        .into_iter()
        .map(|((folder, day), (photos, videos))| serde_json::json!({ "folder": folder, "day": day, "photos": photos, "videos": videos }))
        .collect();
    let since_last = last_imported.map(|after| {
        let newer: Vec<f64> = times.iter().copied().filter(|&t| t > after).collect();
        let first = newer.iter().copied().fold(f64::INFINITY, f64::min);
        serde_json::json!({
            "after": after,
            "count": newer.len(),
            "firstDay": if newer.is_empty() { serde_json::Value::Null } else { local_day(first).into() },
        })
    });
    serde_json::json!({ "root": root.to_string_lossy(), "total": files.len(), "groups": groups, "sinceLast": since_last })
}

const SKIP: [&str; 5] = [".Trashes", ".Spotlight-V100", ".fseventsd", "node_modules", ".git"];

fn ext_lower(name: &str) -> String {
    Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}
pub fn is_jpeg(name: &str) -> bool {
    matches!(ext_lower(name).as_str(), "jpg" | "jpeg")
}
pub fn is_video(name: &str) -> bool {
    matches!(ext_lower(name).as_str(), "mov" | "mp4" | "m4v")
}
pub fn is_raw(name: &str) -> bool {
    ext_lower(name) == "raf"
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("._") {
            continue; // macOS resource forks on FAT cards
        }
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if !name.starts_with('.') && !SKIP.contains(&name.as_str()) {
                walk(&e.path(), depth + 1, out);
            }
        } else if ft.is_file() && (is_jpeg(&name) || is_video(&name) || is_raw(&name)) {
            out.push(e.path());
        }
    }
}

fn file_number(name: &str) -> u64 {
    let stem = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let digits: String = stem.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
    digits.parse().unwrap_or(0)
}

// Video files carry no EXIF; the card's file time is the capture time.
fn exif_date(ms: f64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(ms as i64).single() {
        Some(d) => d.format("%Y:%m:%d %H:%M:%S").to_string(),
        None => String::new(),
    }
}

/// Brackets: consecutive frames sharing a capture timestamp, each with a
/// different film simulation. Everything else stands alone as a set of one.
pub fn group(photos: &mut Vec<Photo>) -> Vec<Set> {
    photos.sort_by(|a, b| {
        let ka = a.date_time.clone().unwrap_or_default();
        let kb = b.date_time.clone().unwrap_or_default();
        ka.cmp(&kb).then_with(|| a.dir.cmp(&b.dir)).then_with(|| a.num.cmp(&b.num))
    });
    let mut groups: Vec<(Option<String>, Vec<usize>)> = Vec::new();
    for (i, p) in photos.iter().enumerate() {
        let stamp = p.date_time.as_ref().map(|d| format!("{}.{}", d, p.sub_sec.clone().unwrap_or_default()));
        let fits = match groups.last() {
            Some((s, members)) => {
                let first = &photos[members[0]];
                let last = &photos[*members.last().unwrap()];
                stamp.is_some()
                    && *s == stamp
                    && !p.video
                    && !first.video
                    && members.len() < 3
                    && p.dir == first.dir
                    && p.num == last.num + 1
                    && !members.iter().any(|&m| photos[m].film_sim.is_some() && photos[m].film_sim == p.film_sim)
            }
            None => false,
        };
        if fits {
            groups.last_mut().unwrap().1.push(i);
        } else {
            groups.push((stamp, vec![i]));
        }
    }
    groups
        .into_iter()
        .enumerate()
        .map(|(index, (_, members))| {
            let first = &photos[members[0]];
            Set {
                index,
                date_time: first.date_time.clone(),
                kind: if first.video { "video" } else { "photo" },
                photos: members.iter().map(|&m| photos[m].id.clone()).collect(),
            }
        })
        .collect()
}

/// Scan `root` (the card), limited to `scope`. Returns None if a newer scan
/// superseded this one before it finished.
pub fn scan(root: &Path, scope: &Scope, progress: &Progress) -> Option<Library> {
    let generation = progress.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let current = || progress.generation.load(Ordering::SeqCst) == generation;
    progress.done.store(0, Ordering::SeqCst);
    progress.total.store(0, Ordering::SeqCst);
    let start = match &scope.folder {
        Some(f) if !f.is_empty() && !f.contains("..") => root.join(f),
        _ => root.to_path_buf(),
    };
    let mut files = Vec::new();
    walk(&start, 0, &mut files);
    // RAWs aren't shown; they're attached to their set for export/delete
    let (raws, mut files): (Vec<PathBuf>, Vec<PathBuf>) =
        files.into_iter().partition(|f| f.file_name().map_or(false, |n| is_raw(&n.to_string_lossy())));
    if scope.from.is_some() || scope.to.is_some() || scope.after.is_some() {
        files.retain(|f| {
            std::fs::metadata(f)
                .map(|md| {
                    let ms = mtime_ms(&md);
                    scope.day_ok(&local_day(ms)) && scope.after.map_or(true, |a| ms > a)
                })
                .unwrap_or(false)
        });
    }
    files.sort();
    if !current() {
        return None;
    }
    progress.total.store(files.len(), Ordering::SeqCst);

    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<Photo>>> = Mutex::new(vec![None; files.len()]);
    let threads = 16.min(files.len().max(1));
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= files.len() || !current() {
                    break; // done, or cancelled by a newer scan
                }
                let photo = read_one(root, &files[i], i);
                if current() {
                    progress.done.fetch_add(1, Ordering::SeqCst);
                }
                results.lock().unwrap()[i] = photo;
            });
        }
    });
    if !current() {
        return None;
    }
    let mut photos: Vec<Photo> = results.into_inner().unwrap().into_iter().flatten().collect();
    let sets = group(&mut photos);
    attach_raws(&mut photos, &sets, &raws);
    Some(Library {
        root: Some(root.to_path_buf()),
        scope: scope.clone(),
        photos: photos.into_iter().map(|p| (p.id.clone(), p)).collect(),
        sets,
    })
}

/// A set's RAW is a .RAF in the same folder whose name matches any of the
/// set's JPEGs (RAW+JPEG writes DSCF0001.RAF beside DSCF0001.JPG; a film
/// simulation bracket writes one RAF for the three JPEGs).
fn attach_raws(photos: &mut [Photo], sets: &[Set], raws: &[PathBuf]) {
    if raws.is_empty() {
        return;
    }
    let key = |p: &Path| {
        (
            p.parent().map(Path::to_path_buf).unwrap_or_default(),
            p.file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default(),
        )
    };
    let by_stem: HashMap<(PathBuf, String), &PathBuf> = raws.iter().map(|r| (key(r), r)).collect();
    let index: HashMap<String, usize> = photos.iter().enumerate().map(|(i, p)| (p.id.clone(), i)).collect();
    for set in sets {
        let raw = set.photos.iter().filter_map(|id| index.get(id)).find_map(|&i| by_stem.get(&key(&photos[i].file)).copied());
        if let Some(raw) = raw {
            let size = std::fs::metadata(raw).map(|m| m.len()).unwrap_or(0);
            for id in &set.photos {
                if let Some(&i) = index.get(id) {
                    photos[i].raw = Some(raw.clone());
                    photos[i].raw_size = size;
                }
            }
        }
    }
}

/// A photo's id: a hash of its path, size and time. The same file keeps the
/// same id across scans (so cached images stay right), and a different file
/// can never inherit an old one.
fn stable_id(file: &Path, size: u64, mtime: f64) -> String {
    let mut h: u64 = 0xcbf29ce484222325; // FNV-1a
    let mut eat = |bytes: &[u8]| {
        for &b in bytes {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    };
    eat(file.to_string_lossy().as_bytes());
    eat(&size.to_le_bytes());
    eat(&(mtime as u64).to_le_bytes());
    format!("{:012x}", h & 0xffff_ffff_ffff)
}

fn read_one(root: &Path, file: &Path, _i: usize) -> Option<Photo> {
    let md = std::fs::metadata(file).ok()?;
    let mtime = mtime_ms(&md);
    let name = file.file_name()?.to_string_lossy().to_string();
    let video = is_video(&name);
    let meta = if video {
        jpeg::Meta { orientation: 1, date_time: Some(exif_date(mtime)), ..Default::default() }
    } else {
        jpeg::read_meta(file).ok()?
    };
    let key = format!(
        "{}:{}:{}",
        name,
        md.len(),
        meta.date_time.clone().unwrap_or_else(|| format!("{}", mtime.round() as i64))
    );
    Some(Photo {
        id: stable_id(file, md.len(), mtime),
        file: file.to_path_buf(),
        dir: file.parent().map(Path::to_path_buf).unwrap_or_default(),
        rel: file.strip_prefix(root).map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        num: file_number(&name),
        size: md.len(),
        mtime,
        key,
        date_time: meta.date_time,
        sub_sec: meta.sub_sec,
        film_sim: meta.film_sim,
        model: meta.model,
        orientation: meta.orientation,
        width: meta.width.or(meta.frame_width),
        height: meta.height.or(meta.frame_height),
        preview: meta.preview,
        thumb: meta.thumb,
        video,
        raw: None,
        raw_size: 0,
        cam_rating: meta.rating,
        name,
    })
}
