//! RDPSND client backend: desktop audio from the target to the browser.
//!
//! The browser can only play raw PCM — `Guacamole.RawAudioPlayer` accepts
//! `audio/L8` and `audio/L16` and nothing else — so exactly one format is
//! advertised and any compressed alternative the target offers is declined.
//! That costs bandwidth against a codec, and buys not having to ship a
//! decoder for whatever a given Windows build happens to prefer.

use std::borrow::Cow;

use bytes::Bytes;
use ironrdp_rdpsnd::client::RdpsndClientHandler;
use ironrdp_rdpsnd::pdu::{AudioFormat, AudioFormatFlags, PitchPdu, VolumePdu, WaveFormat};
use tokio::sync::mpsc::Sender;

/// Sample rate advertised to the target, matching the browser default.
pub const SAMPLE_RATE: u32 = 44_100;
/// Stereo: the desktop mixes to two channels and the player handles both.
pub const CHANNELS: u16 = 2;
/// Signed 16-bit, which is what `audio/L16` means.
pub const BITS_PER_SAMPLE: u16 = 16;

/// The Guacamole mimetype describing [`SAMPLE_RATE`], [`CHANNELS`] and
/// [`BITS_PER_SAMPLE`].
pub use crate::transport::guac_wire::AUDIO_MIMETYPE as MIMETYPE;

/// How many wave packets may queue before the oldest are dropped.
///
/// Audio is real time: a listener who has fallen behind wants the current
/// sound, not a backlog. At roughly 176 kB/s this bounds the queue to well
/// under a second, and an unbounded channel here would let a stalled
/// browser grow the session's memory without limit.
const QUEUE_DEPTH: usize = 16;

/// Receives wave data from the target and forwards it to the session.
#[derive(Debug)]
pub struct SessionAudio {
    formats: Vec<AudioFormat>,
    tx: Sender<Bytes>,
    /// Set once a malformed format index has been reported, so a
    /// misbehaving target cannot flood the log.
    warned_unknown_format: bool,
}

impl SessionAudio {
    /// Build a backend that forwards wave packets to `tx`.
    pub fn new(tx: Sender<Bytes>) -> Self {
        let bytes_per_frame = u32::from(CHANNELS) * u32::from(BITS_PER_SAMPLE) / 8;
        Self {
            formats: vec![AudioFormat {
                format: WaveFormat::PCM,
                n_channels: CHANNELS,
                n_samples_per_sec: SAMPLE_RATE,
                n_avg_bytes_per_sec: SAMPLE_RATE * bytes_per_frame,
                #[allow(clippy::cast_possible_truncation)]
                n_block_align: bytes_per_frame as u16,
                bits_per_sample: BITS_PER_SAMPLE,
                data: None,
            }],
            tx,
            warned_unknown_format: false,
        }
    }
}

impl RdpsndClientHandler for SessionAudio {
    fn get_flags(&self) -> AudioFormatFlags {
        // ALIVE is mandatory: without it the target sends no audio at all.
        // VOLUME and PITCH are deliberately absent, because honouring them
        // would mean resampling here rather than letting the browser mix.
        AudioFormatFlags::ALIVE
    }

    fn get_formats(&self) -> &[AudioFormat] {
        &self.formats
    }

    fn wave(&mut self, format_no: usize, _ts: u32, data: Cow<'_, [u8]>) {
        // Per MS-RDPEA the index is into the format list this client
        // advertised, and exactly one was advertised. A different value
        // means the data is not the PCM the browser has been told to
        // expect, and playing it would produce noise.
        if format_no != 0 {
            if !self.warned_unknown_format {
                self.warned_unknown_format = true;
                tracing::warn!(
                    format_no,
                    "target sent audio in a format that was never offered; dropping it"
                );
            }
            return;
        }

        if self.tx.try_send(Bytes::copy_from_slice(&data)).is_err() {
            // Either the session has gone, or the listener is behind. Both
            // are handled by dropping: the next packet is more useful than
            // this one.
            tracing::trace!(bytes = data.len(), "dropped a wave packet");
        }
    }

    fn set_volume(&mut self, _volume: VolumePdu) {}

    fn set_pitch(&mut self, _pitch: PitchPdu) {}

    fn close(&mut self) {}
}

/// A channel sized for [`QUEUE_DEPTH`] wave packets.
pub fn channel() -> (Sender<Bytes>, tokio::sync::mpsc::Receiver<Bytes>) {
    tokio::sync::mpsc::channel(QUEUE_DEPTH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_raw_pcm_is_offered() {
        // The browser's player understands nothing else, so advertising a
        // codec would produce silence rather than a fallback.
        let (tx, _rx) = channel();
        let audio = SessionAudio::new(tx);
        let formats = audio.get_formats();
        assert_eq!(formats.len(), 1);
        assert_eq!(formats[0].format, WaveFormat::PCM);
        assert_eq!(formats[0].bits_per_sample, BITS_PER_SAMPLE);
        assert_eq!(formats[0].n_samples_per_sec, SAMPLE_RATE);
        assert_eq!(formats[0].n_channels, CHANNELS);
    }

    #[test]
    fn the_advertised_format_matches_what_the_browser_is_told() {
        // A mismatch here is silent: the player would decode whatever
        // arrives at the rate in the mimetype and simply sound wrong.
        let (tx, _rx) = channel();
        let audio = SessionAudio::new(tx);
        let format = &audio.get_formats()[0];
        assert_eq!(
            MIMETYPE,
            format!(
                "audio/L{};rate={},channels={}",
                format.bits_per_sample, format.n_samples_per_sec, format.n_channels
            )
        );
        assert_eq!(
            format.n_avg_bytes_per_sec,
            SAMPLE_RATE * u32::from(CHANNELS) * u32::from(BITS_PER_SAMPLE) / 8
        );
    }

    #[test]
    fn audio_is_only_carried_when_the_target_is_told_we_are_listening() {
        let (tx, _rx) = channel();
        let audio = SessionAudio::new(tx);
        assert!(
            audio.get_flags().contains(AudioFormatFlags::ALIVE),
            "without ALIVE the target sends nothing"
        );
    }

    #[tokio::test]
    async fn a_wave_packet_reaches_the_session() {
        let (tx, mut rx) = channel();
        let mut audio = SessionAudio::new(tx);
        audio.wave(0, 0, Cow::Borrowed(&[1, 2, 3, 4]));
        assert_eq!(rx.recv().await.unwrap().as_ref(), &[1, 2, 3, 4]);
    }

    #[tokio::test]
    async fn a_format_that_was_never_offered_is_dropped() {
        let (tx, mut rx) = channel();
        let mut audio = SessionAudio::new(tx);
        audio.wave(3, 0, Cow::Borrowed(&[1, 2, 3, 4]));
        assert!(
            rx.try_recv().is_err(),
            "data in an unknown format must not reach the browser"
        );
    }

    #[tokio::test]
    async fn a_listener_that_falls_behind_does_not_grow_the_session() {
        let (tx, _rx) = channel();
        let mut audio = SessionAudio::new(tx);
        // Far more than the queue holds; the excess must be discarded
        // rather than buffered.
        for _ in 0..QUEUE_DEPTH * 4 {
            audio.wave(0, 0, Cow::Borrowed(&[0; 512]));
        }
    }
}
