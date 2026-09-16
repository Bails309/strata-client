//! MS-RDPEGFX passthrough: H.264 straight from the target to the browser.
//!
//! The graphics pipeline is the only channel a Windows host will send
//! H.264 on. Everything here exists to get those frames to the browser's
//! `VideoDecoder` *without decoding them*, which is the whole point —
//! decoding here and re-encoding as PNG is what `guacd` did, and what
//! this engine was written to stop doing.
//!
//! ## Why AVC420 only
//!
//! `RFX_AVC444_BITMAP_STREAM` is two AVC420 streams, a main view plus a
//! chroma auxiliary view. WebCodecs decodes one `avc1` stream, so 444
//! cannot be passed through intact: it would need decoding and
//! recombining here, which defeats the purpose. The advertised
//! capability set therefore stops at V8.1/AVC420 — a V10.7 client would
//! invite 444 frames this cannot use.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use ironrdp_core::{Decode as _, ReadCursor};
use ironrdp_egfx::client::{BitmapUpdate, GraphicsPipelineHandler};
use ironrdp_egfx::pdu::{
    Avc420BitmapStream, Avc444BitmapStream, CacheToSurfacePdu, CapabilitiesV107Flags,
    CapabilitiesV81Flags, CapabilitiesV8Flags, CapabilitySet, Codec1Type, Encoding, SolidFillPdu,
    SurfaceToCachePdu, SurfaceToSurfacePdu,
};
use ironrdp_pdu::geometry::{ExclusiveRectangle, Rectangle as _};

use crate::engine::{TargetEvent, VideoCodec};

/// Annex B start code. MS-RDPEGFX carries NAL units length-prefixed, but
/// `VideoDecoder` is configured without a `description`, which per
/// WebCodecs means it wants a start-code stream.
const START_CODE: [u8; 4] = [0x00, 0x00, 0x00, 0x01];

/// NAL unit types that let a decoder start from cold.
const NAL_IDR: u8 = 5;
const NAL_SPS: u8 = 7;

/// Collects H.264 frames off the graphics pipeline for the session loop.
///
/// The handler is called from inside `ActiveStage::process`, so it cannot
/// touch the session directly; it parks events on a shared queue that the
/// session drains on the same turn.
pub(crate) struct GfxPassthrough {
    frames: Arc<Mutex<VecDeque<TargetEvent>>>,
    /// AVC444 frames the server sent anyway, which are dropped.
    unsupported: Arc<Mutex<u64>>,
    /// Whether the first AVC frame has been logged.
    seen_first: bool,
    /// Whether the first decoded bitmap has been logged.
    seen_bitmap: bool,
    /// Whether the progressive-codec warning has been issued.
    warned_progressive: bool,
    /// Whether the cross-surface copy warning has been issued.
    warned_cross_surface: bool,
    /// Whether the cache warning has been issued.
    warned_cache: bool,
}

impl GfxPassthrough {
    pub(crate) fn new(
        frames: Arc<Mutex<VecDeque<TargetEvent>>>,
        unsupported: Arc<Mutex<u64>>,
    ) -> Self {
        Self {
            frames,
            unsupported,
            seen_first: false,
            seen_bitmap: false,
            warned_progressive: false,
            warned_cross_surface: false,
            warned_cache: false,
        }
    }

    fn push(&self, event: TargetEvent) {
        if let Ok(mut frames) = self.frames.lock() {
            frames.push_back(event);
        }
    }

    fn warn_cache(&mut self) {
        if !self.warned_cache {
            self.warned_cache = true;
            tracing::warn!(
                "server is using the graphics cache, which passthrough cannot serve \
                 because frames are never decoded here; some regions will go stale"
            );
        }
    }
}

impl GraphicsPipelineHandler for GfxPassthrough {
    fn capabilities(&self) -> Vec<CapabilitySet> {
        vec![
            // A host with `AVC444ModePreferred` set will clear the AVC flag
            // on an AVC420-only client rather than fall back, which
            // negotiates GFX with no codec we can use — a black screen.
            // Offering 4:4:4 costs nothing: only its main view is
            // forwarded, which is the same 4:2:0 stream 420 would send.
            CapabilitySet::V10_7 {
                flags: CapabilitiesV107Flags::SMALL_CACHE,
            },
            CapabilitySet::V8_1 {
                flags: CapabilitiesV81Flags::AVC420_ENABLED | CapabilitiesV81Flags::SMALL_CACHE,
            },
            CapabilitySet::V8 {
                flags: CapabilitiesV8Flags::SMALL_CACHE,
            },
        ]
    }

    fn accepts_avc_passthrough(&self) -> bool {
        true
    }

    /// The desktop changed size.
    ///
    /// Under GFX the server resizes the output here rather than through a
    /// deactivation-reactivation, so ignoring this leaves the client layer
    /// at its old size and the new area renders as a black band.
    fn on_reset_graphics(&mut self, width: u32, height: u32) {
        tracing::info!(width, height, "rdp graphics pipeline output resized");
        if let Ok(mut frames) = self.frames.lock() {
            frames.push_back(TargetEvent::Resized { width, height });
        }
    }

    fn on_capabilities_confirmed(&mut self, caps: &CapabilitySet) {
        // Confirming GFX stops the legacy bitmap path, so a set without AVC
        // leaves nothing able to paint the desktop.
        let avc = match caps {
            CapabilitySet::V8 { .. } => false,
            CapabilitySet::V8_1 { flags } => flags.contains(CapabilitiesV81Flags::AVC420_ENABLED),
            CapabilitySet::V10_7 { flags } => !flags.contains(CapabilitiesV107Flags::AVC_DISABLED),
            _ => true,
        };

        if avc {
            tracing::info!(?caps, "rdp graphics pipeline negotiated");
        } else {
            tracing::error!(
                ?caps,
                "rdp graphics pipeline negotiated WITHOUT h264; the server will send \
                 surface commands this engine cannot decode and the session will be \
                 blank. Turn off `Enable graphics pipeline (GFX)` for this connection, \
                 or enable AVC on the host (see docs/h264-passthrough.md)"
            );
        }
    }

    fn on_close(&mut self) {
        let dropped = self.unsupported.lock().map(|c| *c).unwrap_or(0);
        tracing::info!(
            chroma_views_discarded = dropped,
            "rdp graphics pipeline closed"
        );
    }

    /// Draw whatever the pipeline decoded for us.
    ///
    /// Negotiating GFX stops the server sending legacy bitmap updates, so
    /// anything arriving here that is not forwarded ends up as a black
    /// region on the client. Uncompressed surface commands land here.
    fn on_bitmap_updated(&mut self, update: &BitmapUpdate) {
        if update.data.is_empty() {
            return;
        }

        let mut png = Vec::new();
        let encoded =
            PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Sub)
                .write_image(
                    &update.data,
                    u32::from(update.width),
                    u32::from(update.height),
                    ExtendedColorType::Rgba8,
                );

        if let Err(err) = encoded {
            tracing::warn!(%err, "failed to encode a graphics pipeline bitmap");
            return;
        }

        if !self.seen_bitmap {
            self.seen_bitmap = true;
            tracing::info!(
                codec = ?update.codec_id,
                width = update.width,
                height = update.height,
                "first rdp graphics pipeline bitmap drawn"
            );
        }

        let rect = &update.destination_rectangle;
        let event = TargetEvent::ImageUpdate {
            x: i32::from(rect.left),
            y: i32::from(rect.top),
            mimetype: "image/png",
            data: Bytes::from(png),
        };
        if let Ok(mut frames) = self.frames.lock() {
            frames.push_back(event);
        }
    }

    /// Fill regions with a flat colour.
    ///
    /// Cheap for the server and common for window backgrounds. A region
    /// filled here and not forwarded simply keeps whatever was underneath.
    /// PNG is a fine carrier: a single-colour image costs a few hundred
    /// bytes whatever its dimensions.
    fn on_solid_fill(&mut self, pdu: &SolidFillPdu) {
        let c = &pdu.fill_pixel;
        for rect in &pdu.rectangles {
            let (w, h) = (u32::from(rect.width()), u32::from(rect.height()));
            if w == 0 || h == 0 {
                continue;
            }

            let pixels: Vec<u8> = [c.r, c.g, c.b, 0xff]
                .iter()
                .copied()
                .cycle()
                .take((w as usize) * (h as usize) * 4)
                .collect();

            let mut png = Vec::new();
            if PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Sub)
                .write_image(&pixels, w, h, ExtendedColorType::Rgba8)
                .is_err()
            {
                continue;
            }

            self.push(TargetEvent::ImageUpdate {
                x: i32::from(rect.left),
                y: i32::from(rect.top),
                mimetype: "image/png",
                data: Bytes::from(png),
            });
        }
    }

    /// Move a region that is already on screen.
    ///
    /// The client holds the pixels, so this becomes a canvas-side copy and
    /// costs nine integers rather than a re-encode. Scrolling and window
    /// drags lean on it heavily; dropping it leaves stale content behind.
    fn on_surface_to_surface(&mut self, pdu: &SurfaceToSurfacePdu) {
        // Cross-surface copies would need a surface the client does not
        // have. Only same-surface moves are expressible.
        if pdu.source_surface_id != pdu.destination_surface_id {
            if !self.warned_cross_surface {
                self.warned_cross_surface = true;
                tracing::warn!("cross-surface copies are not forwarded");
            }
            return;
        }

        let src = &pdu.source_rectangle;
        for point in &pdu.destination_points {
            self.push(TargetEvent::CopyRegion {
                src_x: i32::from(src.left),
                src_y: i32::from(src.top),
                width: u32::from(src.width()),
                height: u32::from(src.height()),
                dst_x: i32::from(point.x),
                dst_y: i32::from(point.y),
            });
        }
    }

    /// Caching needs pixels this engine never holds.
    ///
    /// Passthrough means the frames are never decoded here, so there is
    /// nothing to copy into a cache slot. Warned once: a server leaning on
    /// the cache will leave regions stale.
    fn on_surface_to_cache(&mut self, _pdu: &SurfaceToCachePdu) {
        self.warn_cache();
    }

    fn on_cache_to_surface(&mut self, _pdu: &CacheToSurfacePdu) {
        self.warn_cache();
    }

    ///
    /// Warned once rather than dropped silently: this is the shape a black
    /// screen takes when GFX negotiates without AVC.
    fn on_wire_to_surface2(&mut self, _pdu: &ironrdp_egfx::pdu::WireToSurface2Pdu) {
        if !self.warned_progressive {
            self.warned_progressive = true;
            tracing::warn!(
                "server is sending RemoteFX progressive surface commands, which this \
                 engine cannot decode; turn off the graphics pipeline for this connection"
            );
        }
    }

    fn on_avc_bitstream(
        &mut self,
        _surface_id: u16,
        codec_id: Codec1Type,
        destination_rectangle: &ExclusiveRectangle,
        bitmap_data: &[u8],
    ) -> bool {
        let mut cursor = ReadCursor::new(bitmap_data);

        // 4:4:4 is a main view plus a chroma auxiliary view, each an AVC420
        // stream. WebCodecs decodes one, so only the main view travels --
        // the same 4:2:0 picture a 420-mode server would have sent, minus
        // the chroma enhancement.
        let decoded = match codec_id {
            Codec1Type::Avc420 => Avc420BitmapStream::decode(&mut cursor).map(|s| Some(s.data)),
            Codec1Type::Avc444 | Codec1Type::Avc444v2 => {
                Avc444BitmapStream::decode(&mut cursor).map(|s| {
                    // Either shape loses the 4:4:4 chroma: a second view no
                    // single decoder can consume, or a chroma-only update
                    // whose `stream1` is that view rather than a picture.
                    if s.stream2.is_some() || s.encoding == Encoding::CHROMA {
                        if let Ok(mut dropped) = self.unsupported.lock() {
                            *dropped += 1;
                        }
                    }
                    (s.encoding != Encoding::CHROMA).then_some(s.stream1.data)
                })
            }
            _ => return false,
        };

        let Ok(decoded) = decoded else {
            tracing::warn!(?codec_id, "malformed AVC bitmap stream");
            // Claimed regardless: a frame we cannot parse is not one the
            // decode path could have used either.
            return true;
        };

        let Some(data) = decoded else {
            return true;
        };

        let mut annex_b = Vec::with_capacity(data.len() + 16);
        let keyframe = avc_to_annex_b(data, &mut annex_b);

        let rect = destination_rectangle;
        if !self.seen_first {
            self.seen_first = true;
            tracing::info!(
                ?codec_id,
                width = rect.width(),
                height = rect.height(),
                keyframe,
                bytes = annex_b.len(),
                // Which wire format the host actually used, since the two
                // are indistinguishable once converted.
                wire = if starts_with_start_code(data) {
                    "annex-b"
                } else {
                    "length-prefixed"
                },
                head = ?&data[..data.len().min(8)],
                "first rdp h264 frame passed through"
            );
        }

        let event = TargetEvent::VideoSlice {
            codec: VideoCodec::H264,
            keyframe,
            x: i32::from(rect.left),
            y: i32::from(rect.top),
            width: u32::from(rect.width()),
            height: u32::from(rect.height()),
            timestamp_ms: 0,
            data: Bytes::from(annex_b),
        };

        if let Ok(mut frames) = self.frames.lock() {
            frames.push_back(event);
        }
        true
    }
}

/// Rewrite length-prefixed NAL units as an Annex B stream.
///
/// Returns whether the frame can be decoded from cold.
fn avc_to_annex_b(data: &[u8], out: &mut Vec<u8>) -> bool {
    // MS-RDPEGFX is documented as length-prefixed, but Windows hosts have
    // been seen sending start codes already. Misreading one for the other
    // silently yields a stream no decoder will touch, so detect instead of
    // assuming.
    if starts_with_start_code(data) {
        out.extend_from_slice(data);
        return annex_b_has_keyframe(data);
    }

    let mut keyframe = false;
    let mut offset = 0usize;

    while offset + 4 <= data.len() {
        let len = u32::from_be_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]) as usize;
        offset += 4;

        // A length running past the buffer means the stream is not
        // length-prefixed after all; emitting the rest raw is closer to
        // usable than truncating here.
        if len == 0 || offset + len > data.len() {
            break;
        }

        if is_keyframe_nal(data[offset]) {
            keyframe = true;
        }

        out.extend_from_slice(&START_CODE);
        out.extend_from_slice(&data[offset..offset + len]);
        offset += len;
    }

    keyframe
}

/// Whether a NAL header byte introduces an IDR or a parameter set.
fn is_keyframe_nal(header: u8) -> bool {
    let nal_type = header & 0x1f;
    nal_type == NAL_IDR || nal_type == NAL_SPS
}

fn starts_with_start_code(data: &[u8]) -> bool {
    data.starts_with(&START_CODE) || data.starts_with(&[0x00, 0x00, 0x01])
}

/// Scan an Annex B stream for a NAL that lets a decoder start from cold.
fn annex_b_has_keyframe(data: &[u8]) -> bool {
    let mut i = 0usize;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            if let Some(&header) = data.get(i + 3) {
                if is_keyframe_nal(header) {
                    return true;
                }
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_egfx::pdu::{Color, Point};

    /// A handler plus the queue it writes into.
    fn handler() -> (GfxPassthrough, Arc<Mutex<VecDeque<TargetEvent>>>) {
        let frames = Arc::new(Mutex::new(VecDeque::new()));
        let unsupported = Arc::new(Mutex::new(0));
        (
            GfxPassthrough::new(Arc::clone(&frames), unsupported),
            frames,
        )
    }

    fn rect(left: u16, top: u16, right: u16, bottom: u16) -> ExclusiveRectangle {
        ExclusiveRectangle {
            left,
            top,
            right,
            bottom,
        }
    }

    fn drain(frames: &Arc<Mutex<VecDeque<TargetEvent>>>) -> Vec<TargetEvent> {
        frames
            .lock()
            .expect("queue is not poisoned")
            .drain(..)
            .collect()
    }

    #[test]
    fn a_solid_fill_turns_into_one_image_per_rectangle() {
        let (mut h, frames) = handler();
        h.on_solid_fill(&SolidFillPdu {
            surface_id: 0,
            fill_pixel: Color {
                b: 0x30,
                g: 0x20,
                r: 0x10,
                xa: 0xff,
            },
            rectangles: vec![rect(4, 8, 20, 24), rect(40, 50, 44, 54)],
        });

        let events = drain(&frames);
        assert_eq!(events.len(), 2, "each rectangle needs its own update");
        match &events[0] {
            TargetEvent::ImageUpdate {
                x,
                y,
                mimetype,
                data,
            } => {
                assert_eq!((*x, *y), (4, 8), "the fill lands at the rectangle origin");
                assert_eq!(*mimetype, "image/png");
                assert!(!data.is_empty(), "a fill has to carry actual pixels");
            }
            other => panic!("expected an image update, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_rectangle_is_skipped_rather_than_encoded() {
        let (mut h, frames) = handler();
        // right == left, so the rectangle has no area at all.
        h.on_solid_fill(&SolidFillPdu {
            surface_id: 0,
            fill_pixel: Color {
                b: 0,
                g: 0,
                r: 0,
                xa: 0xff,
            },
            rectangles: vec![rect(10, 10, 10, 40)],
        });

        assert!(
            drain(&frames).is_empty(),
            "a zero-area fill would encode a zero-width PNG"
        );
    }

    #[test]
    fn a_surface_copy_becomes_one_copy_region_per_destination() {
        let (mut h, frames) = handler();
        h.on_surface_to_surface(&SurfaceToSurfacePdu {
            source_surface_id: 1,
            destination_surface_id: 1,
            source_rectangle: rect(10, 20, 110, 70),
            destination_points: vec![Point { x: 200, y: 300 }, Point { x: 400, y: 500 }],
        });

        let events = drain(&frames);
        assert_eq!(events.len(), 2, "both destinations have to be painted");
        assert!(
            matches!(
                events[0],
                TargetEvent::CopyRegion {
                    src_x: 10,
                    src_y: 20,
                    width: 100,
                    height: 50,
                    dst_x: 200,
                    dst_y: 300,
                }
            ),
            "geometry came through as {:?}",
            events[0]
        );
    }

    #[test]
    fn a_cross_surface_copy_is_dropped_because_the_client_lacks_the_source() {
        let (mut h, frames) = handler();
        h.on_surface_to_surface(&SurfaceToSurfacePdu {
            source_surface_id: 1,
            destination_surface_id: 2,
            source_rectangle: rect(0, 0, 10, 10),
            destination_points: vec![Point { x: 0, y: 0 }],
        });

        assert!(
            drain(&frames).is_empty(),
            "copying from a surface we never held would paint garbage"
        );
        assert!(h.warned_cross_surface, "the operator needs telling once");
    }

    #[test]
    fn cache_traffic_warns_exactly_once() {
        let (mut h, _frames) = handler();
        h.on_surface_to_cache(&SurfaceToCachePdu {
            surface_id: 0,
            cache_key: 1,
            cache_slot: 1,
            source_rectangle: rect(0, 0, 10, 10),
        });
        assert!(h.warned_cache);

        // A busy server sends these continuously; one warning is plenty.
        h.on_cache_to_surface(&CacheToSurfacePdu {
            cache_slot: 1,
            surface_id: 0,
            destination_points: vec![Point { x: 0, y: 0 }],
        });
        assert!(h.warned_cache, "the flag must stay latched");
    }

    #[test]
    fn length_prefixes_become_start_codes() {
        // Two NAL units: a non-IDR slice, then an IDR.
        let data = [
            0, 0, 0, 2, 0x41, 0xaa, // len 2, nal_type 1
            0, 0, 0, 3, 0x65, 0xbb, 0xcc, // len 3, nal_type 5 (IDR)
        ];
        let mut out = Vec::new();
        let keyframe = avc_to_annex_b(&data, &mut out);

        assert!(keyframe, "an IDR unit has to mark the frame as a keyframe");
        assert_eq!(
            out,
            vec![0, 0, 0, 1, 0x41, 0xaa, 0, 0, 0, 1, 0x65, 0xbb, 0xcc]
        );
    }

    #[test]
    fn a_frame_without_an_idr_is_a_delta() {
        let data = [0, 0, 0, 2, 0x41, 0xaa];
        let mut out = Vec::new();
        assert!(!avc_to_annex_b(&data, &mut out));
    }

    #[test]
    fn an_sps_alone_still_counts_as_a_keyframe() {
        // Windows sends SPS/PPS ahead of the IDR in the same access unit;
        // the browser cannot start without them.
        let data = [0, 0, 0, 2, 0x67, 0x42];
        let mut out = Vec::new();
        assert!(avc_to_annex_b(&data, &mut out));
    }

    #[test]
    fn a_length_running_past_the_buffer_stops_rather_than_panicking() {
        let data = [0, 0, 0, 99, 0x65, 0xbb];
        let mut out = Vec::new();
        assert!(!avc_to_annex_b(&data, &mut out));
        assert!(out.is_empty());
    }

    #[test]
    fn an_annex_b_stream_is_passed_through_untouched() {
        // A four-byte start code would otherwise be read as a length of 1,
        // and the frame silently mangled.
        let data = [0, 0, 0, 1, 0x65, 0xaa, 0, 0, 0, 1, 0x41, 0xbb];
        let mut out = Vec::new();
        let keyframe = avc_to_annex_b(&data, &mut out);

        assert!(keyframe);
        assert_eq!(out, data);
    }

    #[test]
    fn a_three_byte_start_code_is_recognised_too() {
        let data = [0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x41, 0xbb];
        let mut out = Vec::new();

        assert!(avc_to_annex_b(&data, &mut out));
        assert_eq!(out, data);
    }

    #[test]
    fn an_annex_b_stream_without_an_idr_is_a_delta() {
        let data = [0, 0, 0, 1, 0x41, 0xaa];
        let mut out = Vec::new();

        assert!(!avc_to_annex_b(&data, &mut out));
        assert_eq!(out, data);
    }
}
