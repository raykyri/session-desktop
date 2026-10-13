//! Images attached to research messages.
//!
//! A pasted or dropped image is written to `.session/research-images/pending/`
//! under a random name, its id (`<32 hex digits>.<extension>`). Messages and
//! drafts store the id, never a path, so the store can be found again from
//! the workspace root alone. Creating a message or saving a draft that
//! references an image moves it into `.session/research-images/`. When the
//! last message or draft that references it is permanently deleted, the image
//! is removed, unless it was attached within [`PENDING_LIFETIME`]: then it
//! moves back to `pending/`, so a composer that still holds it (after a send
//! whose launch failed and was rolled back) can send it again.
//!
//! The frontend keeps unsent images in composers and in a thread's queue of
//! follow-ups (stored in the webview across restarts), which the backend
//! cannot see. Pending images are therefore removed once they are older than
//! [`PENDING_LIFETIME`], at startup and whenever an image is saved. A stored
//! image is removed only by being released; images of research moved out
//! with a removed workspace folder stay stored, so the research shows them
//! again when the folder is added back on this machine.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::{Engine as _, engine::general_purpose::STANDARD};

use crate::tweets::ResearchMessageAttachment;

/// Largest image a message can carry.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// Most images one message can carry.
pub const MAX_IMAGES_PER_MESSAGE: usize = 8;
/// Longest kept original file name, in characters.
const MAX_FILE_NAME_CHARS: usize = 255;
/// How long an image nothing references is kept for a composer or queue that
/// may still send it.
const PENDING_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

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
        MAX_IMAGE_BYTES / (1024 * 1024)
    )
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
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(too_large());
    }
    let format = ImageFormat::sniff(bytes).ok_or_else(unsupported)?;
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
    sweep_stale_pending(workspace_root, &id);
    Ok(attachment_from_bytes(id, format, bytes, file_name))
}

/// Copies an image file the user dropped on a composer into the pending
/// store. The window receives native file drops as paths, not bytes.
pub fn import_pending(
    workspace_root: &Path,
    path: &Path,
) -> Result<ResearchMessageAttachment, String> {
    let metadata =
        fs::metadata(path).map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    if !metadata.is_file() {
        return Err(unsupported());
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(too_large());
    }
    let file =
        fs::File::open(path).map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1)
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
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("failed to read the image: {err}"))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
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
            ResearchMessageAttachment::Tweet { .. } => None,
        })
}

fn move_file(from: &Path, to_dir: &Path, id: &str) {
    if !from.is_file() {
        return;
    }
    let target = to_dir.join(id);
    let result = fs::create_dir_all(to_dir).and_then(|()| {
        if target.is_file() {
            fs::remove_file(from)
        } else {
            fs::rename(from, &target)
        }
    });
    if let Err(err) = result {
        eprintln!("session: failed to move research image {id}: {err}");
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

/// Removes stored images nothing references any more. One attached within
/// [`PENDING_LIFETIME`] moves back to pending instead, for a composer that
/// may send it again.
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

/// Removes pending images older than [`PENDING_LIFETIME`], other than the
/// one just written. A composer or queue that kept an image that long gets
/// "no longer available" when it sends.
fn sweep_stale_pending(workspace_root: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(pending_dir(workspace_root)) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let is_kept = path.file_name().and_then(|name| name.to_str()) == Some(keep);
        if !is_kept && file_older_than(&path, PENDING_LIFETIME) {
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
    inputs
        .iter()
        .filter(|input| seen.insert(input.id.as_str()))
        .map(|input| attachment_for(workspace_root, &input.id, input.file_name.as_deref()))
        .collect()
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
        || byte_size > MAX_IMAGE_BYTES
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
/// instead of sending the text without them.
pub fn ensure_adapter_reads_images(
    adapter: &str,
    attachments: &[ResearchMessageAttachment],
) -> Result<(), String> {
    if image_ids(attachments).next().is_some() && !adapter_reads_images(adapter) {
        return Err(format!("{} can't read images.", adapter_label(adapter)));
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

/// The images of the message a run sends, in message order. Every image
/// must still exist: a run never goes out with some of its images missing.
pub fn launch_images(
    workspace_root: &Path,
    attachments: &[ResearchMessageAttachment],
) -> Result<Vec<LaunchImage>, String> {
    attachments
        .iter()
        .filter_map(|attachment| match attachment {
            ResearchMessageAttachment::Image { id, mime_type, .. } => Some((id, mime_type)),
            ResearchMessageAttachment::Tweet { .. } => None,
        })
        .map(|(id, mime_type)| {
            let path = image_path(workspace_root, id).ok_or_else(|| {
                "An attached image is no longer available, so the question cannot be sent."
                    .to_string()
            })?;
            let format = ImageFormat::from_mime_type(mime_type).ok_or_else(unsupported)?;
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

        // Saving an image removes stale pending ones.
        age_file_for_test(&pending_dir(&root).join(fresh_id));
        save_pending(&root, &png(1, 3), None).unwrap();
        assert!(image_path(&root, fresh_id).is_none());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dropped_files_are_copied_with_their_name() {
        let root = temp_root();
        let source = root.join("Dropped shot.png");
        fs::write(&source, png(5, 6)).unwrap();
        let attachment = import_pending(&root, &source).unwrap();
        assert!(matches!(
            &attachment,
            ResearchMessageAttachment::Image { file_name: Some(name), width: Some(5), .. }
                if name == "Dropped shot.png"
        ));
        assert!(source.is_file());
        let text = root.join("notes.txt");
        fs::write(&text, "not an image").unwrap();
        assert!(import_pending(&root, &text).unwrap_err().contains("PNG"));
        assert!(import_pending(&root, &root).is_err());
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
        huge.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        assert!(
            save_pending(&root, &huge, None)
                .unwrap_err()
                .contains("10 MB")
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
        let images = launch_images(&root, std::slice::from_ref(&attachment)).unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].format, ImageFormat::Png);
        let block = images[0].claude_content_block().unwrap();
        assert_eq!(block["type"], "image");
        assert_eq!(block["source"]["media_type"], "image/png");
        assert_eq!(
            block["source"]["data"],
            STANDARD.encode(fs::read(&images[0].path).unwrap())
        );

        ensure_adapter_reads_images("claude", std::slice::from_ref(&attachment)).unwrap();
        ensure_adapter_reads_images("codex", std::slice::from_ref(&attachment)).unwrap();
        assert_eq!(
            ensure_adapter_reads_images("grok", std::slice::from_ref(&attachment)).unwrap_err(),
            "Grok can't read images."
        );
        ensure_adapter_reads_images("grok", &[]).unwrap();

        fs::remove_file(&images[0].path).unwrap();
        assert!(launch_images(&root, &[attachment]).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
