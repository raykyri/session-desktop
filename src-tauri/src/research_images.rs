//! Images attached to research messages.
//!
//! A pasted or dropped image is written to `.session/research-images/pending/`
//! under a random name, its id (`<32 hex digits>.<extension>`). Messages and
//! drafts store the id, never a path, so the store can be found again from
//! the workspace root alone. Creating a message or saving a draft that
//! references an image moves it into `.session/research-images/`. When the
//! last message or draft that references it is permanently deleted, and that
//! state is written, the image is removed, unless it was attached within
//! [`PENDING_LIFETIME`]: then it moves back to `pending/` for a composer that
//! may still hold it. A message removed because its run failed to launch
//! returns its images to pending whatever their age.
//!
//! The frontend keeps unsent images in composers and in a thread's queue of
//! follow-ups (stored in the webview across restarts), which the backend
//! cannot see. Pending images that no node or draft references are therefore
//! removed once they are older than [`PENDING_LIFETIME`], at startup and
//! whenever an image is saved. A clean startup also moves stored images that
//! nothing references to pending. Removing a workspace folder copies its
//! messages' images into the folder's archive and releases them here; adding
//! the folder back copies them into the store again.

use std::borrow::Cow;
use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use base64::{Engine as _, engine::general_purpose::STANDARD};

use crate::tweets::ResearchMessageAttachment;

/// Largest image a message can carry: the Claude API's limit per image.
/// Larger PNG and JPEG images are downscaled when saved.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// Largest image accepted from a paste or drop, before downscaling.
pub const MAX_INPUT_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// Largest stored image that still loads: images saved before downscaling
/// were kept up to 10 MB. Launches refuse anything over [`MAX_IMAGE_BYTES`].
const MAX_STORED_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// Most image bytes one message can carry, which bounds the run's stdin
/// (Claude Code takes them base64 encoded) and memory.
pub const MAX_MESSAGE_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// Longest side an image keeps without downscaling; the Claude API refuses
/// larger images.
const MAX_IMAGE_SIDE: u32 = 8000;
/// Longest side of a downscaled image.
const DOWNSCALED_IMAGE_SIDE: u32 = 2048;
/// Largest decoded image, in bytes of pixel data.
const MAX_DECODED_IMAGE_BYTES: u64 = 512 * 1024 * 1024;
/// Most images one message can carry.
pub const MAX_IMAGES_PER_MESSAGE: usize = 8;
/// Longest kept original file name, in characters.
const MAX_FILE_NAME_CHARS: usize = 255;
/// How long an image nothing references is kept for a composer or queue that
/// may still send it.
const PENDING_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

/// Held from checking that a message's images exist through inserting the
/// message and moving its images into the store, and from reading which
/// images are referenced through releasing the others, so a release cannot
/// remove an image a message being created is about to reference.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Takes [`STORE_LOCK`]. Lock order: the research document lock, then this
/// lock, then the persistence lock, then the model lock.
pub fn lock_store() -> MutexGuard<'static, ()> {
    STORE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageFormat {
    const ALL: [Self; 4] = [Self::Png, Self::Jpeg, Self::Gif, Self::Webp];

    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
        }
    }

    fn from_extension(extension: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|format| format.extension() == extension)
    }

    pub fn from_mime_type(mime_type: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|format| format.mime_type() == mime_type)
    }

    /// The format named by the file's leading bytes. The extension or MIME
    /// type a caller reports is never trusted.
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Self::Png)
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            Some(Self::Jpeg)
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            Some(Self::Gif)
        } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(Self::Webp)
        } else {
            None
        }
    }
}

fn be_u16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes(
        bytes.get(at..at + 2)?.try_into().ok()?,
    )))
}

fn le_u16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_le_bytes(
        bytes.get(at..at + 2)?.try_into().ok()?,
    )))
}

fn le_u24(bytes: &[u8], at: usize) -> Option<u32> {
    let b = bytes.get(at..at + 3)?;
    Some(u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16)
}

/// Pixel width and height read from the image header, or None when the
/// header is truncated or unusual. Display uses them only to reserve space.
pub fn dimensions(format: ImageFormat, bytes: &[u8]) -> Option<(u32, u32)> {
    let size = match format {
        ImageFormat::Png => {
            if bytes.get(12..16)? != b"IHDR" {
                return None;
            }
            let width = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
            let height = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?);
            (width, height)
        }
        ImageFormat::Gif => (le_u16(bytes, 6)?, le_u16(bytes, 8)?),
        ImageFormat::Webp => match bytes.get(12..16)? {
            b"VP8 " => (le_u16(bytes, 26)? & 0x3fff, le_u16(bytes, 28)? & 0x3fff),
            b"VP8L" => {
                let b = bytes.get(21..25)?;
                let (b0, b1, b2, b3) = (
                    u32::from(b[0]),
                    u32::from(b[1]),
                    u32::from(b[2]),
                    u32::from(b[3]),
                );
                (
                    1 + (((b1 & 0x3f) << 8) | b0),
                    1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
                )
            }
            b"VP8X" => (1 + le_u24(bytes, 24)?, 1 + le_u24(bytes, 27)?),
            _ => return None,
        },
        ImageFormat::Jpeg => jpeg_dimensions(bytes)?,
    };
    (size.0 > 0 && size.1 > 0).then_some(size)
}

/// Walks the JPEG marker segments to the first start-of-frame segment.
fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    loop {
        if *bytes.get(at)? != 0xff {
            return None;
        }
        let marker = *bytes.get(at + 1)?;
        match marker {
            // Fill bytes before a marker.
            0xff => at += 1,
            // Markers without a length.
            0x01 | 0xd0..=0xd7 => at += 2,
            // Start of frame (not DHT, JPG, or DAC, which share the range).
            0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => {
                return Some((be_u16(bytes, at + 7)?, be_u16(bytes, at + 5)?));
            }
            // Start of scan or end of image before a frame header.
            0xd9 | 0xda => return None,
            _ => at += 2 + usize::try_from(be_u16(bytes, at + 2)?).ok()?,
        }
    }
}

pub fn store_dir(workspace_root: &Path) -> PathBuf {
    workspace_root
        .join(crate::persistence::STATE_DIR)
        .join("research-images")
}

fn pending_dir(workspace_root: &Path) -> PathBuf {
    store_dir(workspace_root).join("pending")
}

/// An id names a file directly in the store: 32 lowercase hex digits and
/// the extension of a supported format. Nothing else can resolve to a path.
pub fn is_image_id(id: &str) -> bool {
    let Some((stem, extension)) = id.split_once('.') else {
        return false;
    };
    stem.len() == 32
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && ImageFormat::from_extension(extension).is_some()
}

fn new_image_id(format: ImageFormat) -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| format!("failed to name the image file: {err}"))?;
    let stem = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{stem}.{}", format.extension()))
}

/// The original file name, reduced to its last path component without
/// control characters, or None when nothing is left.
pub fn clean_file_name(name: Option<&str>) -> Option<String> {
    let name = name?.rsplit(['/', '\\']).next()?;
    let cleaned = name
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_FILE_NAME_CHARS)
        .collect::<String>();
    let cleaned = cleaned.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_string())
}

fn too_large() -> String {
    format!(
        "Images must be {} MB or smaller.",
        MAX_INPUT_IMAGE_BYTES / (1024 * 1024)
    )
}

fn too_large_to_send() -> String {
    format!(
        "GIF and WebP images must be {} MB or smaller.",
        MAX_IMAGE_BYTES / (1024 * 1024)
    )
}

fn message_too_large() -> String {
    format!(
        "A message's images can total {} MB at most.",
        MAX_MESSAGE_IMAGE_BYTES / (1024 * 1024)
    )
}

/// Whether the image crate decodes this format here (PNG and JPEG).
fn decodes(format: ImageFormat) -> bool {
    matches!(format, ImageFormat::Png | ImageFormat::Jpeg)
}

/// Decodes a PNG or JPEG image, upright (a JPEG's EXIF orientation is
/// applied, since re-encoding drops it). Width, height, and pixel memory are
/// capped.
fn decode(format: ImageFormat, bytes: &[u8]) -> Result<image::DynamicImage, String> {
    use image::ImageDecoder as _;
    let format = match format {
        ImageFormat::Png => image::ImageFormat::Png,
        ImageFormat::Jpeg => image::ImageFormat::Jpeg,
        ImageFormat::Gif | ImageFormat::Webp => return Err(unsupported()),
    };
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(MAX_DECODED_IMAGE_BYTES);
    reader.limits(limits);
    let failed = |err: image::ImageError| format!("The image could not be read: {err}");
    let mut decoder = reader.into_decoder().map_err(failed)?;
    let orientation = decoder.orientation().map_err(failed)?;
    let mut decoded = image::DynamicImage::from_decoder(decoder).map_err(failed)?;
    decoded.apply_orientation(orientation);
    Ok(decoded)
}

/// The image as a JPEG, with any transparency over white.
fn encode_jpeg(image: &image::DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let rgb = if image.color().has_alpha() {
        let rgba = image.to_rgba8();
        let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
        for (target, source) in rgb.pixels_mut().zip(rgba.pixels()) {
            let [r, g, b, a] = source.0;
            let over_white = |channel: u8| {
                ((u16::from(channel) * u16::from(a) + 255 * (255 - u16::from(a))) / 255) as u8
            };
            *target = image::Rgb([over_white(r), over_white(g), over_white(b)]);
        }
        rgb
    } else {
        image.to_rgb8()
    };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
        .encode_image(&rgb)
        .map_err(|err| format!("failed to encode the image: {err}"))?;
    Ok(out)
}

/// The bytes to store for a pasted or dropped image. A PNG or JPEG over
/// [`MAX_IMAGE_BYTES`] or [`MAX_IMAGE_SIDE`] is downscaled to
/// [`DOWNSCALED_IMAGE_SIDE`] and re-encoded as JPEG; the original is not
/// kept. A GIF or WebP image (not decoded here) must already fit.
fn prepare_image(
    format: ImageFormat,
    bytes: &[u8],
) -> Result<(ImageFormat, Cow<'_, [u8]>), String> {
    let oversized_side =
        dimensions(format, bytes).is_some_and(|(width, height)| width.max(height) > MAX_IMAGE_SIDE);
    if bytes.len() as u64 <= MAX_IMAGE_BYTES && !oversized_side {
        return Ok((format, Cow::Borrowed(bytes)));
    }
    if !decodes(format) {
        return Err(if oversized_side {
            format!("GIF and WebP images must be at most {MAX_IMAGE_SIDE} pixels on each side.")
        } else {
            too_large_to_send()
        });
    }
    let decoded = decode(format, bytes)?;
    let scaled = if decoded.width().max(decoded.height()) > DOWNSCALED_IMAGE_SIDE {
        decoded.resize(
            DOWNSCALED_IMAGE_SIDE,
            DOWNSCALED_IMAGE_SIDE,
            image::imageops::FilterType::Triangle,
        )
    } else {
        decoded
    };
    let encoded = encode_jpeg(&scaled, 85)?;
    if encoded.len() as u64 > MAX_IMAGE_BYTES {
        return Err(format!(
            "The image is still over {} MB after downscaling.",
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    Ok((ImageFormat::Jpeg, Cow::Owned(encoded)))
}

fn unsupported() -> String {
    "Only PNG, JPEG, GIF, and WebP images can be attached.".to_string()
}

fn attachment_from_bytes(
    id: String,
    format: ImageFormat,
    bytes: &[u8],
    file_name: Option<&str>,
) -> ResearchMessageAttachment {
    let size = dimensions(format, bytes);
    ResearchMessageAttachment::Image {
        id,
        mime_type: format.mime_type().to_string(),
        byte_size: bytes.len() as u64,
        width: size.map(|(width, _)| width),
        height: size.map(|(_, height)| height),
        file_name: clean_file_name(file_name),
    }
}

/// Writes a pasted or dropped image to the pending store and returns its
/// attachment.
pub fn save_pending(
    workspace_root: &Path,
    bytes: &[u8],
    file_name: Option<&str>,
) -> Result<ResearchMessageAttachment, String> {
    if bytes.is_empty() {
        return Err("The image is empty.".to_string());
    }
    if bytes.len() as u64 > MAX_INPUT_IMAGE_BYTES {
        return Err(too_large());
    }
    let format = ImageFormat::sniff(bytes).ok_or_else(unsupported)?;
    let (format, bytes) = prepare_image(format, bytes)?;
    let bytes = bytes.as_ref();
    let dir = pending_dir(workspace_root);
    fs::create_dir_all(&dir).map_err(|err| format!("failed to create {}: {err}", dir.display()))?;
    let id = new_image_id(format)?;
    let path = dir.join(&id);
    let partial = dir.join(format!("{id}.tmp"));
    fs::write(&partial, bytes)
        .and_then(|()| fs::rename(&partial, &path))
        .map_err(|err| {
            let _ = fs::remove_file(&partial);
            format!("failed to save the image: {err}")
        })?;
    Ok(attachment_from_bytes(id, format, bytes, file_name))
}

/// Directories a dropped image file may come from: the home directory, the
/// temporary directory, and on macOS `/Volumes`, where removable drives and
/// disk images mount. The paths come from the webview, so they are confined
/// the way transcript image reads are (`crate::image_files`).
fn import_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| !home.as_os_str().is_empty())
    {
        roots.push(home);
    }
    roots.push(std::env::temp_dir());
    if cfg!(target_os = "macos") {
        roots.push(PathBuf::from("/Volumes"));
    }
    roots
}

/// Copies an image file the user dropped on a composer into the pending
/// store. The window receives native file drops as paths, not bytes.
pub fn import_pending(
    workspace_root: &Path,
    path: &Path,
) -> Result<ResearchMessageAttachment, String> {
    import_pending_within(workspace_root, path, &import_roots())
}

/// [`import_pending`] with the allowed directories given, for tests. The
/// path is canonicalized first (resolving symlinks and `..`), so a link
/// inside an allowed directory to a file outside it is refused; the file
/// opened is the canonical one.
fn import_pending_within(
    workspace_root: &Path,
    path: &Path,
    allowed_roots: &[PathBuf],
) -> Result<ResearchMessageAttachment, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    let allowed = allowed_roots
        .iter()
        .any(|root| fs::canonicalize(root).is_ok_and(|root| canonical.starts_with(root)));
    if !allowed {
        return Err(
            "Only images from your home folder, a temporary folder, or a mounted drive can be attached."
                .to_string(),
        );
    }
    let file = fs::File::open(&canonical)
        .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    if !metadata.is_file() {
        return Err(unsupported());
    }
    if metadata.len() > MAX_INPUT_IMAGE_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    file.take(MAX_INPUT_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    let name = path.file_name().and_then(|name| name.to_str());
    save_pending(workspace_root, &bytes, name)
}

/// The file holding image `id`: stored, else pending.
pub fn image_path(workspace_root: &Path, id: &str) -> Option<PathBuf> {
    if !is_image_id(id) {
        return None;
    }
    [store_dir(workspace_root), pending_dir(workspace_root)]
        .into_iter()
        .map(|dir| dir.join(id))
        .find(|path| {
            fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
        })
}

fn read_image(workspace_root: &Path, id: &str) -> Result<(ImageFormat, Vec<u8>), String> {
    let path = image_path(workspace_root, id).ok_or_else(|| {
        "An attached image is no longer available. Remove it and attach it again.".to_string()
    })?;
    let file = fs::File::open(&path).map_err(|err| format!("failed to open the image: {err}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_STORED_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("failed to read the image: {err}"))?;
    if bytes.len() as u64 > MAX_STORED_IMAGE_BYTES {
        return Err(too_large());
    }
    let format = ImageFormat::sniff(&bytes).ok_or_else(unsupported)?;
    if !id.ends_with(&format!(".{}", format.extension())) {
        return Err(unsupported());
    }
    Ok((format, bytes))
}

/// The attachment for a stored or pending image, from the file itself. A
/// caller names only the id and the original file name; the type, size, and
/// dimensions are read again.
pub fn attachment_for(
    workspace_root: &Path,
    id: &str,
    file_name: Option<&str>,
) -> Result<ResearchMessageAttachment, String> {
    let (format, bytes) = read_image(workspace_root, id)?;
    Ok(attachment_from_bytes(
        id.to_string(),
        format,
        &bytes,
        file_name,
    ))
}

/// The image as a `data:` URL for an `<img>` in the webview, whose content
/// security policy allows no file URLs.
pub fn read_data_url(workspace_root: &Path, id: &str) -> Result<String, String> {
    let (format, bytes) = read_image(workspace_root, id)?;
    Ok(format!(
        "data:{};base64,{}",
        format.mime_type(),
        STANDARD.encode(bytes)
    ))
}

pub fn image_ids(attachments: &[ResearchMessageAttachment]) -> impl Iterator<Item = &str> {
    attachments
        .iter()
        .filter_map(|attachment| match attachment {
            ResearchMessageAttachment::Image { id, .. } => Some(id.as_str()),
            ResearchMessageAttachment::Tweet { .. } | ResearchMessageAttachment::Unknown(_) => None,
        })
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

fn move_file(from: &Path, to_dir: &Path, id: &str) {
    if !is_regular_file(from) {
        return;
    }
    let target = to_dir.join(id);
    let result = fs::create_dir_all(to_dir).and_then(|()| {
        if is_regular_file(&target) {
            fs::remove_file(from)
        } else {
            fs::rename(from, &target)
        }
    });
    if let Err(err) = result {
        eprintln!("session: failed to move research image {id}: {err}");
    }
}

/// Copies the image files of a detached research archive into the store, as
/// the folder is added back. An image already here is kept (and moved into
/// the store if pending). Failures are logged; the message then shows the
/// image as unavailable.
pub fn import_archived(workspace_root: &Path, images: &[(String, PathBuf)]) {
    let store = store_dir(workspace_root);
    for (id, source) in images.iter().filter(|(id, _)| is_image_id(id)) {
        if image_path(workspace_root, id).is_some() {
            commit(workspace_root, [id.as_str()]);
            continue;
        }
        let target = store.join(id);
        let partial = store.join(format!("{id}.tmp"));
        let result = fs::create_dir_all(&store)
            .and_then(|()| fs::copy(source, &partial))
            .and_then(|_| fs::rename(&partial, &target));
        if let Err(err) = result {
            let _ = fs::remove_file(&partial);
            eprintln!("session: failed to import research image {id}: {err}");
        }
    }
}

/// Moves pending images a message or draft now references into the store.
pub fn commit<'a>(workspace_root: &Path, ids: impl IntoIterator<Item = &'a str>) {
    let store = store_dir(workspace_root);
    let pending = pending_dir(workspace_root);
    for id in ids.into_iter().filter(|id| is_image_id(id)) {
        move_file(&pending.join(id), &store, id);
    }
}

/// Errors unless every image in `attachments` is stored or pending. Checked
/// under [`lock_store`] just before a message that attaches them is
/// inserted.
pub fn ensure_available(
    workspace_root: &Path,
    attachments: &[ResearchMessageAttachment],
) -> Result<(), String> {
    if image_ids(attachments).all(|id| image_path(workspace_root, id).is_some()) {
        Ok(())
    } else {
        Err("An attached image is no longer available. Remove it and attach it again.".to_string())
    }
}

/// Removes stored images nothing references any more. One attached within
/// [`PENDING_LIFETIME`] moves back to pending instead, for a composer that
/// may send it again. Call only after the state without the references is
/// written.
pub fn release<'a>(workspace_root: &Path, ids: impl IntoIterator<Item = &'a str>) {
    let store = store_dir(workspace_root);
    let pending = pending_dir(workspace_root);
    for id in ids.into_iter().filter(|id| is_image_id(id)) {
        let path = store.join(id);
        if file_older_than(&path, PENDING_LIFETIME) {
            remove_logged(&path);
        } else {
            move_file(&path, &pending, id);
        }
    }
}

/// Moves stored images back to pending whatever their age, and restarts
/// their pending lifetime: for a message removed because its run failed to
/// launch, whose composer still holds its images to send again.
pub fn return_to_pending<'a>(workspace_root: &Path, ids: impl IntoIterator<Item = &'a str>) {
    let store = store_dir(workspace_root);
    let pending = pending_dir(workspace_root);
    for id in ids.into_iter().filter(|id| is_image_id(id)) {
        move_file(&store.join(id), &pending, id);
        touch(&pending.join(id));
    }
}

/// Sets the file's modification time to now, which starts its pending
/// lifetime again.
fn touch(path: &Path) {
    if !is_regular_file(path) {
        return;
    }
    if let Err(err) = fs::File::options()
        .write(true)
        .open(path)
        .and_then(|file| file.set_modified(SystemTime::now()))
    {
        eprintln!("session: failed to touch {}: {err}", path.display());
    }
}

fn remove_logged(path: &Path) {
    if let Err(err) = fs::remove_file(path)
        && err.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!("session: failed to remove {}: {err}", path.display());
    }
}

fn file_older_than(path: &Path, age: Duration) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|elapsed| elapsed > age)
}

/// Startup pass over the store after a clean load: stored images that no
/// node or draft references (left by a crash between moving them into the
/// store and writing the message, or between removing the last reference
/// and writing that) move to pending with a fresh lifetime instead of being
/// removed. Never run off a degraded load, whose state may be missing nodes.
pub fn reconcile_store(workspace_root: &Path, referenced: &HashSet<String>) {
    let Ok(entries) = fs::read_dir(store_dir(workspace_root)) else {
        return;
    };
    let pending = pending_dir(workspace_root);
    for path in entries.flatten().map(|entry| entry.path()) {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if is_image_id(name) && !referenced.contains(name) && is_regular_file(&path) {
            move_file(&path, &pending, name);
            touch(&pending.join(name));
        }
    }
}

/// Startup pass over the pending store: images state references move into
/// the store (a crash between saving a message and moving its images leaves
/// them pending); others older than [`PENDING_LIFETIME`] are removed.
pub fn sweep_pending(workspace_root: &Path, referenced: &HashSet<String>) {
    let Ok(entries) = fs::read_dir(pending_dir(workspace_root)) else {
        return;
    };
    let store = store_dir(workspace_root);
    for path in entries.flatten().map(|entry| entry.path()) {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if referenced.contains(name) {
            move_file(&path, &store, name);
        } else if file_older_than(&path, PENDING_LIFETIME) {
            remove_logged(&path);
        }
    }
}

/// Removes pending images older than [`PENDING_LIFETIME`] that no node or
/// draft references (`in_use`), run whenever an image is saved. A composer or
/// queue that kept an image that long gets "no longer available" when it
/// sends. Referenced pending images (after a crash, or a degraded load that
/// skipped [`sweep_pending`]) are kept.
pub fn sweep_stale_pending(workspace_root: &Path, in_use: &HashSet<String>) {
    let Ok(entries) = fs::read_dir(pending_dir(workspace_root)) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let referenced = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| in_use.contains(name));
        if !referenced && file_older_than(&path, PENDING_LIFETIME) {
            remove_logged(&path);
        }
    }
}

/// Makes a file look older, for tests of the pending lifetime.
#[cfg(test)]
pub fn age_file_for_test(path: &Path) {
    fs::File::options()
        .write(true)
        .open(path)
        .and_then(|file| file.set_modified(SystemTime::now() - PENDING_LIFETIME * 2))
        .unwrap();
}

/// Image fields as the frontend sends them with a question or draft.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub id: String,
    #[serde(default)]
    pub file_name: Option<String>,
}

/// Attachments for the images a question or draft names, read from their
/// files.
pub fn attachments_for_inputs(
    workspace_root: &Path,
    inputs: &[ImageInput],
) -> Result<Vec<ResearchMessageAttachment>, String> {
    if inputs.len() > MAX_IMAGES_PER_MESSAGE {
        return Err(format!(
            "A message can include up to {MAX_IMAGES_PER_MESSAGE} images."
        ));
    }
    let mut seen = HashSet::new();
    let attachments = inputs
        .iter()
        .filter(|input| seen.insert(input.id.as_str()))
        .map(|input| attachment_for(workspace_root, &input.id, input.file_name.as_deref()))
        .collect::<Result<Vec<_>, _>>()?;
    let total = attachments
        .iter()
        .map(|attachment| match attachment {
            ResearchMessageAttachment::Image { byte_size, .. } => *byte_size,
            _ => 0,
        })
        .sum::<u64>();
    if total > MAX_MESSAGE_IMAGE_BYTES {
        return Err(message_too_large());
    }
    Ok(attachments)
}

/// Field checks for a stored image attachment; the file itself is not
/// consulted, so a missing file does not make a message unloadable.
pub fn validate_attachment(
    id: &str,
    mime_type: &str,
    byte_size: u64,
    file_name: Option<&str>,
) -> Result<(), String> {
    let format = ImageFormat::from_mime_type(mime_type);
    let matches_id = format.is_some_and(|format| id.ends_with(&format!(".{}", format.extension())));
    if !is_image_id(id)
        || !matches_id
        || byte_size == 0
        || byte_size > MAX_STORED_IMAGE_BYTES
        || file_name.is_some_and(|name| clean_file_name(Some(name)).as_deref() != Some(name))
    {
        return Err("research message contains an invalid image attachment".to_string());
    }
    Ok(())
}

/// Whether an agent's research runtime sends images: Claude Code takes
/// them as content blocks of the user message, Codex as `--image` files.
/// Grok's headless mode has no image input.
pub fn adapter_reads_images(adapter: &str) -> bool {
    matches!(adapter, "claude" | "codex")
}

fn adapter_label(adapter: &str) -> &str {
    match adapter {
        "claude" => "Claude",
        "codex" => "Codex",
        "grok" => "Grok",
        other => other,
    }
}

/// Refuses a message with images for an agent that cannot read them,
/// instead of sending the text without them. Checked when the message is
/// created and again before each launch. `codex exec` splits an `--image`
/// value at commas, so Codex is refused when the image store's path has one.
pub fn ensure_adapter_reads_images(
    workspace_root: &Path,
    adapter: &str,
    attachments: &[ResearchMessageAttachment],
) -> Result<(), String> {
    if image_ids(attachments).next().is_none() {
        return Ok(());
    }
    if !adapter_reads_images(adapter) {
        return Err(format!("{} can't read images.", adapter_label(adapter)));
    }
    let store = store_dir(workspace_root);
    if adapter == "codex" && store.to_string_lossy().contains(',') {
        return Err(format!(
            "Codex can't read images stored in {}: the path contains a comma.",
            store.display()
        ));
    }
    Ok(())
}

/// An image to send with a run's prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchImage {
    pub path: PathBuf,
    pub format: ImageFormat,
}

impl LaunchImage {
    /// The image as a base64 `image` content block of a Claude user message.
    pub fn claude_content_block(&self) -> Result<serde_json::Value, String> {
        let bytes = fs::read(&self.path).map_err(|err| {
            format!(
                "failed to read the attached image {}: {err}",
                self.path.display()
            )
        })?;
        Ok(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": self.format.mime_type(),
                "data": STANDARD.encode(bytes),
            }
        }))
    }
}

/// The images of the message a run sends, in message order, after
/// [`ensure_adapter_reads_images`]. Every image must still exist: a run never
/// goes out with some of its images missing.
pub fn launch_images(
    workspace_root: &Path,
    adapter: &str,
    attachments: &[ResearchMessageAttachment],
) -> Result<Vec<LaunchImage>, String> {
    ensure_adapter_reads_images(workspace_root, adapter, attachments)?;
    let mut total = 0u64;
    attachments
        .iter()
        .filter_map(|attachment| match attachment {
            ResearchMessageAttachment::Image { id, mime_type, .. } => Some((id, mime_type)),
            ResearchMessageAttachment::Tweet { .. } | ResearchMessageAttachment::Unknown(_) => None,
        })
        .map(|(id, mime_type)| {
            let path = image_path(workspace_root, id).ok_or_else(|| {
                "An attached image is no longer available, so the question cannot be sent."
                    .to_string()
            })?;
            let format = ImageFormat::from_mime_type(mime_type).ok_or_else(unsupported)?;
            // The run reads each file whole, so check the size on disk.
            let size = fs::metadata(&path)
                .map_err(|err| format!("failed to read the attached image: {err}"))?
                .len();
            if size > MAX_IMAGE_BYTES {
                return Err(format!(
                    "An attached image is over {} MB. Remove it and attach it again to downscale it.",
                    MAX_IMAGE_BYTES / (1024 * 1024)
                ));
            }
            total += size;
            if total > MAX_MESSAGE_IMAGE_BYTES {
                return Err(message_too_large());
            }
            Ok(LaunchImage { path, format })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("session-research-images-{nanos}-{seq}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }

    #[test]
    fn sniffs_formats_and_reads_dimensions() {
        assert_eq!(ImageFormat::sniff(&png(3, 2)), Some(ImageFormat::Png));
        assert_eq!(
            dimensions(ImageFormat::Png, &png(640, 480)),
            Some((640, 480))
        );

        let gif = b"GIF89a\x40\x01\xf0\x00".to_vec();
        assert_eq!(ImageFormat::sniff(&gif), Some(ImageFormat::Gif));
        assert_eq!(dimensions(ImageFormat::Gif, &gif), Some((320, 240)));

        // SOI, an APP0 segment, then a baseline SOF0 frame header.
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
        jpeg.extend([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80]);
        assert_eq!(ImageFormat::sniff(&jpeg), Some(ImageFormat::Jpeg));
        assert_eq!(dimensions(ImageFormat::Jpeg, &jpeg), Some((640, 480)));

        let mut webp_x = b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0\0\0\0\0".to_vec();
        webp_x.extend([0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]);
        assert_eq!(ImageFormat::sniff(&webp_x), Some(ImageFormat::Webp));
        assert_eq!(dimensions(ImageFormat::Webp, &webp_x), Some((640, 480)));

        let mut webp_lossy = b"RIFF\0\0\0\0WEBPVP8 \0\0\0\0\0\0\0\x9d\x01\x2a".to_vec();
        webp_lossy.extend([0x80, 0x02, 0xe0, 0x01]);
        assert_eq!(dimensions(ImageFormat::Webp, &webp_lossy), Some((640, 480)));

        assert_eq!(ImageFormat::sniff(b"<svg/>"), None);
        assert_eq!(dimensions(ImageFormat::Jpeg, &[0xff, 0xd8, 0xff]), None);
    }

    #[test]
    fn ids_name_only_store_files() {
        assert!(is_image_id("0123456789abcdef0123456789abcdef.png"));
        assert!(is_image_id("0123456789abcdef0123456789abcdef.webp"));
        assert!(!is_image_id("0123456789ABCDEF0123456789abcdef.png"));
        assert!(!is_image_id("../0123456789abcdef0123456789abcd.png"));
        assert!(!is_image_id("0123456789abcdef0123456789abcdef.svg"));
        assert!(!is_image_id("0123456789abcdef0123456789abcdef.png.tmp"));
        assert!(!is_image_id("0123456789abcdef0123456789abcdef"));
    }

    #[test]
    fn file_names_keep_the_last_component_without_control_characters() {
        assert_eq!(
            clean_file_name(Some("/Users/me/Shot\n 1.png")).as_deref(),
            Some("Shot 1.png")
        );
        assert_eq!(
            clean_file_name(Some("C:\\a\\b.jpg")).as_deref(),
            Some("b.jpg")
        );
        assert_eq!(clean_file_name(Some("  ")), None);
        assert_eq!(clean_file_name(None), None);
    }

    #[test]
    fn saved_images_move_between_pending_and_the_store() {
        let root = temp_root();
        let attachment = save_pending(&root, &png(4, 3), Some("shot.png")).unwrap();
        let ResearchMessageAttachment::Image {
            id,
            mime_type,
            byte_size,
            width,
            height,
            file_name,
        } = &attachment
        else {
            panic!("expected an image attachment");
        };
        assert_eq!(mime_type, "image/png");
        assert_eq!(*byte_size, png(4, 3).len() as u64);
        assert_eq!((*width, *height), (Some(4), Some(3)));
        assert_eq!(file_name.as_deref(), Some("shot.png"));
        validate_attachment(id, mime_type, *byte_size, file_name.as_deref()).unwrap();
        assert!(pending_dir(&root).join(id).is_file());

        // The attachment is rebuilt from the file, not from caller fields.
        let rebuilt = attachment_for(&root, id, Some("other.png")).unwrap();
        assert!(matches!(
            &rebuilt,
            ResearchMessageAttachment::Image { file_name: Some(name), byte_size: size, .. }
                if name == "other.png" && size == byte_size
        ));
        assert!(
            read_data_url(&root, id)
                .unwrap()
                .starts_with("data:image/png;base64,")
        );

        commit(&root, [id.as_str()]);
        assert!(store_dir(&root).join(id).is_file());
        assert!(!pending_dir(&root).join(id).exists());
        assert_eq!(image_path(&root, id), Some(store_dir(&root).join(id)));

        // A recent image goes back to pending when released.
        release(&root, [id.as_str()]);
        assert!(pending_dir(&root).join(id).is_file());

        // Startup stores referenced pending images and removes the others
        // once they are older than the pending lifetime.
        let fresh = save_pending(&root, &png(1, 1), None).unwrap();
        let stale = save_pending(&root, &png(1, 2), None).unwrap();
        let (
            ResearchMessageAttachment::Image { id: fresh_id, .. },
            ResearchMessageAttachment::Image { id: stale_id, .. },
        ) = (&fresh, &stale)
        else {
            panic!("expected image attachments");
        };
        age_file_for_test(&pending_dir(&root).join(id));
        age_file_for_test(&pending_dir(&root).join(stale_id));
        sweep_pending(&root, &HashSet::from([id.clone()]));
        assert!(store_dir(&root).join(id).is_file());
        assert!(pending_dir(&root).join(fresh_id).is_file());
        assert!(image_path(&root, stale_id).is_none());
        assert!(attachment_for(&root, stale_id, None).is_err());

        // An old image is removed when released.
        age_file_for_test(&store_dir(&root).join(id));
        release(&root, [id.as_str()]);
        assert!(image_path(&root, id).is_none());

        // The stale sweep removes old pending images unless state
        // references them.
        let referenced = save_pending(&root, &png(1, 3), None).unwrap();
        let ResearchMessageAttachment::Image {
            id: referenced_id, ..
        } = &referenced
        else {
            panic!("expected an image attachment");
        };
        age_file_for_test(&pending_dir(&root).join(fresh_id));
        age_file_for_test(&pending_dir(&root).join(referenced_id));
        sweep_stale_pending(&root, &HashSet::from([referenced_id.clone()]));
        assert!(image_path(&root, fresh_id).is_none());
        assert!(pending_dir(&root).join(referenced_id).is_file());

        // A launch rollback returns an old stored image to pending with a
        // fresh lifetime instead of removing it.
        commit(&root, [referenced_id.as_str()]);
        age_file_for_test(&store_dir(&root).join(referenced_id));
        return_to_pending(&root, [referenced_id.as_str()]);
        assert!(pending_dir(&root).join(referenced_id).is_file());
        sweep_stale_pending(&root, &HashSet::new());
        assert!(pending_dir(&root).join(referenced_id).is_file());

        // Startup moves unreferenced stored images to pending, fresh.
        commit(&root, [referenced_id.as_str()]);
        let kept = save_pending(&root, &png(1, 4), None).unwrap();
        let ResearchMessageAttachment::Image { id: kept_id, .. } = &kept else {
            panic!("expected an image attachment");
        };
        commit(&root, [kept_id.as_str()]);
        age_file_for_test(&store_dir(&root).join(referenced_id));
        reconcile_store(&root, &HashSet::from([kept_id.clone()]));
        assert!(store_dir(&root).join(kept_id).is_file());
        assert!(pending_dir(&root).join(referenced_id).is_file());
        assert!(!file_older_than(
            &pending_dir(&root).join(referenced_id),
            PENDING_LIFETIME
        ));
        assert!(ensure_available(&root, &[kept.clone()]).is_ok());
        fs::remove_file(store_dir(&root).join(kept_id)).unwrap();
        assert!(ensure_available(&root, &[kept]).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dropped_files_are_confined_to_the_allowed_directories() {
        let root = temp_root();
        let allowed = root.join("allowed");
        let outside = root.join("outside");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let roots = [allowed.clone()];
        let inside = allowed.join("shot.png");
        fs::write(&inside, png(2, 2)).unwrap();
        import_pending_within(&root, &inside, &roots).unwrap();

        let external = outside.join("external.png");
        fs::write(&external, png(2, 2)).unwrap();
        assert!(
            import_pending_within(&root, &external, &roots)
                .unwrap_err()
                .contains("home folder")
        );
        // `..` and a symlink are resolved before the check.
        let dotted = allowed.join("../outside/external.png");
        assert!(import_pending_within(&root, &dotted, &roots).is_err());
        let link = allowed.join("link.png");
        std::os::unix::fs::symlink(&external, &link).unwrap();
        assert!(import_pending_within(&root, &link, &roots).is_err());
        // A link that stays inside is followed.
        let inner_link = allowed.join("inner.png");
        std::os::unix::fs::symlink(&inside, &inner_link).unwrap();
        import_pending_within(&root, &inner_link, &roots).unwrap();
        assert!(import_pending_within(&root, &allowed.join("missing.png"), &roots).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dropped_files_are_copied_with_their_name() {
        let root = temp_root();
        let source = root.join("Dropped shot.png");
        fs::write(&source, png(5, 6)).unwrap();
        let roots = [root.clone()];
        let attachment = import_pending_within(&root, &source, &roots).unwrap();
        assert!(matches!(
            &attachment,
            ResearchMessageAttachment::Image { file_name: Some(name), width: Some(5), .. }
                if name == "Dropped shot.png"
        ));
        assert!(source.is_file());
        let text = root.join("notes.txt");
        fs::write(&text, "not an image").unwrap();
        assert!(
            import_pending_within(&root, &text, &roots)
                .unwrap_err()
                .contains("PNG")
        );
        assert!(import_pending_within(&root, &root, &roots).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn save_rejects_unsupported_empty_and_oversized_images() {
        let root = temp_root();
        assert!(
            save_pending(&root, b"<svg/>", None)
                .unwrap_err()
                .contains("PNG")
        );
        assert!(
            save_pending(&root, b"", None)
                .unwrap_err()
                .contains("empty")
        );
        let mut huge = png(1, 1);
        huge.resize(MAX_INPUT_IMAGE_BYTES as usize + 1, 0);
        assert!(
            save_pending(&root, &huge, None)
                .unwrap_err()
                .contains("20 MB")
        );
        // GIF and WebP images are not downscaled.
        let mut gif = b"GIF89a\x40\x01\xf0\x00".to_vec();
        gif.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        assert!(
            save_pending(&root, &gif, None)
                .unwrap_err()
                .contains("GIF and WebP images must be 5 MB")
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// A real PNG of noise, which does not compress.
    fn noise_png(width: u32, height: u32) -> Vec<u8> {
        let mut state = 0x2545_f491_u32;
        let pixels = image::RgbaImage::from_fn(width, height, |_, _| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            image::Rgba(state.to_le_bytes())
        });
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(pixels)
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn large_images_are_downscaled_to_jpeg_on_save() {
        let root = temp_root();
        let large = noise_png(1500, 1000);
        assert!(large.len() as u64 > MAX_IMAGE_BYTES);
        let attachment = save_pending(&root, &large, Some("big.png")).unwrap();
        let ResearchMessageAttachment::Image {
            id,
            mime_type,
            byte_size,
            width,
            height,
            file_name,
        } = &attachment
        else {
            panic!("expected an image attachment");
        };
        assert_eq!(mime_type, "image/jpeg");
        assert!(id.ends_with(".jpg"));
        assert!(*byte_size <= MAX_IMAGE_BYTES);
        assert_eq!((*width, *height), (Some(1500), Some(1000)));
        assert_eq!(file_name.as_deref(), Some("big.png"));
        let stored = fs::read(pending_dir(&root).join(id)).unwrap();
        assert_eq!(ImageFormat::sniff(&stored), Some(ImageFormat::Jpeg));

        // A small image is kept as it is.
        let small = noise_png(40, 30);
        let kept = save_pending(&root, &small, None).unwrap();
        let ResearchMessageAttachment::Image { id, .. } = &kept else {
            panic!("expected an image attachment");
        };
        assert_eq!(fs::read(pending_dir(&root).join(id)).unwrap(), small);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transparency_is_flattened_over_white() {
        let pixels = image::RgbaImage::from_pixel(2, 2, image::Rgba([0, 0, 0, 0]));
        let jpeg = encode_jpeg(&image::DynamicImage::ImageRgba8(pixels), 95).unwrap();
        let decoded = decode(ImageFormat::Jpeg, &jpeg).unwrap().to_rgb8();
        assert!(
            decoded
                .pixels()
                .all(|pixel| pixel.0.iter().all(|&c| c > 245))
        );
    }

    #[test]
    fn messages_and_launches_cap_image_bytes() {
        let root = temp_root();
        let ids = (0..5)
            .map(|index| {
                let attachment = save_pending(&root, &png(2, 2 + index), None).unwrap();
                let ResearchMessageAttachment::Image { id, .. } = attachment else {
                    panic!("expected an image attachment");
                };
                // Pad the stored file to just under the per-image limit.
                let path = pending_dir(&root).join(&id);
                let mut bytes = fs::read(&path).unwrap();
                bytes.resize(MAX_IMAGE_BYTES as usize - 1, 0);
                fs::write(&path, bytes).unwrap();
                id
            })
            .collect::<Vec<_>>();
        let inputs = ids
            .iter()
            .map(|id| ImageInput {
                id: id.clone(),
                file_name: None,
            })
            .collect::<Vec<_>>();
        attachments_for_inputs(&root, &inputs[..4]).unwrap();
        assert!(
            attachments_for_inputs(&root, &inputs)
                .unwrap_err()
                .contains("20 MB")
        );
        let attachments = inputs[..4]
            .iter()
            .map(|input| attachment_for(&root, &input.id, None).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            launch_images(&root, "claude", &attachments).unwrap().len(),
            4
        );
        // An image stored before downscaling still loads, but is not sent.
        let path = pending_dir(&root).join(&ids[0]);
        let mut bytes = fs::read(&path).unwrap();
        bytes.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        fs::write(&path, bytes).unwrap();
        attachment_for(&root, &ids[0], None).unwrap();
        assert!(
            launch_images(&root, "claude", &attachments)
                .unwrap_err()
                .contains("over 5 MB")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inputs_are_capped_deduplicated_and_must_exist() {
        let root = temp_root();
        let attachment = save_pending(&root, &png(2, 2), None).unwrap();
        let ResearchMessageAttachment::Image { id, .. } = &attachment else {
            panic!("expected an image attachment");
        };
        let input = ImageInput {
            id: id.clone(),
            file_name: None,
        };
        let attachments = attachments_for_inputs(&root, &[input.clone(), input.clone()]).unwrap();
        assert_eq!(attachments.len(), 1);
        let too_many = vec![input; MAX_IMAGES_PER_MESSAGE + 1];
        assert!(attachments_for_inputs(&root, &too_many).is_err());
        let missing = ImageInput {
            id: "0123456789abcdef0123456789abcdef.png".to_string(),
            file_name: None,
        };
        assert!(
            attachments_for_inputs(&root, &[missing])
                .unwrap_err()
                .contains("no longer available")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn launch_images_require_every_file_and_a_reading_agent() {
        let root = temp_root();
        let attachment = save_pending(&root, &png(2, 2), None).unwrap();
        let images = launch_images(&root, "claude", std::slice::from_ref(&attachment)).unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].format, ImageFormat::Png);
        let block = images[0].claude_content_block().unwrap();
        assert_eq!(block["type"], "image");
        assert_eq!(block["source"]["media_type"], "image/png");
        assert_eq!(
            block["source"]["data"],
            STANDARD.encode(fs::read(&images[0].path).unwrap())
        );

        let one = std::slice::from_ref(&attachment);
        ensure_adapter_reads_images(&root, "claude", one).unwrap();
        ensure_adapter_reads_images(&root, "codex", one).unwrap();
        assert_eq!(
            ensure_adapter_reads_images(&root, "grok", one).unwrap_err(),
            "Grok can't read images."
        );
        assert!(launch_images(&root, "grok", one).is_err());
        ensure_adapter_reads_images(&root, "grok", &[]).unwrap();
        let comma_root = root.join("a,b");
        assert!(
            ensure_adapter_reads_images(&comma_root, "codex", one)
                .unwrap_err()
                .contains("comma")
        );
        ensure_adapter_reads_images(&comma_root, "claude", one).unwrap();

        fs::remove_file(&images[0].path).unwrap();
        assert!(launch_images(&root, "claude", &[attachment]).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
