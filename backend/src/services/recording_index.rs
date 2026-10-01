//! Seek index for session recordings (PERF-13).
//!
//! Seeking used to replay a recording from its first byte up to the
//! requested time. The index records, every [`CHECKPOINT_EVERY_BYTES`] of
//! recording, a checkpoint: the byte offset of an instruction boundary and
//! a prelude of instructions that rebuilds the client's display as it was
//! there (layer sizes and pixels, cursor, pointer, open audio streams). A
//! seek sends the nearest earlier prelude and replays only from its offset.
//!
//! Checkpoints come from replaying the recording through [`DisplayModel`],
//! a pixel model of the client covering what the session engine emits.
//! Anything it cannot reproduce exactly stops further checkpoints rather
//! than risk a wrong picture: an unrecognised drawing instruction ends
//! them for the recording, and H.264 (never decoded here) leaves the
//! display layer unknown, so those recordings get checkpoints only at
//! keyframes that repaint the whole display.
//!
//! The index lives beside the recordings in `.index/<recording id>/` and
//! records the source length; a source of a different length is replayed
//! in full and the index rebuilt.

use anyhow::Context as _;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use strata_session::protocol::guacamole::{encode_instruction, try_parse_instruction};
use uuid::Uuid;

pub const RECORDINGS_DIR: &str = "/var/lib/guacamole/recordings";
const INDEX_VERSION: u32 = 1;
/// Replay after a seek stays under this many recording bytes.
pub const CHECKPOINT_EVERY_BYTES: u64 = 8 * 1024 * 1024;
/// Guacamole composite modes the engine uses: replace the whole layer, and draw over it.
const MASK_COPY: i64 = 12;
const MASK_OVER: i64 = 14;
/// Raw bytes per prelude `blob`, under the protocol's element limit once base64-encoded.
const PRELUDE_BLOB_BYTES: usize = 48 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Checkpoint {
    /// Milliseconds after the recording's first `sync`.
    pub at_ms: u64,
    /// Byte offset to resume reading at; always an instruction boundary.
    pub offset: u64,
    /// Prelude file, inside the index directory.
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Index {
    pub version: u32,
    /// Length of the recording the index was built from.
    pub source_len: u64,
    /// Timestamp of the recording's first `sync`.
    pub first_ts: Option<u64>,
    pub checkpoints: Vec<Checkpoint>,
}

impl Index {
    /// The last checkpoint before `seek_ms`. Strictly before, so the replay
    /// after it stops on the same frame a replay from the start would.
    #[must_use]
    pub fn nearest(&self, seek_ms: u64) -> Option<&Checkpoint> {
        self.checkpoints.iter().rev().find(|c| c.at_ms < seek_ms)
    }
}

// ── Display model ───────────────────────────────────────────────────────

/// One layer's pixels, straight-alpha RGBA.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct Layer {
    w: u32,
    h: u32,
    px: Vec<u8>,
}

impl Layer {
    /// Resize keeping the overlapping content, as the client does.
    fn resize(&mut self, w: u32, h: u32) {
        if (w, h) == (self.w, self.h) {
            return;
        }
        let mut px = vec![0u8; w as usize * h as usize * 4];
        let (cw, ch) = (w.min(self.w) as usize, h.min(self.h) as usize);
        for y in 0..ch {
            let src = y * self.w as usize * 4;
            let dst = y * w as usize * 4;
            px[dst..dst + cw * 4].copy_from_slice(&self.px[src..src + cw * 4]);
        }
        *self = Self { w, h, px };
    }

    fn clear(&mut self) {
        self.px.fill(0);
    }

    /// Composite `src` (w×h straight RGBA) at (x, y), clipped to the layer.
    fn draw(&mut self, src: &[u8], sw: u32, sh: u32, x: i64, y: i64) {
        for row in 0..i64::from(sh) {
            let dy = y + row;
            if dy < 0 || dy >= i64::from(self.h) {
                continue;
            }
            for col in 0..i64::from(sw) {
                let dx = x + col;
                if dx < 0 || dx >= i64::from(self.w) {
                    continue;
                }
                let s = ((row * i64::from(sw) + col) * 4) as usize;
                let d = ((dy * i64::from(self.w) + dx) * 4) as usize;
                over(&mut self.px[d..d + 4], &src[s..s + 4]);
            }
        }
    }

    /// The w×h region at (x, y); outside the layer reads as transparent.
    fn region(&self, x: i64, y: i64, w: u32, h: u32) -> Vec<u8> {
        let mut out = vec![0u8; w as usize * h as usize * 4];
        for row in 0..i64::from(h) {
            let sy = y + row;
            if sy < 0 || sy >= i64::from(self.h) {
                continue;
            }
            for col in 0..i64::from(w) {
                let sx = x + col;
                if sx < 0 || sx >= i64::from(self.w) {
                    continue;
                }
                let s = ((sy * i64::from(self.w) + sx) * 4) as usize;
                let d = ((row * i64::from(w) + col) * 4) as usize;
                out[d..d + 4].copy_from_slice(&self.px[s..s + 4]);
            }
        }
        out
    }

    fn png(&self) -> anyhow::Result<Vec<u8>> {
        use image::ImageEncoder;
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut out,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Adaptive,
        )
        .write_image(&self.px, self.w, self.h, image::ExtendedColorType::Rgba8)?;
        Ok(out)
    }
}

/// Source-over for straight alpha, in place on `dst`.
fn over(dst: &mut [u8], src: &[u8]) {
    let sa = u32::from(src[3]);
    if sa == 255 {
        dst.copy_from_slice(src);
        return;
    }
    if sa == 0 {
        return;
    }
    let da = u32::from(dst[3]);
    let out_a = sa * 255 + da * (255 - sa); // scaled by 255
    for i in 0..3 {
        let c = u32::from(src[i]) * sa * 255 + u32::from(dst[i]) * da * (255 - sa);
        dst[i] = (c / out_a) as u8;
    }
    dst[3] = (out_a / 255) as u8;
}

struct ImageStream {
    mask: i64,
    layer: i64,
    x: i64,
    y: i64,
    data: Vec<u8>,
}

/// What a replay of the recording has drawn so far, as the client would.
#[derive(Default)]
pub struct DisplayModel {
    layers: BTreeMap<i64, Layer>,
    /// Layers whose pixels the model cannot reproduce (H.264, or copied from such).
    unknown_layers: HashSet<i64>,
    /// An instruction the model does not understand was replayed.
    broken: bool,
    paths: HashMap<i64, Vec<(i64, i64, i64, i64)>>,
    images: HashMap<i64, ImageStream>,
    videos: HashSet<i64>,
    /// Clipboard, file and pipe streams: a checkpoint cannot resume them mid-way.
    transfers: HashSet<i64>,
    /// Open audio streams, re-declared by a prelude.
    audio: BTreeMap<i64, String>,
    cursor: Option<Vec<String>>,
    mouse: Option<Vec<String>>,
}

fn int(args: &[&str], i: usize) -> Option<i64> {
    args.get(i)?.parse().ok()
}

impl DisplayModel {
    fn layer(&mut self, id: i64) -> &mut Layer {
        self.layers.entry(id).or_default()
    }

    /// Apply one instruction. Unknown drawing instructions mark the model broken.
    pub fn apply(&mut self, opcode: &str, args: &[&str]) {
        if self.apply_known(opcode, args).is_none() {
            self.broken = true;
        }
    }

    fn apply_known(&mut self, opcode: &str, args: &[&str]) -> Option<()> {
        match opcode {
            "size" => {
                let (id, w, h) = (int(args, 0)?, int(args, 1)?, int(args, 2)?);
                self.layer(id)
                    .resize(u32::try_from(w).ok()?, u32::try_from(h).ok()?);
            }
            "img" => {
                let stream = int(args, 0)?;
                let s = ImageStream {
                    mask: int(args, 1)?,
                    layer: int(args, 2)?,
                    x: int(args, 4)?,
                    y: int(args, 5)?,
                    data: Vec::new(),
                };
                self.images.insert(stream, s);
            }
            "h264" => {
                let (stream, id) = (int(args, 0)?, int(args, 1)?);
                self.videos.insert(stream);
                self.unknown_layers.insert(id);
            }
            "blob" => {
                let stream = int(args, 0)?;
                if let Some(img) = self.images.get_mut(&stream) {
                    img.data.extend(BASE64.decode(args.get(1)?).ok()?);
                }
            }
            "end" => {
                let stream = int(args, 0)?;
                if let Some(img) = self.images.remove(&stream) {
                    self.draw_image(img)?;
                }
                self.videos.remove(&stream);
                self.transfers.remove(&stream);
                self.audio.remove(&stream);
            }
            "copy" => {
                let (src, sx, sy, w, h) = (
                    int(args, 0)?,
                    int(args, 1)?,
                    int(args, 2)?,
                    u32::try_from(int(args, 3)?).ok()?,
                    u32::try_from(int(args, 4)?).ok()?,
                );
                let (mask, dst, dx, dy) =
                    (int(args, 5)?, int(args, 6)?, int(args, 7)?, int(args, 8)?);
                let pixels = self.layer(src).region(sx, sy, w, h);
                if self.unknown_layers.contains(&src) {
                    self.unknown_layers.insert(dst);
                }
                self.composite(dst, mask, &pixels, w, h, dx, dy)?;
            }
            "rect" => {
                let id = int(args, 0)?;
                let r = (int(args, 1)?, int(args, 2)?, int(args, 3)?, int(args, 4)?);
                self.paths.entry(id).or_default().push(r);
            }
            "cfill" => {
                let (mask, id) = (int(args, 0)?, int(args, 1)?);
                let rgba = [
                    u8::try_from(int(args, 2)?).ok()?,
                    u8::try_from(int(args, 3)?).ok()?,
                    u8::try_from(int(args, 4)?).ok()?,
                    u8::try_from(int(args, 5)?).ok()?,
                ];
                let rects = self.paths.remove(&id).unwrap_or_default();
                if mask == MASK_COPY {
                    self.layer(id).clear();
                } else if mask != MASK_OVER {
                    return None;
                }
                for (x, y, w, h) in rects {
                    let (w, h) = (u32::try_from(w).ok()?, u32::try_from(h).ok()?);
                    let fill = rgba.repeat(w as usize * h as usize);
                    self.layer(id).draw(&fill, w, h, x, y);
                }
            }
            "cursor" => self.cursor = Some(args.iter().map(|a| (*a).to_owned()).collect()),
            "mouse" => self.mouse = Some(args.iter().map(|a| (*a).to_owned()).collect()),
            "audio" => {
                self.audio.insert(int(args, 0)?, (*args.get(1)?).to_owned());
            }
            "clipboard" | "file" | "pipe" => {
                self.transfers.insert(int(args, 0)?);
            }
            "body" => {
                self.transfers.insert(int(args, 1)?);
            }
            // No effect on the picture.
            "sync" | "key" | "nop" | "name" | "ack" | "msg" | "error" | "disconnect"
            | "filesystem" | "undefine" | "args" | "ready" | "log" | "required" => {}
            _ => return None,
        }
        Some(())
    }

    fn draw_image(&mut self, img: ImageStream) -> Option<()> {
        let decoded = image::load_from_memory(&img.data).ok()?.to_rgba8();
        let (w, h) = decoded.dimensions();
        if img.mask == MASK_COPY && img.x <= 0 && img.y <= 0 {
            let layer = self.layer(img.layer);
            if i64::from(w) + img.x >= i64::from(layer.w)
                && i64::from(h) + img.y >= i64::from(layer.h)
            {
                // Replaces every pixel, so whatever the layer held no longer matters.
                self.unknown_layers.remove(&img.layer);
            }
        }
        self.composite(img.layer, img.mask, decoded.as_raw(), w, h, img.x, img.y)
    }

    #[allow(clippy::too_many_arguments)]
    fn composite(
        &mut self,
        id: i64,
        mask: i64,
        px: &[u8],
        w: u32,
        h: u32,
        x: i64,
        y: i64,
    ) -> Option<()> {
        let layer = self.layer(id);
        match mask {
            // The browser's "copy" composite leaves nothing outside the source.
            MASK_COPY => {
                layer.clear();
                layer.draw(px, w, h, x, y);
            }
            MASK_OVER => layer.draw(px, w, h, x, y),
            _ => return None,
        }
        Some(())
    }

    /// No stream is mid-way, so a prelude plus the rest of the recording is complete.
    fn at_rest(&self) -> bool {
        self.images.is_empty() && self.videos.is_empty() && self.transfers.is_empty()
    }

    /// Instructions that rebuild this state on a fresh client. `skip_pixels`
    /// leaves out layers that the next instruction repaints whole.
    fn prelude(&self, skip_pixels: Option<i64>) -> anyhow::Result<String> {
        let mut out = bytes::BytesMut::new();
        let mut stream = 1i64;
        for (id, layer) in &self.layers {
            let (ids, ws, hs) = (id.to_string(), layer.w.to_string(), layer.h.to_string());
            encode_instruction(&mut out, "size", &[ids.as_str(), ws.as_str(), hs.as_str()]);
            if layer.w == 0 || layer.h == 0 || skip_pixels == Some(*id) {
                continue;
            }
            while self.audio.contains_key(&stream) {
                stream += 1;
            }
            let s = stream.to_string();
            let mask = MASK_COPY.to_string();
            encode_instruction(
                &mut out,
                "img",
                &[
                    s.as_str(),
                    mask.as_str(),
                    ids.as_str(),
                    "image/png",
                    "0",
                    "0",
                ],
            );
            for chunk in layer.png()?.chunks(PRELUDE_BLOB_BYTES) {
                encode_instruction(&mut out, "blob", &[s.as_str(), &BASE64.encode(chunk)]);
            }
            encode_instruction(&mut out, "end", &[s.as_str()]);
        }
        for (s, mimetype) in &self.audio {
            encode_instruction(
                &mut out,
                "audio",
                &[s.to_string().as_str(), mimetype.as_str()],
            );
        }
        for (opcode, args) in [("cursor", &self.cursor), ("mouse", &self.mouse)] {
            if let Some(args) = args {
                let refs: Vec<&str> = args.iter().map(String::as_str).collect();
                encode_instruction(&mut out, opcode, &refs);
            }
        }
        Ok(String::from_utf8(out.to_vec())?)
    }
}

// ── Building ────────────────────────────────────────────────────────────

/// Replay `source` and write the index into `dir`, one prelude file per checkpoint.
pub fn build(source: impl Read, dir: &Path, every_bytes: u64) -> anyhow::Result<Index> {
    let mut source = std::io::BufReader::with_capacity(256 * 1024, source);
    let mut model = DisplayModel::default();
    let mut buf = bytes::BytesMut::new();
    let mut chunk = vec![0u8; 256 * 1024];
    let (mut base, mut first_ts, mut at_ms) = (0u64, None::<u64>, 0u64);
    let (mut last_offset, mut last_at) = (0u64, None::<u64>);
    let mut checkpoints = Vec::new();
    std::fs::create_dir_all(dir)?;

    let save = |checkpoints: &mut Vec<Checkpoint>, at_ms, offset, prelude: String| {
        let file = format!("cp-{}.guac", checkpoints.len());
        std::fs::write(dir.join(&file), prelude)?;
        checkpoints.push(Checkpoint {
            at_ms,
            offset,
            file,
        });
        anyhow::Ok(())
    };

    loop {
        let n = source.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        loop {
            use bytes::Buf;
            let Ok(Some((inst, consumed))) = try_parse_instruction(&buf) else {
                break;
            };
            let (start, end) = (base, base + consumed as u64);

            // A keyframe that repaints the whole display is a checkpoint even though
            // the model cannot see its pixels; the replay starts with it.
            if inst.opcode == "h264"
                && inst.arg(2) == Some("1")
                && first_ts.is_some()
                && !model.broken
                && model.at_rest()
                && start - last_offset >= every_bytes
                && last_at.is_none_or(|l| at_ms > l)
            {
                let layer: Option<i64> = inst.arg(1).and_then(|a| a.parse().ok());
                let rect: Vec<i64> = (3..7).filter_map(|i| inst.arg(i)?.parse().ok()).collect();
                if let (Some(id), [0, 0, w, h]) = (layer, rect.as_slice()) {
                    let covers = model
                        .layers
                        .get(&id)
                        .is_some_and(|l| i64::from(l.w) <= *w && i64::from(l.h) <= *h);
                    let others_known = model.unknown_layers.iter().all(|u| *u == id);
                    if covers && others_known {
                        save(&mut checkpoints, at_ms, start, model.prelude(Some(id))?)?;
                        (last_offset, last_at) = (start, Some(at_ms));
                    }
                }
            }

            model.apply(inst.opcode, &inst.args);

            if inst.opcode == "sync" {
                if let Some(ts) = inst.arg(0).and_then(|a| a.parse::<u64>().ok()) {
                    let first = *first_ts.get_or_insert(ts);
                    at_ms = ts.saturating_sub(first);
                    if !model.broken
                        && model.unknown_layers.is_empty()
                        && model.at_rest()
                        && end - last_offset >= every_bytes
                        && last_at.is_none_or(|l| at_ms > l)
                    {
                        save(&mut checkpoints, at_ms, end, model.prelude(None)?)?;
                        (last_offset, last_at) = (end, Some(at_ms));
                    }
                }
            }
            buf.advance(consumed);
            base = end;
        }
    }

    Ok(Index {
        version: INDEX_VERSION,
        source_len: base + buf.len() as u64,
        first_ts,
        checkpoints,
    })
}

// ── Storage ─────────────────────────────────────────────────────────────

fn index_dir(id: Uuid) -> PathBuf {
    Path::new(RECORDINGS_DIR)
        .join(".index")
        .join(id.to_string())
}

/// The recording's index, if one was built in the current format.
pub async fn load(id: Uuid) -> Option<Index> {
    let text = tokio::fs::read(index_dir(id).join("index.json"))
        .await
        .ok()?;
    serde_json::from_slice::<Index>(&text)
        .ok()
        .filter(|i| i.version == INDEX_VERSION)
}

pub async fn read_prelude(id: Uuid, checkpoint: &Checkpoint) -> std::io::Result<String> {
    tokio::fs::read_to_string(index_dir(id).join(&checkpoint.file)).await
}

static BUILDING: std::sync::LazyLock<std::sync::Mutex<HashSet<Uuid>>> =
    std::sync::LazyLock::new(Default::default);
/// Index builds decode every image in a recording; one at a time.
static BUILD_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// Start building an index for a finished recording in the background,
/// unless a current one exists or a build is already running.
pub fn ensure(recording: &crate::db::Recording, state: crate::services::app_state::SharedState) {
    if recording.status == "recording" {
        return;
    }
    let id = recording.id;
    if !BUILDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id)
    {
        return;
    }
    let recording = recording.clone();
    tokio::spawn(async move {
        if let Err(e) = rebuild_if_stale(&recording, &state).await {
            tracing::warn!(recording = %id, "recording index not built: {e}");
        }
        BUILDING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    });
}

async fn rebuild_if_stale(
    recording: &crate::db::Recording,
    state: &crate::services::app_state::SharedState,
) -> anyhow::Result<()> {
    let existing = load(recording.id).await;
    let local = Path::new(RECORDINGS_DIR).join(&recording.storage_path);
    if recording.storage_type == "local" {
        let len = tokio::fs::metadata(&local).await?.len();
        if existing.is_some_and(|i| i.source_len == len) {
            return Ok(());
        }
    } else if existing.is_some() {
        // Checked against the blob's length on each seek instead.
        return Ok(());
    }
    let _slot = BUILD_SLOT.acquire().await?;

    // Remote recordings are fetched whole once, to a scratch file.
    let scratch = tempfile::NamedTempFile::new()?;
    let source = if recording.storage_type == "local" {
        local
    } else {
        let azure = {
            let s = state.read().await;
            let pool =
                s.db.as_ref()
                    .map(|d| d.pool.clone())
                    .context("DB not connected")?;
            let vault = s.config.as_ref().and_then(|c| c.vault.as_ref()).cloned();
            crate::services::recordings::get_azure_config(&pool, vault.as_ref())
                .await?
                .context("Azure storage not configured")?
        };
        let (stream, _) = crate::services::recordings::download_stream_from_azure(
            &azure,
            &recording.storage_path,
            0,
        )
        .await?;
        let mut stream = std::pin::pin!(stream);
        let mut file = std::fs::File::create(scratch.path())?;
        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            file.write_all(&chunk?)?;
        }
        scratch.path().to_path_buf()
    };

    let final_dir = index_dir(recording.id);
    let tmp_dir = final_dir.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
    let started = std::time::Instant::now();
    let built = {
        let tmp_dir = tmp_dir.clone();
        tokio::task::spawn_blocking(move || -> anyhow::Result<Index> {
            let index = build(
                std::fs::File::open(&source)?,
                &tmp_dir,
                CHECKPOINT_EVERY_BYTES,
            )?;
            std::fs::write(tmp_dir.join("index.json"), serde_json::to_vec(&index)?)?;
            Ok(index)
        })
        .await?
    };
    let index = match built {
        Ok(index) => index,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            return Err(e);
        }
    };
    let _ = tokio::fs::remove_dir_all(&final_dir).await;
    tokio::fs::rename(&tmp_dir, &final_dir).await?;
    tracing::info!(
        recording = %recording.id,
        bytes = index.source_len,
        checkpoints = index.checkpoints.len(),
        elapsed_ms = started.elapsed().as_millis() as u64,
        "recording index built"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32, rgba: [u8; 4]) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba(rgba));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn ins(out: &mut bytes::BytesMut, opcode: &str, args: &[&str]) {
        encode_instruction(out, opcode, args);
    }

    /// An image update the way the engine sends one: img, base64 blobs, end.
    #[allow(clippy::too_many_arguments)]
    fn image(
        out: &mut bytes::BytesMut,
        stream: i64,
        mask: i64,
        layer: i64,
        x: i64,
        y: i64,
        data: &[u8],
    ) {
        let [s, m, l, xs, ys] = [stream, mask, layer, x, y].map(|v| v.to_string());
        ins(out, "img", &[&s, &m, &l, "image/png", &xs, &ys]);
        for chunk in data.chunks(100) {
            ins(out, "blob", &[&s, &BASE64.encode(chunk)]);
        }
        ins(out, "end", &[&s]);
    }

    /// A recording that resizes, paints, scrolls, fills, changes cursor and
    /// moves the pointer, with a sync every frame.
    fn recording(frames: u64) -> Vec<u8> {
        let mut out = bytes::BytesMut::new();
        ins(&mut out, "size", &["0", "64", "48"]);
        let mut stream = 1;
        for f in 0..frames {
            if f == frames / 2 {
                ins(&mut out, "size", &["0", "80", "40"]);
            }
            let shade = (f * 37 % 256) as u8;
            image(
                &mut out,
                stream,
                MASK_OVER,
                0,
                (f % 50) as i64,
                (f % 30) as i64,
                &png(12, 9, [shade, 255 - shade, 7, 255]),
            );
            stream += 1;
            if f % 3 == 0 {
                ins(
                    &mut out,
                    "copy",
                    &["0", "0", "0", "30", "20", "14", "0", "5", "3"],
                );
            }
            if f % 4 == 0 {
                ins(
                    &mut out,
                    "rect",
                    &["0", &(f % 40).to_string(), "2", "6", "5"],
                );
                ins(
                    &mut out,
                    "cfill",
                    &["14", "0", "200", "10", &shade.to_string(), "128"],
                );
            }
            if f % 5 == 0 {
                ins(&mut out, "size", &["-1", "4", "4"]);
                image(
                    &mut out,
                    stream,
                    MASK_COPY,
                    -1,
                    0,
                    0,
                    &png(4, 4, [shade, 0, 0, 200]),
                );
                stream += 1;
                ins(&mut out, "cursor", &["1", "1", "-1", "0", "0", "4", "4"]);
            }
            ins(&mut out, "mouse", &[&(f % 64).to_string(), "7"]);
            ins(&mut out, "key", &["65", "1"]);
            ins(&mut out, "sync", &[&(1_000 + f * 40).to_string()]);
        }
        out.to_vec()
    }

    fn replay(model: &mut DisplayModel, data: &[u8]) {
        let mut rest = data;
        while let Ok(Some((inst, n))) = try_parse_instruction(rest) {
            model.apply(inst.opcode, &inst.args);
            rest = &rest[n..];
        }
    }

    /// Model state after replaying `data` up to and including the first sync at or after `at_ms`.
    fn state_at(data: &[u8], prelude: &str, first_ts: u64, at_ms: u64) -> DisplayModel {
        let mut model = DisplayModel::default();
        replay(&mut model, prelude.as_bytes());
        let mut rest = data;
        while let Ok(Some((inst, n))) = try_parse_instruction(rest) {
            model.apply(inst.opcode, &inst.args);
            rest = &rest[n..];
            if inst.opcode == "sync"
                && inst.arg(0).unwrap().parse::<u64>().unwrap() - first_ts >= at_ms
            {
                break;
            }
        }
        model
    }

    fn same_picture(a: &DisplayModel, b: &DisplayModel) {
        assert_eq!(a.layers, b.layers, "layer sizes and pixels");
        assert_eq!(a.cursor, b.cursor);
        assert_eq!(a.mouse, b.mouse);
    }

    #[test]
    fn seeking_from_a_checkpoint_draws_what_a_full_replay_draws() {
        let data = recording(400);
        let dir = tempfile::tempdir().unwrap();
        let index = build(&data[..], dir.path(), 4 * 1024).unwrap();
        assert_eq!(index.source_len, data.len() as u64);
        assert!(index.checkpoints.len() >= 5, "{}", index.checkpoints.len());
        let first_ts = index.first_ts.unwrap();
        let end_ms = 399 * 40;

        for seek in [0, 37, end_ms / 3, end_ms / 2, end_ms - 1, end_ms] {
            let full = state_at(&data, "", first_ts, seek);
            let (prelude, from) = match index.nearest(seek) {
                Some(cp) => (
                    std::fs::read_to_string(dir.path().join(&cp.file)).unwrap(),
                    cp.offset as usize,
                ),
                None => (String::new(), 0),
            };
            let resumed = state_at(&data[from..], &prelude, first_ts, seek);
            same_picture(&full, &resumed);
        }

        // Seeking to the end reads only what follows the last checkpoint.
        let last = index.nearest(end_ms).unwrap();
        assert!(data.len() as u64 - last.offset <= 2 * 4 * 1024 + 4096);
    }

    #[test]
    fn checkpoints_land_after_a_sync_and_never_inside_a_stream() {
        let data = recording(200);
        let dir = tempfile::tempdir().unwrap();
        let index = build(&data[..], dir.path(), 2 * 1024).unwrap();
        for cp in &index.checkpoints {
            let before = &data[..cp.offset as usize];
            assert!(before.ends_with(b";"), "boundary");
            let tail = std::str::from_utf8(before).unwrap();
            let last = tail[..tail.len() - 1].rfind(';').map_or(0, |i| i + 1);
            assert!(tail[last..].starts_with("4.sync,"), "after a sync");
        }
        let at: Vec<u64> = index.checkpoints.iter().map(|c| c.at_ms).collect();
        assert!(at.windows(2).all(|w| w[0] < w[1]), "{at:?}");
    }

    #[test]
    fn copy_composite_replaces_the_whole_layer() {
        let mut model = DisplayModel::default();
        let mut out = bytes::BytesMut::new();
        ins(&mut out, "size", &["0", "4", "4"]);
        image(&mut out, 1, MASK_OVER, 0, 0, 0, &png(4, 4, [9, 9, 9, 255]));
        image(&mut out, 2, MASK_COPY, 0, 1, 1, &png(1, 1, [1, 2, 3, 255]));
        replay(&mut model, &out);
        let layer = &model.layers[&0];
        assert_eq!(
            &layer.px[0..4],
            &[0, 0, 0, 0],
            "outside the source is cleared"
        );
        assert_eq!(&layer.px[(4 + 1) * 4..(4 + 1) * 4 + 4], &[1, 2, 3, 255]);
    }

    #[test]
    fn h264_recordings_checkpoint_only_at_full_screen_keyframes() {
        let mut out = bytes::BytesMut::new();
        ins(&mut out, "size", &["0", "32", "16"]);
        for f in 0..60u64 {
            let s = (f + 1).to_string();
            let key = if f % 20 == 0 { "1" } else { "0" };
            let (w, h) = if f == 40 { ("16", "16") } else { ("32", "16") };
            ins(&mut out, "h264", &[&s, "0", key, "0", "0", w, h]);
            ins(&mut out, "blob", &[&s, &BASE64.encode(vec![f as u8; 600])]);
            ins(&mut out, "end", &[&s]);
            ins(&mut out, "sync", &[&(5_000 + f * 40).to_string()]);
        }
        let data = out.to_vec();
        let dir = tempfile::tempdir().unwrap();
        let index = build(&data[..], dir.path(), 1).unwrap();
        // Frame 0 precedes any sync; frame 40 covers only half the display.
        assert_eq!(
            index
                .checkpoints
                .iter()
                .map(|c| c.at_ms)
                .collect::<Vec<_>>(),
            vec![19 * 40]
        );
        let cp = &index.checkpoints[0];
        assert!(
            data[cp.offset as usize..].starts_with(b"4.h264,"),
            "replay starts at the keyframe"
        );
        let prelude = std::fs::read_to_string(dir.path().join(&cp.file)).unwrap();
        assert!(prelude.contains("4.size,1.0,2.32,2.16;") && !prelude.contains("img"));
    }

    #[test]
    fn an_unknown_drawing_instruction_stops_further_checkpoints() {
        let mut data = recording(40);
        let mut out = bytes::BytesMut::new();
        ins(&mut out, "shade", &["0", "128"]);
        data.extend_from_slice(&out);
        data.extend(recording(200));
        let dir = tempfile::tempdir().unwrap();
        let index = build(&data[..], dir.path(), 1024).unwrap();
        let shade_at = data.windows(8).position(|w| w == b"5.shade,").unwrap() as u64;
        assert!(!index.checkpoints.is_empty());
        assert!(index.checkpoints.iter().all(|c| c.offset <= shade_at));
    }
}
