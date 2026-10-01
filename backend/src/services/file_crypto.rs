// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Chunked authenticated encryption for staged files (PERF-03).
//!
//! Format 2 is a header — `STRATAF\x02`, the chunk size (u32, big-endian)
//! and a random 7-byte nonce prefix — followed by the plaintext in chunks
//! of that size, each sealed with AES-256-GCM under the STREAM
//! construction (`aead::stream`, BE32). The nonce carries the chunk's
//! position and a last-chunk flag, so reordered, duplicated, dropped or
//! truncated chunks fail to authenticate. Every chunk's associated data is
//! the header plus the file's id, binding it to this file and format.
//!
//! Every file has its own key, so nonces never repeat under one key.

use std::io::{self, Read, Write};
use std::path::Path;

use aes_gcm::aead::generic_array::GenericArray;
use aes_gcm::aead::stream::{DecryptorBE32, EncryptorBE32};
use aes_gcm::{Aes256Gcm, KeyInit};
use bytes::Bytes;
use futures_util::Stream;
use rand::RngExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use uuid::Uuid;

const MAGIC: &[u8; 8] = b"STRATAF\x02";
/// Plaintext bytes per chunk.
pub const CHUNK: usize = 64 * 1024;
/// Largest chunk size a header may declare.
const MAX_CHUNK: usize = 1024 * 1024;
const TAG: usize = 16;
const PREFIX: usize = 7;
const HEADER_LEN: usize = MAGIC.len() + 4 + PREFIX;

/// What [`encrypt_file`] learnt about the plaintext.
#[derive(Debug)]
pub struct Sealed {
    pub size: u64,
    pub sha256: String,
}

fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_owned())
}

fn cipher(key: &[u8]) -> io::Result<Aes256Gcm> {
    Aes256Gcm::new_from_slice(key).map_err(|_| invalid("file key must be 32 bytes"))
}

fn associated_data(header: &[u8], file_id: Uuid) -> Vec<u8> {
    [header, file_id.as_bytes()].concat()
}

/// Append up to `n` more bytes from `r` to `buf`, fewer only at end of file.
fn read_up_to(r: &mut impl Read, buf: &mut Vec<u8>, n: usize) -> io::Result<()> {
    r.take(n as u64).read_to_end(buf).map(drop)
}

async fn read_up_to_async(
    r: &mut (impl tokio::io::AsyncRead + Unpin),
    buf: &mut Vec<u8>,
    n: usize,
) -> io::Result<()> {
    r.take(n as u64).read_to_end(buf).await.map(drop)
}

fn create_private(path: &Path) -> io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// Encrypt `src` into a new file at `dst`, hashing the plaintext as it is
/// read. Plaintext longer than `max` bytes is refused with
/// [`io::ErrorKind::FileTooLarge`]. `dst` must not exist, and is removed
/// again if encryption fails. Blocking; run it off the async workers.
pub fn encrypt_file(
    src: &Path,
    dst: &Path,
    key: &[u8],
    file_id: Uuid,
    max: u64,
) -> io::Result<Sealed> {
    let input = std::fs::File::open(src)?;
    let out = create_private(dst)?;
    write_sealed(input, out, key, file_id, max).inspect_err(|_| {
        let _ = std::fs::remove_file(dst);
    })
}

fn write_sealed(
    input: std::fs::File,
    out: std::fs::File,
    key: &[u8],
    file_id: Uuid,
    max: u64,
) -> io::Result<Sealed> {
    let mut input = io::BufReader::with_capacity(CHUNK, input);
    let mut out = io::BufWriter::with_capacity(CHUNK + TAG, out);

    let prefix: [u8; PREFIX] = rand::rng().random();
    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.extend_from_slice(&(CHUNK as u32).to_be_bytes());
    header.extend_from_slice(&prefix);
    out.write_all(&header)?;

    let aad = associated_data(&header, file_id);
    let mut enc = EncryptorBE32::from_aead(cipher(key)?, GenericArray::from_slice(&prefix));
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buf = Vec::with_capacity(CHUNK + TAG);
    let mut ahead = Vec::with_capacity(CHUNK + TAG);
    read_up_to(&mut input, &mut ahead, CHUNK)?;
    loop {
        std::mem::swap(&mut buf, &mut ahead);
        ahead.clear();
        size += buf.len() as u64;
        if size > max {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "file exceeds maximum allowed size",
            ));
        }
        hasher.update(&buf);
        if buf.len() == CHUNK {
            read_up_to(&mut input, &mut ahead, CHUNK)?;
        }
        if ahead.is_empty() {
            enc.encrypt_last_in_place(&aad, &mut buf)
                .map_err(|_| invalid("encryption failed"))?;
            out.write_all(&buf)?;
            break;
        }
        enc.encrypt_next_in_place(&aad, &mut buf)
            .map_err(|_| invalid("encryption failed"))?;
        out.write_all(&buf)?;
        buf.clear();
    }
    out.into_inner().map_err(|e| e.into_error())?.sync_all()?;

    Ok(Sealed {
        size,
        sha256: hex(&hasher.finalize()),
    })
}

struct Opened {
    dec: DecryptorBE32<Aes256Gcm>,
    aad: Vec<u8>,
    frame: usize,
}

fn open(header: &[u8; HEADER_LEN], key: &[u8], file_id: Uuid) -> io::Result<Opened> {
    if &header[..MAGIC.len()] != MAGIC {
        return Err(invalid("not an encrypted file of a known format"));
    }
    let chunk = u32::from_be_bytes(header[MAGIC.len()..MAGIC.len() + 4].try_into().unwrap());
    let chunk = chunk as usize;
    if chunk == 0 || chunk > MAX_CHUNK {
        return Err(invalid("bad chunk size"));
    }
    let prefix = &header[MAGIC.len() + 4..];
    Ok(Opened {
        dec: DecryptorBE32::from_aead(cipher(key)?, GenericArray::from_slice(prefix)),
        aad: associated_data(header, file_id),
        frame: chunk + TAG,
    })
}

fn tampered() -> io::Error {
    invalid("encrypted file failed authentication")
}

/// Authenticate every chunk of `path` and check it holds `expected_size`
/// plaintext bytes, without keeping any of it. Blocking.
pub fn verify_file(path: &Path, key: &[u8], file_id: Uuid, expected_size: u64) -> io::Result<()> {
    let mut input = io::BufReader::with_capacity(CHUNK + TAG, std::fs::File::open(path)?);
    let mut header = [0u8; HEADER_LEN];
    input.read_exact(&mut header)?;
    let Opened {
        mut dec,
        aad,
        frame,
    } = open(&header, key, file_id)?;

    let mut size = 0u64;
    let mut buf = Vec::with_capacity(frame);
    let mut ahead = Vec::with_capacity(frame);
    read_up_to(&mut input, &mut ahead, frame)?;
    loop {
        std::mem::swap(&mut buf, &mut ahead);
        ahead.clear();
        if buf.len() == frame {
            read_up_to(&mut input, &mut ahead, frame)?;
        }
        if ahead.is_empty() {
            dec.decrypt_last_in_place(&aad, &mut buf)
                .map_err(|_| tampered())?;
            size += buf.len() as u64;
            break;
        }
        dec.decrypt_next_in_place(&aad, &mut buf)
            .map_err(|_| tampered())?;
        size += buf.len() as u64;
        buf.clear();
    }
    if size != expected_size {
        return Err(invalid("encrypted file has the wrong length"));
    }
    Ok(())
}

struct StreamState {
    file: tokio::fs::File,
    dec: Option<DecryptorBE32<Aes256Gcm>>,
    aad: Vec<u8>,
    ahead: Vec<u8>,
    frame: usize,
}

/// Decrypt `file` chunk by chunk. Each chunk is authenticated before it is
/// yielded; a chunk that fails, or a missing tail, ends the stream with an
/// error.
pub async fn decrypt_stream(
    mut file: tokio::fs::File,
    key: &[u8],
    file_id: Uuid,
) -> io::Result<impl Stream<Item = io::Result<Bytes>> + Send + 'static> {
    let mut header = [0u8; HEADER_LEN];
    file.read_exact(&mut header).await?;
    let Opened { dec, aad, frame } = open(&header, key, file_id)?;
    let mut ahead = Vec::with_capacity(frame);
    read_up_to_async(&mut file, &mut ahead, frame).await?;
    let state = StreamState {
        file,
        dec: Some(dec),
        aad,
        ahead,
        frame,
    };
    Ok(futures_util::stream::try_unfold(
        state,
        |mut s| async move {
            let Some(mut dec) = s.dec.take() else {
                return Ok(None);
            };
            let mut buf = std::mem::replace(&mut s.ahead, Vec::with_capacity(s.frame));
            if buf.len() == s.frame {
                read_up_to_async(&mut s.file, &mut s.ahead, s.frame).await?;
            }
            if s.ahead.is_empty() {
                dec.decrypt_last_in_place(&s.aad, &mut buf)
                    .map_err(|_| tampered())?;
            } else {
                dec.decrypt_next_in_place(&s.aad, &mut buf)
                    .map_err(|_| tampered())?;
                s.dec = Some(dec);
            }
            Ok(Some((Bytes::from(buf), s)))
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::TryStreamExt;
    use tempfile::TempDir;

    const KEY: [u8; 32] = [7; 32];

    fn plaintext(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 % 251) as u8).collect()
    }

    fn seal(dir: &TempDir, data: &[u8], id: Uuid) -> std::path::PathBuf {
        let src = dir.path().join("plain");
        let dst = dir.path().join("sealed");
        std::fs::write(&src, data).unwrap();
        let sealed = encrypt_file(&src, &dst, &KEY, id, u64::MAX).unwrap();
        assert_eq!(sealed.size, data.len() as u64);
        dst
    }

    async fn decrypt(path: &Path, id: Uuid) -> io::Result<Vec<u8>> {
        let file = tokio::fs::File::open(path).await?;
        let chunks: Vec<Bytes> = decrypt_stream(file, &KEY, id).await?.try_collect().await?;
        Ok(chunks.concat())
    }

    #[tokio::test]
    async fn round_trips_at_chunk_boundaries() {
        for len in [1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 3 * CHUNK + 17] {
            let dir = TempDir::new().unwrap();
            let id = Uuid::new_v4();
            let data = plaintext(len);
            let sealed = seal(&dir, &data, id);
            verify_file(&sealed, &KEY, id, len as u64).unwrap();
            assert_eq!(decrypt(&sealed, id).await.unwrap(), data, "length {len}");
        }
    }

    #[test]
    fn hashes_the_plaintext() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("plain");
        std::fs::write(&src, b"hello").unwrap();
        let sealed = encrypt_file(&src, &dir.path().join("out"), &KEY, Uuid::nil(), 100).unwrap();
        assert_eq!(
            sealed.sha256,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn refuses_files_over_the_limit_and_never_overwrites() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("plain");
        std::fs::write(&src, plaintext(CHUNK + 1)).unwrap();
        let err =
            encrypt_file(&src, &dir.path().join("a"), &KEY, Uuid::nil(), CHUNK as u64).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::FileTooLarge);
        assert!(!dir.path().join("a").exists());
        let err = encrypt_file(&src, &src, &KEY, Uuid::nil(), u64::MAX).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert!(src.exists());
    }

    /// Every way of damaging a sealed file must fail, both when verifying
    /// and when streaming.
    #[tokio::test]
    async fn rejects_corrupt_reordered_truncated_and_duplicated_chunks() {
        let dir = TempDir::new().unwrap();
        let id = Uuid::new_v4();
        let len = 3 * CHUNK;
        let sealed = std::fs::read(seal(&dir, &plaintext(len), id)).unwrap();
        let frame = CHUNK + TAG;
        let chunk = |i: usize| &sealed[HEADER_LEN + i * frame..HEADER_LEN + (i + 1) * frame];
        let header = &sealed[..HEADER_LEN];

        let mut flipped = sealed.clone();
        flipped[HEADER_LEN + 5] ^= 1;
        let mut bad_header = sealed.clone();
        bad_header[HEADER_LEN - 1] ^= 1;
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("bit flip", flipped),
            ("header", bad_header),
            ("reordered", [header, chunk(1), chunk(0), chunk(2)].concat()),
            ("dropped tail", [header, chunk(0), chunk(1)].concat()),
            ("dropped middle", [header, chunk(0), chunk(2)].concat()),
            (
                "duplicated",
                [header, chunk(0), chunk(0), chunk(1), chunk(2)].concat(),
            ),
            ("cut mid-chunk", sealed[..sealed.len() - 10].to_vec()),
            ("appended", [&sealed[..], chunk(2)].concat()),
        ];
        for (name, bytes) in cases {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            assert!(
                verify_file(&path, &KEY, id, len as u64).is_err(),
                "{name} verified"
            );
            assert!(decrypt(&path, id).await.is_err(), "{name} decrypted");
        }
    }

    #[tokio::test]
    async fn is_bound_to_its_file_and_key() {
        let dir = TempDir::new().unwrap();
        let id = Uuid::new_v4();
        let sealed = seal(&dir, &plaintext(100), id);
        assert!(verify_file(&sealed, &KEY, Uuid::new_v4(), 100).is_err());
        assert!(verify_file(&sealed, &[8; 32], id, 100).is_err());
        assert!(verify_file(&sealed, &KEY, id, 99).is_err());
        assert!(decrypt(&sealed, Uuid::new_v4()).await.is_err());
    }
}
