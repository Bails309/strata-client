//! Clipboard bridge between the RDP `CLIPRDR` channel and the session.
//!
//! `CLIPRDR` uses delayed rendering: whoever copies only *advertises*
//! the formats it holds, and the data is fetched later if the other side
//! actually pastes. Both directions therefore take two round trips, and
//! the backend below exists to turn those callbacks — which `ironrdp`
//! invokes synchronously while decoding a PDU — into events the session
//! loop can act on.
//!
//! Only text is carried. File transfer over the clipboard is deliberately
//! not offered: this gateway has an audited file path of its own, and
//! `CLIPRDR` file streams would bypass it.

use bytes::Bytes;
use ironrdp_cliprdr::backend::CliprdrBackend;
use ironrdp_cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId,
};
use ironrdp_core::AsAny;
use tokio::sync::mpsc::UnboundedSender;

/// Largest clipboard payload exchanged with the target.
pub const MAX_CLIPBOARD_BYTES: usize = 8 * 1024 * 1024;

/// Something the `CLIPRDR` channel needs the session to act on.
#[derive(Debug)]
pub enum ClipboardEvent {
    /// The target copied something and advertised these formats.
    RemoteFormats(Vec<ClipboardFormatId>),
    /// The target answered our paste request.
    RemoteData {
        /// The target could not supply the data.
        is_error: bool,
        /// Raw format data, still in the target's encoding.
        data: Vec<u8>,
    },
    /// The target is pasting and wants our clipboard in this format.
    DataRequest(ClipboardFormatId),
    /// The target wants our format list before it will announce its own.
    FormatListRequested,
}

/// Forwards `CLIPRDR` callbacks to the session loop.
#[derive(Debug)]
pub struct SessionClipboard {
    events: UnboundedSender<ClipboardEvent>,
    temporary_directory: String,
}

impl SessionClipboard {
    /// Create a backend publishing to `events`.
    #[must_use]
    pub fn new(events: UnboundedSender<ClipboardEvent>) -> Self {
        Self {
            events,
            temporary_directory: ".".to_owned(),
        }
    }
}

impl AsAny for SessionClipboard {
    fn as_any(&self) -> &dyn core::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
        self
    }
}

impl CliprdrBackend for SessionClipboard {
    fn temporary_directory(&self) -> &str {
        &self.temporary_directory
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        // No file-transfer capability: see the module note.
        ClipboardGeneralCapabilityFlags::empty()
    }

    fn on_ready(&mut self) {
        tracing::debug!("rdp clipboard: channel ready");
    }

    fn on_request_format_list(&mut self) {
        tracing::debug!("rdp clipboard: target requested our format list");
        let _ = self.events.send(ClipboardEvent::FormatListRequested);
    }

    fn on_process_negotiated_capabilities(&mut self, caps: ClipboardGeneralCapabilityFlags) {
        tracing::debug!(?caps, "rdp clipboard: negotiated capabilities");
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        let formats = available_formats.iter().map(|format| format.id).collect();
        let _ = self.events.send(ClipboardEvent::RemoteFormats(formats));
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let _ = self
            .events
            .send(ClipboardEvent::DataRequest(request.format));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        let _ = self.events.send(ClipboardEvent::RemoteData {
            is_error: response.is_error(),
            data: response.data().to_vec(),
        });
    }

    fn on_file_contents_request(&mut self, _: FileContentsRequest) {}

    fn on_file_contents_response(&mut self, _: FileContentsResponse<'_>) {}

    fn on_lock(&mut self, _: LockDataId) {}

    fn on_unlock(&mut self, _: LockDataId) {}
}

/// Pick the richest text format the target offered.
#[must_use]
pub fn preferred_text_format(formats: &[ClipboardFormatId]) -> Option<ClipboardFormatId> {
    [
        ClipboardFormatId::CF_UNICODETEXT,
        ClipboardFormatId::CF_OEMTEXT,
        ClipboardFormatId::CF_TEXT,
    ]
    .into_iter()
    .find(|wanted| formats.contains(wanted))
}

/// Decode clipboard bytes the target sent in `format`.
///
/// Returns `None` when the payload is not text this bridge carries.
#[must_use]
pub fn decode_clipboard(format: ClipboardFormatId, data: &[u8]) -> Option<Bytes> {
    let text = if format == ClipboardFormatId::CF_UNICODETEXT {
        let (pairs, _) = data.as_chunks::<2>();
        let units: Vec<u16> = pairs
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .take_while(|unit| *unit != 0)
            .collect();
        String::from_utf16(&units).ok()?
    } else {
        let end = data.iter().position(|b| *b == 0).unwrap_or(data.len());
        String::from_utf8(data[..end].to_vec()).ok()?
    };

    // Browsers expect bare newlines; Windows sends CRLF.
    Some(Bytes::from(text.replace("\r\n", "\n").into_bytes()))
}

/// Build the response to a target paste request.
#[must_use]
pub fn encode_clipboard(format: ClipboardFormatId, text: &str) -> FormatDataResponse<'static> {
    // Windows applications expect CRLF line endings.
    let text = text.replace('\n', "\r\n").replace("\r\r\n", "\r\n");
    if format == ClipboardFormatId::CF_UNICODETEXT {
        FormatDataResponse::new_unicode_string(&text)
    } else {
        FormatDataResponse::new_string(&text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backend() -> (
        SessionClipboard,
        tokio::sync::mpsc::UnboundedReceiver<ClipboardEvent>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (SessionClipboard::new(tx), rx)
    }

    #[test]
    fn monitor_ready_is_answered_with_a_format_list() {
        // Windows withholds its own format lists until the client has
        // sent one, so stubbing this callback stops every copy out of
        // the session — silently, because nothing is ever advertised.
        let (mut backend, mut events) = backend();
        backend.on_request_format_list();
        assert!(matches!(
            events.try_recv(),
            Ok(ClipboardEvent::FormatListRequested)
        ));
    }

    #[test]
    fn a_remote_copy_forwards_every_offered_format() {
        let (mut backend, mut events) = backend();
        backend.on_remote_copy(&[
            ClipboardFormat::new(ClipboardFormatId::CF_TEXT),
            ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
        ]);
        match events.try_recv() {
            Ok(ClipboardEvent::RemoteFormats(formats)) => assert_eq!(
                formats,
                vec![
                    ClipboardFormatId::CF_TEXT,
                    ClipboardFormatId::CF_UNICODETEXT
                ]
            ),
            other => panic!("expected a format advert, got {other:?}"),
        }
    }

    #[test]
    fn file_transfer_is_never_advertised() {
        // The gateway has an audited file path; a CLIPRDR file stream
        // would go around it.
        let (backend, _events) = backend();
        assert!(backend.client_capabilities().is_empty());
    }

    #[test]
    fn unicode_text_is_preferred_over_ansi() {
        let formats = vec![
            ClipboardFormatId::CF_TEXT,
            ClipboardFormatId::CF_UNICODETEXT,
        ];
        assert_eq!(
            preferred_text_format(&formats),
            Some(ClipboardFormatId::CF_UNICODETEXT)
        );
    }

    #[test]
    fn a_target_offering_no_text_is_ignored() {
        assert_eq!(preferred_text_format(&[ClipboardFormatId::CF_BITMAP]), None);
    }

    #[test]
    fn utf16_is_decoded_and_newlines_normalised() {
        let mut data: Vec<u8> = "a\r\nb".encode_utf16().flat_map(u16::to_le_bytes).collect();
        data.extend_from_slice(&[0, 0]);
        let decoded = decode_clipboard(ClipboardFormatId::CF_UNICODETEXT, &data).unwrap();
        assert_eq!(&decoded[..], b"a\nb");
    }

    #[test]
    fn ansi_text_stops_at_the_null_terminator() {
        let decoded = decode_clipboard(ClipboardFormatId::CF_TEXT, b"hi\0junk").unwrap();
        assert_eq!(&decoded[..], b"hi");
    }

    #[test]
    fn outgoing_text_gets_windows_line_endings() {
        let response = encode_clipboard(ClipboardFormatId::CF_TEXT, "a\nb");
        assert_eq!(response.data(), b"a\r\nb\0");
    }

    #[test]
    fn outgoing_text_does_not_double_existing_crlf() {
        let response = encode_clipboard(ClipboardFormatId::CF_TEXT, "a\r\nb");
        assert_eq!(response.data(), b"a\r\nb\0");
    }
}
