//! Brackit Lite's file reader: the desktop app's own `jpeg.rs`, compiled to
//! WebAssembly so the web version reads Fujifilm files exactly the same way.
//!
//! No bindings generator: JS copies bytes in with `alloc`, calls a function,
//! and gets back a pointer/length pair (packed into a u64) to UTF-8 JSON or
//! raw bytes, which it frees with `dealloc`.

#[allow(dead_code)]
#[path = "../../src-tauri/src/jpeg.rs"]
mod jpeg;

use serde_json::json;

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

/// Free a buffer from `alloc` or a result, given its length.
/// # Safety
/// `ptr`/`len` must come from `alloc` or a returned result, freed once.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
}

unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    std::slice::from_raw_parts(ptr, len)
}

/// Hand bytes to JS as (pointer << 32 | length); JS frees them with `dealloc`.
fn output(bytes: Vec<u8>) -> u64 {
    let b = bytes.into_boxed_slice();
    let n = b.len() as u64;
    let p = Box::into_raw(b) as *mut u8 as u64;
    (p << 32) | n
}

fn opt<T: Into<serde_json::Value>>(v: Option<T>) -> serde_json::Value {
    v.map_or(serde_json::Value::Null, Into::into)
}

/// Header metadata of a JPEG from its first bytes (see `jpeg::meta_from_buf`).
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn meta(ptr: *const u8, len: usize) -> u64 {
    let (m, need) = jpeg::meta_from_buf(input(ptr, len));
    let range = |r: Option<(u64, u64)>| r.map_or(serde_json::Value::Null, |(s, l)| json!([s, l]));
    output(
        json!({
            "need": need,
            "make": opt(m.make),
            "model": opt(m.model),
            "orientation": m.orientation,
            "dateTime": opt(m.date_time),
            "subSec": opt(m.sub_sec),
            "width": opt(m.width.or(m.frame_width)),
            "height": opt(m.height.or(m.frame_height)),
            "filmSim": opt(m.film_sim),
            "preview": range(m.preview),
            "thumb": range(m.thumb),
            "rating": opt(m.rating),
        })
        .to_string()
        .into_bytes(),
    )
}

/// Camera settings and film recipe rows, as `[[label, value], …]`.
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn info(ptr: *const u8, len: usize) -> u64 {
    let rows: Vec<_> = jpeg::shot_info_buf(input(ptr, len)).into_iter().map(|(k, v)| json!([k, v])).collect();
    output(json!({ "rows": rows }).to_string().into_bytes())
}

/// Every tag, plus focus point and faces (see `jpeg::all_metadata`).
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn metadata(ptr: *const u8, len: usize) -> u64 {
    output(jpeg::all_metadata_buf(input(ptr, len)).to_string().into_bytes())
}

/// A cropped export: the re-encoded JPEG (`jpg`) with the original's camera
/// metadata (`head`, the original's first bytes) grafted back on.
/// # Safety
/// Both pointers must point to their lengths of readable bytes.
#[no_mangle]
pub unsafe extern "C" fn graft(head: *const u8, head_len: usize, jpg: *const u8, jpg_len: usize, w: u32, h: u32) -> u64 {
    let seg = jpeg::exif_for_edited_buf(input(head, head_len), w, h);
    output(jpeg::graft_segment(input(jpg, jpg_len), seg.as_deref()))
}

/// The tiny EXIF segment carrying only Orientation, grafted onto embedded
/// previews (which have none of their own) so browsers rotate them.
#[no_mangle]
pub extern "C" fn orientation(o: u32) -> u64 {
    output(jpeg::orientation_segment(o as u16))
}
