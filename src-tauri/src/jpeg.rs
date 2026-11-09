//! Dependency-free JPEG header reader tuned for Fujifilm files.
//! Reads only the header segments (APP1 EXIF + APP2 MPF), never image data.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Default, Clone)]
pub struct Meta {
    pub make: Option<String>,
    pub model: Option<String>,
    pub orientation: u16,
    pub date_time: Option<String>,
    pub sub_sec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_width: Option<u32>,
    pub frame_height: Option<u32>,
    pub film_sim: Option<String>,
    /// Byte range of the embedded MPF preview JPEG (Fuji: ~1920px).
    pub preview: Option<(u64, u64)>,
    /// Byte range of the EXIF IFD1 thumbnail JPEG (~160px).
    pub thumb: Option<(u64, u64)>,
    /// In-camera rating (0–5), if set on the camera.
    pub rating: Option<u32>,
}

fn film_mode(v: u32) -> Option<&'static str> {
    Some(match v {
        0x000 => "Provia",
        0x100 => "Studio Portrait",
        0x110 | 0x300 => "Studio Portrait Ex",
        0x120 => "Astia",
        0x130 => "Studio Portrait Sharp",
        0x200 | 0x400 => "Velvia",
        0x500 => "Pro Neg. Std",
        0x501 => "Pro Neg. Hi",
        0x600 => "Classic Chrome",
        0x700 => "Eterna",
        0x800 => "Classic Neg.",
        0x900 => "Eterna Bleach Bypass",
        0xa00 => "Nostalgic Neg.",
        0xb00 => "Reala Ace",
        _ => return None,
    })
}

// Monochrome sims live in the Saturation tag rather than FilmMode.
fn mono_mode(v: u32) -> Option<&'static str> {
    Some(match v {
        0x300 => "Monochrome",
        0x301 => "Monochrome + R",
        0x302 => "Monochrome + Ye",
        0x303 => "Monochrome + G",
        0x310 => "Sepia",
        0x500 => "Acros",
        0x501 => "Acros + R",
        0x502 => "Acros + Ye",
        0x503 => "Acros + G",
        _ => return None,
    })
}

fn type_size(t: u16) -> usize {
    match t {
        3 => 2,
        4 | 9 => 4,
        5 | 10 => 8,
        _ => 1,
    }
}

/// A TIFF structure view: `base` is the absolute index of the TIFF header.
#[derive(Clone, Copy)]
struct Tiff<'a> {
    buf: &'a [u8],
    base: usize,
    little: bool,
}

#[derive(Clone, Copy, Debug)]
struct Entry {
    tag: u16,
    typ: u16,
    count: u32,
    off: usize, // value offset relative to base
    size: usize,
    pos: usize, // entry position relative to base
}

impl<'a> Tiff<'a> {
    fn ok(&self, o: usize, n: usize) -> bool {
        self.base.checked_add(o).and_then(|a| a.checked_add(n)).map_or(false, |e| e <= self.buf.len())
    }
    fn u16(&self, o: usize) -> u16 {
        let b = [self.buf[self.base + o], self.buf[self.base + o + 1]];
        if self.little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) }
    }
    fn u32(&self, o: usize) -> u32 {
        let s = self.base + o;
        let b = [self.buf[s], self.buf[s + 1], self.buf[s + 2], self.buf[s + 3]];
        if self.little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) }
    }
    fn ifd(&self, off: usize) -> Vec<Entry> {
        let mut out = Vec::new();
        if !self.ok(off, 2) {
            return out;
        }
        let n = self.u16(off) as usize;
        if n > 1000 || !self.ok(off + 2, n * 12) {
            return out;
        }
        for i in 0..n {
            let e = off + 2 + i * 12;
            let typ = self.u16(e + 2);
            let count = self.u32(e + 4);
            let size = type_size(typ).saturating_mul(count as usize);
            let voff = if size <= 4 { e + 8 } else { self.u32(e + 8) as usize };
            out.push(Entry { tag: self.u16(e), typ, count, off: voff, size, pos: e });
        }
        out
    }
    fn find(entries: &[Entry], tag: u16) -> Option<Entry> {
        entries.iter().copied().find(|e| e.tag == tag)
    }
    fn num(&self, e: Option<Entry>) -> Option<u32> {
        let e = e?;
        if !self.ok(e.off, e.size.max(1)) {
            return None;
        }
        match e.typ {
            3 => Some(self.u16(e.off) as u32),
            4 | 9 => Some(self.u32(e.off)),
            _ => None,
        }
    }
    fn text(&self, e: Option<Entry>) -> Option<String> {
        let e = e?;
        if e.typ != 2 || !self.ok(e.off, e.count as usize) {
            return None;
        }
        let s = &self.buf[self.base + e.off..self.base + e.off + e.count as usize];
        let s: String = s.iter().take_while(|&&c| c != 0).map(|&c| c as char).collect();
        let s = s.trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }
}

fn tiff_at(buf: &[u8], base: usize) -> Option<Tiff<'_>> {
    if base + 8 > buf.len() {
        return None;
    }
    let little = match &buf[base..base + 2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    Some(Tiff { buf, base, little })
}

fn parse_fuji_makernote(buf: &[u8], start: usize, len: usize, out: &mut Meta) {
    // "FUJIFILM" + u32le IFD offset; offsets relative to makernote start; little endian.
    if len < 12 || start + 12 > buf.len() || &buf[start..start + 8] != b"FUJIFILM" {
        return;
    }
    let t = Tiff { buf, base: start, little: true };
    let ifd = t.ifd(t.u32(8) as usize);
    out.rating = t.num(Tiff::find(&ifd, 0x1431)).filter(|r| (1..=5).contains(r));
    let fm = t.num(Tiff::find(&ifd, 0x1401));
    let sat = t.num(Tiff::find(&ifd, 0x1003));
    out.film_sim = match (sat.and_then(mono_mode), fm) {
        (Some(m), _) => Some(m.to_string()),
        (None, Some(f)) => Some(film_mode(f).map(String::from).unwrap_or_else(|| format!("Film {:x}", f))),
        _ => None,
    };
}

fn parse_exif(buf: &[u8], base: usize, out: &mut Meta) {
    let Some(t) = tiff_at(buf, base) else { return };
    let ifd0_off = t.u32(4) as usize;
    let ifd0 = t.ifd(ifd0_off);
    // IFD1 (after IFD0) carries the small thumbnail
    if t.ok(ifd0_off, 2) {
        let next_at = ifd0_off + 2 + t.u16(ifd0_off) as usize * 12;
        if t.ok(next_at, 4) {
            let ifd1_off = t.u32(next_at) as usize;
            if ifd1_off != 0 {
                let ifd1 = t.ifd(ifd1_off);
                if let (Some(off), Some(len)) = (t.num(Tiff::find(&ifd1, 0x0201)), t.num(Tiff::find(&ifd1, 0x0202))) {
                    let (start, len) = (base + off as usize, len as usize);
                    if len > 2 && len < 256 * 1024 && start + 2 <= buf.len() && buf[start] == 0xff && buf[start + 1] == 0xd8 {
                        out.thumb = Some((start as u64, len as u64));
                    }
                }
            }
        }
    }
    out.make = t.text(Tiff::find(&ifd0, 0x010f));
    out.model = t.text(Tiff::find(&ifd0, 0x0110));
    out.orientation = t.num(Tiff::find(&ifd0, 0x0112)).unwrap_or(1) as u16;
    if let Some(ptr) = t.num(Tiff::find(&ifd0, 0x8769)) {
        let exif = t.ifd(ptr as usize);
        out.date_time = t.text(Tiff::find(&exif, 0x9003));
        out.sub_sec = t.text(Tiff::find(&exif, 0x9291));
        out.width = t.num(Tiff::find(&exif, 0xa002));
        out.height = t.num(Tiff::find(&exif, 0xa003));
        if let Some(mn) = Tiff::find(&exif, 0x927c) {
            if t.ok(mn.off, mn.size) {
                parse_fuji_makernote(buf, base + mn.off, mn.size, out);
            }
        }
    }
}

fn parse_mpf(buf: &[u8], base: usize, out: &mut Meta) {
    let Some(t) = tiff_at(buf, base) else { return };
    let ifd = t.ifd(t.u32(4) as usize);
    let Some(e) = Tiff::find(&ifd, 0xb002) else { return };
    if !t.ok(e.off, e.size) {
        return;
    }
    let mut best: Option<(u64, u64)> = None;
    for i in 1..e.size / 16 {
        let o = e.off + i * 16;
        let size = t.u32(o + 4) as u64;
        let offset = t.u32(o + 8) as u64;
        if size == 0 || offset == 0 {
            continue;
        }
        if best.map_or(true, |(_, l)| size > l) {
            best = Some((base as u64 + offset, size)); // offsets are relative to the MPF TIFF header
        }
    }
    if best.is_some() {
        out.preview = best;
    }
}

pub enum Parsed {
    Done(Meta),
    NeedMore(usize),
    NotJpeg,
}

/// Parse header segments from a buffer that starts at file offset 0.
pub fn parse_header(buf: &[u8]) -> Parsed {
    if buf.len() < 4 || buf[0] != 0xff || buf[1] != 0xd8 {
        return Parsed::NotJpeg;
    }
    let mut out = Meta { orientation: 1, ..Default::default() };
    let mut p = 2;
    while p + 4 <= buf.len() {
        if buf[p] != 0xff {
            break;
        }
        let marker = buf[p + 1];
        if marker == 0xd8 || (0xd0..=0xd7).contains(&marker) || marker == 0x01 {
            p += 2;
            continue;
        }
        if marker == 0xff {
            p += 1;
            continue;
        }
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        let len = u16::from_be_bytes([buf[p + 2], buf[p + 3]]) as usize;
        let seg_end = p + 2 + len;
        if seg_end > buf.len() {
            return Parsed::NeedMore(seg_end + 4);
        }
        let data = p + 4;
        let seg = &buf[..seg_end];
        if marker == 0xe1 && seg_end >= data + 6 && &buf[data..data + 6] == b"Exif\0\0" {
            parse_exif(seg, data + 6, &mut out);
        } else if marker == 0xe2 && seg_end >= data + 4 && &buf[data..data + 4] == b"MPF\0" {
            parse_mpf(seg, data + 4, &mut out);
        } else if matches!(marker, 0xc0..=0xc2) && seg_end >= data + 5 {
            out.frame_height = Some(u16::from_be_bytes([buf[data + 1], buf[data + 2]]) as u32);
            out.frame_width = Some(u16::from_be_bytes([buf[data + 3], buf[data + 4]]) as u32);
        }
        p = seg_end;
    }
    Parsed::Done(out)
}

pub fn read_meta(path: &Path) -> std::io::Result<Meta> {
    let mut f = File::open(path)?;
    // Fuji's EXIF + MPF headers fit in ~70 KB; read a little more than that
    // (a short read means a grown buffer, re-read from the start).
    let mut size = 80 * 1024;
    for _ in 0..4 {
        let mut buf = Vec::with_capacity(size);
        (&mut f).take(size as u64).read_to_end(&mut buf)?;
        f.seek(SeekFrom::Start(0))?;
        match parse_header(&buf) {
            Parsed::Done(m) => return Ok(m),
            Parsed::NeedMore(n) if buf.len() == size => size = n.max(size * 2),
            Parsed::NeedMore(_) | Parsed::NotJpeg => return Ok(Meta { orientation: 1, ..Default::default() }),
        }
    }
    Ok(Meta { orientation: 1, ..Default::default() })
}

/// Check the MPF range really begins with a JPEG SOI marker.
pub fn valid_preview(path: &Path, start: u64) -> bool {
    let Ok(mut f) = File::open(path) else { return false };
    let mut b = [0u8; 2];
    f.seek(SeekFrom::Start(start)).is_ok() && f.read_exact(&mut b).is_ok() && b == [0xff, 0xd8]
}

/// Tiny EXIF APP1 segment carrying only Orientation. Fuji's MPF preview has
/// no orientation of its own; we graft the parent's on so browsers rotate it.
pub fn orientation_segment(orientation: u16) -> Vec<u8> {
    let mut tiff = vec![b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1];
    tiff.extend_from_slice(&0x0112u16.to_be_bytes());
    tiff.extend_from_slice(&3u16.to_be_bytes());
    tiff.extend_from_slice(&1u32.to_be_bytes());
    tiff.extend_from_slice(&orientation.to_be_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0u32.to_be_bytes());
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(&tiff);
    let mut seg = vec![0xff, 0xe1];
    seg.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    seg.extend_from_slice(&payload);
    seg
}

/// Copy of the file's EXIF APP1 segment patched for a re-encoded, upright
/// image: Orientation -> 1, pixel size updated, stale IFD1 thumbnail unlinked.
/// The MakerNote (film simulation etc.) is kept.
pub fn exif_for_edited(path: &Path, width: u32, height: u32) -> Option<Vec<u8>> {
    let mut f = File::open(path).ok()?;
    let mut buf = Vec::new();
    (&mut f).take(256 * 1024).read_to_end(&mut buf).ok()?;
    if buf.len() < 4 || buf[0] != 0xff || buf[1] != 0xd8 {
        return None;
    }
    let mut p = 2;
    while p + 4 <= buf.len() && buf[p] == 0xff {
        let marker = buf[p + 1];
        if marker == 0xda || marker == 0xd9 {
            return None;
        }
        let len = u16::from_be_bytes([buf[p + 2], buf[p + 3]]) as usize;
        if p + 2 + len > buf.len() {
            return None;
        }
        if marker == 0xe1 && &buf[p + 4..p + 10] == b"Exif\0\0" {
            let mut seg = buf[p..p + 2 + len].to_vec();
            let base = 10;
            let (little, ifd0, exif_ptr, patches) = {
                let t = tiff_at(&seg, base)?;
                let ifd0_off = t.u32(4) as usize;
                let ifd0 = t.ifd(ifd0_off);
                let exif_ptr = t.num(Tiff::find(&ifd0, 0x8769));
                let mut patches: Vec<(Entry, u32)> = Vec::new();
                if let Some(e) = Tiff::find(&ifd0, 0x0112) {
                    patches.push((e, 1));
                }
                if let Some(ptr) = exif_ptr {
                    let exif = t.ifd(ptr as usize);
                    if let Some(e) = Tiff::find(&exif, 0xa002) {
                        patches.push((e, width));
                    }
                    if let Some(e) = Tiff::find(&exif, 0xa003) {
                        patches.push((e, height));
                    }
                }
                let n0 = if t.ok(ifd0_off, 2) { t.u16(ifd0_off) as usize } else { 0 };
                (t.little, ifd0_off + 2 + n0 * 12, exif_ptr, patches)
            };
            let _ = exif_ptr;
            let w16 = |seg: &mut Vec<u8>, at: usize, v: u16| {
                let b = if little { v.to_le_bytes() } else { v.to_be_bytes() };
                seg[base + at..base + at + 2].copy_from_slice(&b);
            };
            let w32 = |seg: &mut Vec<u8>, at: usize, v: u32| {
                let b = if little { v.to_le_bytes() } else { v.to_be_bytes() };
                seg[base + at..base + at + 4].copy_from_slice(&b);
            };
            for (e, v) in patches {
                match e.typ {
                    3 => w16(&mut seg, e.pos + 8, v as u16),
                    4 => w32(&mut seg, e.pos + 8, v),
                    _ => {}
                }
            }
            if base + ifd0 + 4 <= seg.len() {
                w32(&mut seg, ifd0, 0); // unlink IFD1 thumbnail
            }
            return Some(seg);
        }
        p += 2 + len;
    }
    None
}

/// Insert an APP1 segment right after SOI, dropping any APP0/APP1 the
/// encoder wrote (browsers emit a JFIF APP0).
pub fn graft_segment(jpeg: &[u8], seg: Option<&[u8]>) -> Vec<u8> {
    let Some(seg) = seg else { return jpeg.to_vec() };
    if jpeg.len() < 4 || jpeg[0] != 0xff || jpeg[1] != 0xd8 {
        return jpeg.to_vec();
    }
    let mut p = 2;
    while p + 4 <= jpeg.len() && jpeg[p] == 0xff && (jpeg[p + 1] == 0xe0 || jpeg[p + 1] == 0xe1) {
        p += 2 + u16::from_be_bytes([jpeg[p + 2], jpeg[p + 3]]) as usize;
    }
    let p = p.min(jpeg.len());
    let mut out = Vec::with_capacity(jpeg.len() + seg.len());
    out.extend_from_slice(&jpeg[..2]);
    out.extend_from_slice(seg);
    out.extend_from_slice(&jpeg[p..]);
    out
}

/* ------------------------------------------------------------ shot info */

impl<'a> Tiff<'a> {
    /// n-th RATIONAL/SRATIONAL of an entry as f64.
    fn ratio(&self, e: Option<Entry>, n: usize) -> Option<f64> {
        let e = e?;
        if !(e.typ == 5 || e.typ == 10) || n as u32 >= e.count || !self.ok(e.off + n * 8, 8) {
            return None;
        }
        let (a, b) = (self.u32(e.off + n * 8), self.u32(e.off + n * 8 + 4));
        let (a, b) = if e.typ == 10 { (a as i32 as f64, b as i32 as f64) } else { (a as f64, b as f64) };
        if b == 0.0 { None } else { Some(a / b) }
    }
    /// n-th signed 32-bit value (SLONG) or 16-bit (SSHORT/SHORT) of an entry.
    fn int(&self, e: Option<Entry>, n: usize) -> Option<i64> {
        let e = e?;
        match e.typ {
            9 if (n as u32) < e.count && self.ok(e.off + n * 4, 4) => Some(self.u32(e.off + n * 4) as i32 as i64),
            4 if (n as u32) < e.count && self.ok(e.off + n * 4, 4) => Some(self.u32(e.off + n * 4) as i64),
            8 if (n as u32) < e.count && self.ok(e.off + n * 2, 2) => Some(self.u16(e.off + n * 2) as i16 as i64),
            3 if (n as u32) < e.count && self.ok(e.off + n * 2, 2) => Some(self.u16(e.off + n * 2) as i64),
            _ => None,
        }
    }
}

fn signed(v: f64) -> String {
    let s = if (v - v.round()).abs() < 0.01 { format!("{}", v.round() as i64) } else { format!("{:.1}", v) };
    if v > 0.0 { format!("+{}", s) } else { s.replace('-', "−") }
}

/// Exposure compensation the way the camera shows it: −1⅓, +⅔, +2 …
fn ev_thirds(ev: f64) -> String {
    let n = (ev * 3.0).round() as i64;
    let sign = if n < 0 { "−" } else { "+" };
    let (whole, rem) = (n.abs() / 3, n.abs() % 3);
    let frac = ["", "⅓", "⅔"][rem as usize];
    match (whole, rem) {
        (0, 0) => "0".into(),
        (0, _) => format!("{}{}", sign, frac),
        _ => format!("{}{}{}", sign, whole, frac),
    }
}

fn strength(v: i64) -> Option<&'static str> {
    Some(match v {
        0 => "Off",
        0x20 => "Weak",
        0x40 => "Strong",
        _ => return None,
    })
}

/// Camera settings and the Fujifilm "film recipe" of a shot, as
/// (label, value) rows, for display. Only fields present are returned.
pub fn shot_info(path: &Path) -> Vec<(String, String)> {
    let mut rows: Vec<(String, String)> = Vec::new();
    let Ok(mut f) = File::open(path) else { return rows };
    let mut buf = Vec::new();
    if (&mut f).take(256 * 1024).read_to_end(&mut buf).is_err() || buf.len() < 4 || buf[0] != 0xff || buf[1] != 0xd8 {
        return rows;
    }
    // find the EXIF segment
    let mut p = 2;
    let mut base = None;
    while p + 4 <= buf.len() && buf[p] == 0xff {
        let marker = buf[p + 1];
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        let len = u16::from_be_bytes([buf[p + 2], buf[p + 3]]) as usize;
        if marker == 0xe1 && p + 10 <= buf.len() && &buf[p + 4..p + 10] == b"Exif\0\0" {
            base = Some(p + 10);
            buf.truncate((p + 2 + len).min(buf.len()));
            break;
        }
        p += 2 + len;
    }
    let Some(base) = base else { return rows };
    let Some(t) = tiff_at(&buf, base) else { return rows };
    let ifd0 = t.ifd(t.u32(4) as usize);
    let model = t.text(Tiff::find(&ifd0, 0x0110));
    let Some(exif_ptr) = t.num(Tiff::find(&ifd0, 0x8769)) else { return rows };
    let exif = t.ifd(exif_ptr as usize);
    let e = |tag| Tiff::find(&exif, tag);

    // camera + lens
    let lens = t.text(e(0xa434));
    let focal = t.ratio(e(0x920a), 0);
    let focal35 = t.num(e(0xa405));
    let mut cam = model.unwrap_or_default();
    if let Some(l) = lens.filter(|l| !l.is_empty()) {
        cam = format!("{} · {}", cam, l);
    }
    if !cam.is_empty() {
        rows.push(("Camera".into(), cam));
    }
    // exposure
    let mut exp = Vec::new();
    if let Some(s) = t.ratio(e(0x829a), 0) {
        exp.push(if s >= 1.0 { format!("{}s", (s * 10.0).round() / 10.0) } else { format!("1/{}", (1.0 / s).round()) });
    }
    if let Some(fnum) = t.ratio(e(0x829d), 0) {
        exp.push(format!("f/{}", (fnum * 10.0).round() / 10.0));
    }
    if let Some(iso) = t.num(e(0x8827)) {
        exp.push(format!("ISO {}", iso));
    }
    if let Some(ev) = t.ratio(e(0x9204), 0) {
        if ev.abs() > 0.01 {
            exp.push(format!("{} EV", ev_thirds(ev)));
        }
    }
    if !exp.is_empty() {
        rows.push(("Exposure".into(), exp.join("  ·  ")));
    }
    match (focal, focal35) {
        (Some(fl), Some(f35)) if f35 > 0 && (fl.round() as u32) != f35 => rows.push(("Focal length".into(), format!("{}mm ({}mm equiv.)", fl.round(), f35))),
        (Some(fl), _) => rows.push(("Focal length".into(), format!("{}mm", fl.round()))),
        _ => {}
    }

    // Fujifilm maker note: the film recipe
    let Some(mn) = e(0x927c) else { return rows };
    let start = base + mn.off;
    if !t.ok(mn.off, 12) || &buf[start..start + 8] != b"FUJIFILM" {
        return rows;
    }
    let m = Tiff { buf: &buf, base: start, little: true };
    let ifd = m.ifd(m.u32(8) as usize);
    let g = |tag| Tiff::find(&ifd, tag);
    let film = m.num(g(0x1401));
    let sat = m.num(g(0x1003));
    let sim = match (sat.and_then(mono_mode), film) {
        (Some(mono), _) => Some(mono.to_string()),
        (None, Some(f)) => film_mode(f).map(String::from),
        _ => None,
    };
    if let Some(sim) = sim {
        rows.push(("Film simulation".into(), sim));
    }
    let rough = m.int(g(0x1047), 0).and_then(strength);
    let size = m.int(g(0x104c), 0).and_then(|v| match v {
        0 => None,
        0x10 => Some("Small"),
        0x20 => Some("Large"),
        _ => None,
    });
    match (rough, size) {
        (Some("Off"), _) => rows.push(("Grain".into(), "Off".into())),
        (Some(r), Some(s)) => rows.push(("Grain".into(), format!("{}, {}", r, s))),
        (Some(r), None) => rows.push(("Grain".into(), r.into())),
        _ => {}
    }
    if let Some(v) = m.int(g(0x1048), 0).and_then(strength) {
        rows.push(("Color Chrome".into(), v.into()));
    }
    if let Some(v) = m.int(g(0x104e), 0).and_then(strength) {
        rows.push(("Color Chrome FX Blue".into(), v.into()));
    }
    if let Some(wb) = m.num(g(0x1002)) {
        let name = match wb {
            0x0 => "Auto".to_string(),
            0x1 => "Auto (white priority)".into(),
            0x2 => "Auto (ambience priority)".into(),
            0x100 => "Daylight".into(),
            0x200 => "Shade".into(),
            0x300 | 0x301 | 0x302 | 0x303 | 0x304 => "Fluorescent".into(),
            0x400 => "Incandescent".into(),
            0x600 => "Underwater".into(),
            0xf00..=0xf04 => format!("Custom {}", wb - 0xf00 + 1),
            0xff0 => m.num(g(0x1005)).map(|k| format!("{}K", k)).unwrap_or_else(|| "Kelvin".into()),
            _ => format!("WB {:x}", wb),
        };
        let shift = match (m.int(g(0x100a), 0), m.int(g(0x100a), 1)) {
            (Some(r), Some(b)) if r != 0 || b != 0 => {
                // stored in 1/20 steps of the camera's ±9 scale
                format!("  ·  R{} B{}", signed(r as f64 / 20.0), signed(b as f64 / 20.0))
            }
            _ => String::new(),
        };
        rows.push(("White balance".into(), format!("{}{}", name, shift)));
    }
    let dr = match (m.num(g(0x1402)), m.num(g(0x1403))) {
        (Some(0), _) => Some("Auto".to_string()),
        (_, Some(d)) if d > 0 => Some(format!("DR{}", d)),
        (Some(0x100), _) => Some("DR100".into()),
        (Some(0x200), _) => Some("DR200".into()),
        (Some(0x201), _) => Some("DR400".into()),
        _ => None,
    };
    if let Some(dr) = dr {
        rows.push(("Dynamic range".into(), dr));
    }
    // tone: stored as −16 × the camera's value
    if let Some(v) = m.int(g(0x1041), 0) {
        rows.push(("Highlight".into(), signed(-(v as f64) / 16.0)));
    }
    if let Some(v) = m.int(g(0x1040), 0) {
        rows.push(("Shadow".into(), signed(-(v as f64) / 16.0)));
    }
    if sat.map_or(false, |s| mono_mode(s).is_none() && s != 0x8000) {
        let c = match sat.unwrap() {
            0x0 => Some("0"),
            0x80 => Some("+1"),
            0x100 => Some("+2"),
            0xc0 => Some("+3"),
            0xe0 => Some("+4"),
            0x180 => Some("−1"),
            0x400 => Some("−2"),
            0x4c0 => Some("−3"),
            0x4e0 => Some("−4"),
            _ => None,
        };
        if let Some(c) = c {
            rows.push(("Color".into(), c.into()));
        }
    }
    if let Some(v) = m.num(g(0x1001)) {
        let s = match v {
            0x0 => Some("−4"),
            0x1 => Some("−3"),
            0x2 => Some("−2"),
            0x82 => Some("−1"),
            0x3 => Some("0"),
            0x84 => Some("+1"),
            0x4 => Some("+2"),
            0x5 => Some("+3"),
            0x6 => Some("+4"),
            _ => None,
        };
        if let Some(s) = s {
            rows.push(("Sharpness".into(), s.into()));
        }
    }
    if let Some(v) = m.num(g(0x100e)) {
        let s = match v {
            0x0 => Some("0"),
            0x180 => Some("+1"),
            0x100 => Some("+2"),
            0x1c0 => Some("+3"),
            0x1e0 => Some("+4"),
            0x280 => Some("−1"),
            0x200 => Some("−2"),
            0x2c0 => Some("−3"),
            0x2e0 => Some("−4"),
            _ => None,
        };
        if let Some(s) = s {
            rows.push(("Noise reduction".into(), s.into()));
        }
    }
    if let Some(v) = m.int(g(0x100f), 0) {
        rows.push(("Clarity".into(), signed(v as f64 / 1000.0)));
    }
    rows
}

/* ------------------------------------------------------------ all metadata */

fn exif_name(group: &str, tag: u16) -> Option<&'static str> {
    Some(match (group, tag) {
        ("GPS", 0x0000) => "GPS version",
        ("GPS", 0x0001) => "GPS latitude ref",
        ("GPS", 0x0002) => "GPS latitude",
        ("GPS", 0x0003) => "GPS longitude ref",
        ("GPS", 0x0004) => "GPS longitude",
        ("GPS", 0x0005) => "GPS altitude ref",
        ("GPS", 0x0006) => "GPS altitude",
        ("GPS", 0x0007) => "GPS time stamp",
        ("GPS", 0x001d) => "GPS date stamp",
        ("GPS", _) => return None,
        (_, 0x010f) => "Make",
        (_, 0x0110) => "Model",
        (_, 0x0112) => "Orientation",
        (_, 0x011a) => "X resolution",
        (_, 0x011b) => "Y resolution",
        (_, 0x0128) => "Resolution unit",
        (_, 0x0131) => "Software",
        (_, 0x0132) => "Modify date",
        (_, 0x013b) => "Artist",
        (_, 0x0213) => "YCbCr positioning",
        (_, 0x8298) => "Copyright",
        (_, 0x829a) => "Exposure time",
        (_, 0x829d) => "F-number",
        (_, 0x8822) => "Exposure program",
        (_, 0x8827) => "ISO",
        (_, 0x8830) => "Sensitivity type",
        (_, 0x8832) => "Recommended exposure index",
        (_, 0x9000) => "Exif version",
        (_, 0x9003) => "Date/time original",
        (_, 0x9004) => "Create date",
        (_, 0x9010) => "Offset time",
        (_, 0x9011) => "Offset time original",
        (_, 0x9012) => "Offset time digitized",
        (_, 0x9101) => "Components configuration",
        (_, 0x9102) => "Compressed bits per pixel",
        (_, 0x9201) => "Shutter speed value",
        (_, 0x9202) => "Aperture value",
        (_, 0x9203) => "Brightness value",
        (_, 0x9204) => "Exposure compensation",
        (_, 0x9205) => "Max aperture value",
        (_, 0x9207) => "Metering mode",
        (_, 0x9208) => "Light source",
        (_, 0x9209) => "Flash",
        (_, 0x920a) => "Focal length",
        (_, 0x9286) => "User comment",
        (_, 0x9290) => "Sub-sec time",
        (_, 0x9291) => "Sub-sec time original",
        (_, 0x9292) => "Sub-sec time digitized",
        (_, 0xa000) => "FlashPix version",
        (_, 0xa001) => "Color space",
        (_, 0xa002) => "Image width",
        (_, 0xa003) => "Image height",
        (_, 0xa20e) => "Focal plane X resolution",
        (_, 0xa20f) => "Focal plane Y resolution",
        (_, 0xa210) => "Focal plane resolution unit",
        (_, 0xa217) => "Sensing method",
        (_, 0xa300) => "File source",
        (_, 0xa301) => "Scene type",
        (_, 0xa401) => "Custom rendered",
        (_, 0xa402) => "Exposure mode",
        (_, 0xa403) => "White balance",
        (_, 0xa405) => "Focal length (35mm)",
        (_, 0xa406) => "Scene capture type",
        (_, 0xa408) => "Contrast",
        (_, 0xa409) => "Saturation",
        (_, 0xa40a) => "Sharpness",
        (_, 0xa40c) => "Subject distance range",
        (_, 0xa420) => "Image unique ID",
        (_, 0xa430) => "Owner name",
        (_, 0xa431) => "Serial number",
        (_, 0xa432) => "Lens info",
        (_, 0xa433) => "Lens make",
        (_, 0xa434) => "Lens model",
        (_, 0xa435) => "Lens serial number",
        _ => return None,
    })
}

// Fujifilm maker-note tag names (community-documented, as used by exiftool).
fn fuji_name(tag: u16) -> Option<&'static str> {
    Some(match tag {
        0x0000 => "Version",
        0x0010 => "Internal serial number",
        0x1000 => "Quality",
        0x1001 => "Sharpness",
        0x1002 => "White balance",
        0x1003 => "Saturation / color",
        0x1004 | 0x1006 => "Contrast",
        0x1005 => "Color temperature",
        0x100a => "White balance fine tune",
        0x100b => "Noise reduction",
        0x100e => "High ISO noise reduction",
        0x100f => "Clarity",
        0x1010 => "Flash mode",
        0x1011 => "Flash exposure comp",
        0x1020 => "Macro",
        0x1021 => "Focus mode",
        0x1022 => "AF mode",
        0x1023 => "Focus pixel",
        0x102b => "Priority settings",
        0x102d => "Focus settings",
        0x102e => "AF-C settings",
        0x1030 => "Slow sync",
        0x1031 => "Picture mode",
        0x1032 => "Exposure count",
        0x1040 => "Shadow tone",
        0x1041 => "Highlight tone",
        0x1044 => "Digital zoom",
        0x1045 => "Lens modulation optimizer",
        0x1047 => "Grain effect roughness",
        0x1048 => "Color chrome effect",
        0x1049 => "B&W adjustment",
        0x104b => "B&W magenta/green",
        0x104c => "Grain effect size",
        0x104d => "Crop mode",
        0x104e => "Color chrome FX blue",
        0x1050 => "Shutter type",
        0x1100 => "Auto bracketing",
        0x1101 => "Sequence number",
        0x1103 => "Drive settings",
        0x1105 => "Drive speed",
        0x1153 => "Panorama angle",
        0x1154 => "Panorama direction",
        0x1201 => "Advanced filter",
        0x1210 => "Color mode",
        0x1300 => "Blur warning",
        0x1301 => "Focus warning",
        0x1302 => "Exposure warning",
        0x1400 => "Dynamic range",
        0x1401 => "Film mode",
        0x1402 => "Dynamic range setting",
        0x1403 => "Development dynamic range",
        0x1404 => "Min focal length",
        0x1405 => "Max focal length",
        0x1406 => "Max aperture at min focal",
        0x1407 => "Max aperture at max focal",
        0x140b => "Auto dynamic range",
        0x1422 => "Image stabilization",
        0x1425 => "Scene recognition",
        0x1431 => "Rating",
        0x1436 => "Image generation",
        0x1438 => "Image count",
        0x1443 => "D-range priority",
        0x1444 => "D-range priority auto",
        0x1445 => "D-range priority fixed",
        0x1446 => "Flicker reduction",
        0x1447 => "Fuji model",
        0x1448 => "Fuji model 2",
        0x144d => "Roll angle",
        0x3803 => "Video recording mode",
        0x3804 => "Peripheral lighting",
        0x3806 => "Video compression",
        0x3820 => "Frame rate",
        0x3821 => "Frame width",
        0x3822 => "Frame height",
        0x4005 => "Face element selected",
        0x4100 => "Faces detected",
        0x4103 => "Face positions",
        0x4200 => "Num face elements",
        0x4201 => "Face element types",
        0x4203 => "Face element positions",
        0x4282 => "Face rec info",
        0x8000 => "File source",
        0x8002 => "Order number",
        0x8003 => "Frame number",
        0xb211 => "Parallax",
        _ => return None,
    })
}

impl<'a> Tiff<'a> {
    /// All values of an entry as numbers (integers and rationals).
    fn numbers(&self, e: Entry) -> Vec<f64> {
        let n = (e.count as usize).min(4096);
        let mut out = Vec::with_capacity(n.min(64));
        for i in 0..n {
            let v = match e.typ {
                1 | 7 if self.ok(e.off + i, 1) => self.buf[self.base + e.off + i] as f64,
                6 if self.ok(e.off + i, 1) => self.buf[self.base + e.off + i] as i8 as f64,
                3 if self.ok(e.off + i * 2, 2) => self.u16(e.off + i * 2) as f64,
                8 if self.ok(e.off + i * 2, 2) => self.u16(e.off + i * 2) as i16 as f64,
                4 if self.ok(e.off + i * 4, 4) => self.u32(e.off + i * 4) as f64,
                9 if self.ok(e.off + i * 4, 4) => self.u32(e.off + i * 4) as i32 as f64,
                5 | 10 => match self.ratio(Some(e), i) {
                    Some(r) => r,
                    None => continue,
                },
                _ => break,
            };
            out.push(v);
        }
        out
    }

    /// A readable string for any entry.
    fn display(&self, e: Entry) -> String {
        if e.typ == 2 {
            return self.text(Some(e)).unwrap_or_default();
        }
        if e.typ == 7 || e.typ == 1 {
            if !self.ok(e.off, e.size) {
                return String::new();
            }
            let bytes = &self.buf[self.base + e.off..self.base + e.off + e.size];
            if bytes.len() <= 32 && bytes.iter().all(|&b| b == 0 || (32..127).contains(&b)) && bytes.iter().any(|&b| b != 0) {
                return bytes.iter().take_while(|&&b| b != 0).map(|&b| b as char).collect::<String>().trim().to_string();
            }
            if bytes.len() > 16 {
                return format!("({} bytes)", bytes.len());
            }
        }
        let nums = self.numbers(e);
        let fmt = |v: f64| {
            if (v - v.round()).abs() < 1e-9 {
                format!("{}", v.round() as i64)
            } else {
                format!("{:.4}", v).trim_end_matches('0').trim_end_matches('.').to_string()
            }
        };
        if e.typ == 5 && nums.len() == 1 {
            // show short exposure-like rationals as fractions too
            if let Some(r) = self.ratio(Some(e), 0) {
                if r > 0.0 && r < 1.0 {
                    return format!("{} (1/{})", fmt(r), (1.0 / r).round());
                }
            }
        }
        let shown: Vec<String> = nums.iter().take(24).map(|&v| fmt(v)).collect();
        if nums.len() > 24 {
            format!("{} … ({} values)", shown.join(" "), nums.len())
        } else {
            shown.join(" ")
        }
    }
}

fn dump_ifd(t: &Tiff, entries: &[Entry], group: &str, names: &dyn Fn(u16) -> Option<&'static str>, skip: &[u16]) -> Vec<Value> {
    entries
        .iter()
        .filter(|e| !skip.contains(&e.tag))
        .map(|e| {
            let name = names(e.tag).map(String::from).unwrap_or_else(|| format!("Tag 0x{:04x}", e.tag));
            serde_json::json!({ "group": group, "tag": format!("0x{:04x}", e.tag), "name": name, "value": t.display(*e) })
        })
        .collect()
}

use serde_json::Value;

/// Every tag the camera wrote (IFD0, Exif, GPS, Fujifilm maker note), plus
/// the spatial ones as numbers for drawing: the focus point and detected
/// faces, in full-image pixels (before orientation is applied).
pub fn all_metadata(path: &Path) -> Value {
    let mut tags: Vec<Value> = Vec::new();
    let mut out = serde_json::json!({ "tags": [], "focus": null, "faces": [], "width": null, "height": null, "orientation": 1 });
    let Ok(mut f) = File::open(path) else { return out };
    let mut buf = Vec::new();
    if (&mut f).take(256 * 1024).read_to_end(&mut buf).is_err() || buf.len() < 4 || buf[0] != 0xff || buf[1] != 0xd8 {
        return out;
    }
    let mut p = 2;
    let mut base = None;
    while p + 4 <= buf.len() && buf[p] == 0xff {
        let marker = buf[p + 1];
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        let len = u16::from_be_bytes([buf[p + 2], buf[p + 3]]) as usize;
        if marker == 0xe1 && p + 10 <= buf.len() && &buf[p + 4..p + 10] == b"Exif\0\0" {
            base = Some(p + 10);
            buf.truncate((p + 2 + len).min(buf.len()));
            break;
        }
        p += 2 + len;
    }
    let Some(base) = base else { return out };
    let Some(t) = tiff_at(&buf, base) else { return out };
    let ifd0 = t.ifd(t.u32(4) as usize);
    let exif_names = |tag| exif_name("EXIF", tag);
    tags.extend(dump_ifd(&t, &ifd0, "Image", &exif_names, &[0x8769, 0x8825, 0xc4a5]));
    out["orientation"] = t.num(Tiff::find(&ifd0, 0x0112)).unwrap_or(1).into();
    if let Some(ptr) = t.num(Tiff::find(&ifd0, 0x8825)) {
        let gps = t.ifd(ptr as usize);
        let gps_names = |tag| exif_name("GPS", tag);
        tags.extend(dump_ifd(&t, &gps, "GPS", &gps_names, &[]));
    }
    if let Some(ptr) = t.num(Tiff::find(&ifd0, 0x8769)) {
        let exif = t.ifd(ptr as usize);
        tags.extend(dump_ifd(&t, &exif, "Exif", &exif_names, &[0x927c, 0xa005]));
        out["width"] = t.num(Tiff::find(&exif, 0xa002)).into();
        out["height"] = t.num(Tiff::find(&exif, 0xa003)).into();
        if let Some(mn) = Tiff::find(&exif, 0x927c) {
            let start = base + mn.off;
            if t.ok(mn.off, 12) && &buf[start..start + 8] == b"FUJIFILM" {
                let m = Tiff { buf: &buf, base: start, little: true };
                let ifd = m.ifd(m.u32(8) as usize);
                tags.extend(dump_ifd(&m, &ifd, "Fujifilm", &fuji_name, &[]));
                if let Some(e) = Tiff::find(&ifd, 0x1023) {
                    let v = m.numbers(e);
                    if v.len() >= 2 && (v[0] > 0.0 || v[1] > 0.0) {
                        out["focus"] = serde_json::json!([v[0], v[1]]);
                    }
                }
                if let Some(e) = Tiff::find(&ifd, 0x4103) {
                    let v = m.numbers(e);
                    out["faces"] = v.chunks_exact(4).map(|c| serde_json::json!([c[0], c[1], c[2], c[3]])).collect::<Vec<_>>().into();
                }
                if let Some(r) = m.num(Tiff::find(&ifd, 0x1431)) {
                    out["rating"] = r.into();
                }
            }
        }
    }
    out["tags"] = tags.into();
    out
}
