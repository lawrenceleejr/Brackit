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
