// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Chromium Login Data autofill — rustguac parity (Phase 2,
//! tracker [`docs/runbooks/rustguac-parity-tracker.md`]).
//!
//! Encrypts a plaintext password into the byte format that Chromium's
//! `password_manager` reads from the `password_value` BLOB column of
//! the `logins` table inside its `Login Data` SQLite database (Linux,
//! `--password-store=basic`).
//!
//! Wire format
//! -----------
//!
//! `password_value = b"v10" || AES-128-CBC(key, IV, PKCS7(plaintext))`
//!
//! - **Magic prefix** `v10` (3 bytes, ASCII). Tells `OSCrypt` to use the
//!   basic-profile key. (`v11` would be the GNOME Keyring path which we
//!   never use because we explicitly start Chromium with
//!   `--password-store=basic`.)
//! - **Key** PBKDF2-HMAC-SHA1, 16 bytes, salt `"saltysalt"`, password
//!   `"peanuts"`, iteration count `1`. These are *the* fixed Chromium
//!   constants — they're literally hard-coded in the Chromium source
//!   (`components/os_crypt/sync/key_storage_linux.cc`). Writing the
//!   blob with any other parameters means Chromium won't decrypt it.
//! - **IV** 16 bytes of `0x20` (ASCII space). Also fixed.
//! - **Padding** PKCS#7 (handled by [`cbc::Encryptor::encrypt_padded_vec_mut`]).
//!
//! This is the same fixed-key construction every Chromium-on-Linux
//! profile uses — it's not a security mechanism, it's an obfuscation
//! to keep `Login Data` from being trivially `cat`-able. Strata's
//! defence-in-depth lives elsewhere: the kiosk profile is ephemeral
//! (wiped at session end), the egress allow-list blocks SSRF, and the
//! credential never leaves the backend in plaintext form except as
//! this `password_value` blob written to a per-session file.
//!
//! What this module does NOT do
//! ----------------------------
//!
//! - It does not write the SQLite file. The actual `logins` row is
//!   inserted by the spawn-runtime layer (deferred deliverable) using
//!   whatever SQLite path it picks. This module produces just the
//!   encrypted `password_value` blob plus the schema constants.
//! - It does not "decrypt" — Chromium decrypts. We expose
//!   [`decrypt_chromium_v10`] for round-trip tests only.

use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
#[cfg(test)]
use aes::cipher::BlockDecryptMut;

/// Magic prefix Chromium prepends to every basic-profile-encrypted
/// `password_value`.
pub const CHROMIUM_V10_PREFIX: &[u8] = b"v10";

/// PBKDF2 password — fixed in Chromium source.
const CHROMIUM_PBKDF2_PASSWORD: &[u8] = b"peanuts";

/// PBKDF2 salt — fixed in Chromium source.
const CHROMIUM_PBKDF2_SALT: &[u8] = b"saltysalt";

/// PBKDF2 iteration count — fixed in Chromium source. Yes, one. This
/// is **not** a security parameter; the basic profile is obfuscation
/// not encryption.
const CHROMIUM_PBKDF2_ITERATIONS: u32 = 1;

/// AES-128 key length.
const KEY_LEN: usize = 16;

/// AES block size = IV length.
const IV_LEN: usize = 16;

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;
#[cfg(test)]
type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// Derive the 16-byte AES-128 key Chromium uses for the basic profile
/// on Linux. Output is deterministic — same on every machine, every
/// profile. Exposed as `pub(crate)` so the round-trip tests can
/// re-use it without re-running PBKDF2 in every assertion.
pub(crate) fn chromium_basic_key() -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(
        CHROMIUM_PBKDF2_PASSWORD,
        CHROMIUM_PBKDF2_SALT,
        CHROMIUM_PBKDF2_ITERATIONS,
        &mut key,
    );
    key
}

/// Build the `password_value` blob for the given plaintext password.
///
/// Output layout:
///
/// ```text
/// [v10][ AES-128-CBC(key, IV, PKCS7(plaintext)) ]
/// ```
pub fn encrypt_chromium_v10(plaintext: &[u8]) -> Vec<u8> {
    let key = chromium_basic_key();
    let iv = [0x20u8; IV_LEN];
    let cipher = Aes128CbcEnc::new(&key.into(), &iv.into());
    let ct = cipher.encrypt_padded_vec_mut::<Pkcs7>(plaintext);
    let mut out = Vec::with_capacity(CHROMIUM_V10_PREFIX.len() + ct.len());
    out.extend_from_slice(CHROMIUM_V10_PREFIX);
    out.extend_from_slice(&ct);
    out
}

/// Inverse of [`encrypt_chromium_v10`]. Used only by round-trip tests
/// — the production data flow never decrypts these blobs from Strata
/// (Chromium does that on read).
#[cfg(test)]
pub(crate) fn decrypt_chromium_v10(blob: &[u8]) -> Result<Vec<u8>, &'static str> {
    let body = blob
        .strip_prefix(CHROMIUM_V10_PREFIX)
        .ok_or("missing v10 prefix")?;
    let key = chromium_basic_key();
    let iv = [0x20u8; IV_LEN];
    let cipher = Aes128CbcDec::new(&key.into(), &iv.into());
    cipher
        .decrypt_padded_vec_mut::<Pkcs7>(body)
        .map_err(|_| "padding error")
}

/// Full Chromium 134 `Login Data` schema that the spawn-runtime layer
/// writes into the per-session SQLite file. Sourced byte-for-byte from
/// rustguac's `populate_login_data` (see
/// [`docs/runbooks/rustguac-parity-tracker.md`] item C2).
///
/// Without `meta` (mmap_status, version=43, last_compatible_version=40)
/// Chromium's `PasswordStore` migration step crashes on first read.
/// The `sync_*`, `insecure_credentials`, `password_notes`, and `stats`
/// tables are required by the password-manager UI even when no rows
/// exist; their absence triggers schema-version mismatch errors during
/// startup.
///
/// Run as a single batch via `rusqlite::Connection::execute_batch` once
/// the spawn runtime adds the dependency.
pub const LOGINS_TABLE_SCHEMA_SQL: &str = r#"
CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
INSERT INTO meta VALUES('mmap_status','-1');
INSERT INTO meta VALUES('version','43');
INSERT INTO meta VALUES('last_compatible_version','40');
CREATE TABLE logins (
    origin_url VARCHAR NOT NULL,
    action_url VARCHAR,
    username_element VARCHAR,
    username_value VARCHAR,
    password_element VARCHAR,
    password_value BLOB,
    submit_element VARCHAR,
    signon_realm VARCHAR NOT NULL,
    date_created INTEGER NOT NULL,
    blacklisted_by_user INTEGER NOT NULL,
    scheme INTEGER NOT NULL,
    password_type INTEGER,
    times_used INTEGER,
    form_data BLOB,
    display_name VARCHAR,
    icon_url VARCHAR,
    federation_url VARCHAR,
    skip_zero_click INTEGER,
    generation_upload_status INTEGER,
    possible_username_pairs BLOB,
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_last_used INTEGER NOT NULL DEFAULT 0,
    moving_blocked_for BLOB,
    date_password_modified INTEGER NOT NULL DEFAULT 0,
    sender_email VARCHAR,
    sender_name VARCHAR,
    date_received INTEGER,
    sharing_notification_displayed INTEGER NOT NULL DEFAULT 0,
    keychain_identifier BLOB,
    sender_profile_image_url VARCHAR,
    date_last_filled INTEGER NOT NULL DEFAULT 0,
    actor_login_approved INTEGER NOT NULL DEFAULT 0,
    UNIQUE (origin_url, username_element, username_value, password_element, signon_realm)
);
CREATE INDEX logins_signon ON logins (signon_realm);
CREATE TABLE sync_entities_metadata (storage_key INTEGER PRIMARY KEY AUTOINCREMENT, metadata VARCHAR NOT NULL);
CREATE TABLE sync_model_metadata (id INTEGER PRIMARY KEY AUTOINCREMENT, model_metadata VARCHAR NOT NULL);
CREATE TABLE insecure_credentials (parent_id INTEGER REFERENCES logins ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, insecurity_type INTEGER NOT NULL, create_time INTEGER NOT NULL, is_muted INTEGER NOT NULL DEFAULT 0, trigger_notification_from_backend INTEGER NOT NULL DEFAULT 0, UNIQUE (parent_id, insecurity_type));
CREATE INDEX foreign_key_index ON insecure_credentials (parent_id);
CREATE TABLE password_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER NOT NULL REFERENCES logins ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, key VARCHAR NOT NULL, value BLOB, date_created INTEGER NOT NULL, confidential INTEGER, UNIQUE (parent_id, key));
CREATE INDEX foreign_key_index_notes ON password_notes (parent_id);
CREATE TABLE stats (origin_domain VARCHAR NOT NULL, username_value VARCHAR, dismissal_count INTEGER, update_time INTEGER NOT NULL, UNIQUE(origin_domain, username_value));
CREATE INDEX stats_origin ON stats(origin_domain);
"#;

/// Chromium `Preferences` JSON the spawn runtime writes alongside
/// `Login Data` (rustguac parity item C3). Enabling the password
/// manager + autofill is required for Chromium to actually read the
/// `logins` rows we wrote — by default a fresh profile keeps both
/// disabled until first user opt-in.
pub const PREFERENCES_JSON: &str = r#"{
  "credentials_enable_service": true,
  "credentials_enable_autosignin": true,
  "profile": { "password_manager_enabled": true },
  "autofill": { "enabled": true },
  "password_manager": { "saving_enabled": false },
  "download": { "prompt_for_download": false }
}"#;

/// Strongly-typed row built by callers and (eventually) bound into the
/// SQLite INSERT. Stored separately from the encryption helper so that
/// callers don't need to import the crypto types just to construct a
/// row.
#[derive(Debug, Clone)]
#[allow(dead_code)] // Surface for the deferred Login Data SQLite writer.
pub struct LoginsRow {
    /// `https://example.com/login` — the page the form lives on.
    pub origin_url: String,
    /// Form `action=` URL or empty when unknown.
    pub action_url: String,
    /// `https://example.com/` — Chromium's "is this credential for
    /// this site" key. Must match the origin's scheme + host.
    pub signon_realm: String,
    /// Plaintext username.
    pub username_value: String,
    /// Encrypted via [`encrypt_chromium_v10`]. The caller is expected
    /// to populate this directly so that plaintext never sits in a
    /// `LoginsRow` field.
    pub password_value: Vec<u8>,
    /// Unix epoch microseconds — Chromium's clock format.
    pub date_created_us: i64,
}

impl LoginsRow {
    /// Convenience constructor that runs the encryption inline. The
    /// plaintext password is dropped on return (it lives only on the
    /// stack frame of this function).
    pub fn new(
        origin_url: impl Into<String>,
        action_url: impl Into<String>,
        signon_realm: impl Into<String>,
        username: impl Into<String>,
        password_plaintext: &str,
        date_created_us: i64,
    ) -> Self {
        Self {
            origin_url: origin_url.into(),
            action_url: action_url.into(),
            signon_realm: signon_realm.into(),
            username_value: username.into(),
            password_value: encrypt_chromium_v10(password_plaintext.as_bytes()),
            date_created_us,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// SQLite writer (rustguac parity C4)
// ─────────────────────────────────────────────────────────────────────

/// Errors emitted by [`populate_login_data`].
#[derive(Debug, thiserror::Error)]
pub enum PopulateError {
    /// Filesystem error preparing the `Default/` subdirectory or
    /// writing the `Preferences` JSON file.
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    /// SQLite error opening the `Login Data` file or running the
    /// schema / insert statements.
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Write Chromium's per-profile autofill state into `profile_dir`.
///
/// Side effects (rustguac parity C3 + C4):
///
/// 1. Creates `<profile_dir>/Default/` if missing.
/// 2. Writes `<profile_dir>/Default/Preferences` with
///    [`PREFERENCES_JSON`] so Chromium reads back the autofill rows
///    instead of silently ignoring them.
/// 3. Creates `<profile_dir>/Default/Login Data` as a fresh SQLite
///    database, runs [`LOGINS_TABLE_SCHEMA_SQL`] (full Chromium 134
///    schema), and inserts every supplied [`LoginsRow`] into the
///    `logins` table.
///
/// The `password_value` blob is written as-is — callers are expected
/// to have already produced the v10-prefixed AES-128-CBC ciphertext
/// via [`LoginsRow::new`] or [`encrypt_chromium_v10`].
///
/// This is **per-session destructive**: if `Login Data` already exists
/// it is truncated. The kiosk profile is ephemeral so this matches the
/// expected lifecycle.
pub fn populate_login_data(
    profile_dir: &std::path::Path,
    rows: &[LoginsRow],
) -> Result<(), PopulateError> {
    let default_dir = profile_dir.join("Default");
    std::fs::create_dir_all(&default_dir)?;

    // Preferences (C3) — must be written even when `rows` is empty so
    // that the password manager is enabled when the user lands on a
    // form page later.
    std::fs::write(default_dir.join("Preferences"), PREFERENCES_JSON)?;

    let db_path = default_dir.join("Login Data");
    // Fresh per-session file: remove any stale copy so the schema
    // batch doesn't conflict with a leftover table from a prior run.
    if db_path.exists() {
        std::fs::remove_file(&db_path)?;
    }

    let conn = rusqlite::Connection::open(&db_path)?;
    conn.execute_batch(LOGINS_TABLE_SCHEMA_SQL)?;

    if !rows.is_empty() {
        let mut stmt = conn.prepare(
            "INSERT INTO logins (\
                origin_url, action_url, username_element, username_value, \
                password_element, password_value, submit_element, signon_realm, \
                date_created, blacklisted_by_user, scheme, password_type, \
                times_used, date_last_used, date_password_modified\
             ) VALUES (?1, ?2, '', ?3, '', ?4, '', ?5, ?6, 0, 0, 0, 0, 0, ?6)",
        )?;
        for row in rows {
            stmt.execute(rusqlite::params![
                row.origin_url,
                row.action_url,
                row.username_value,
                row.password_value,
                row.signon_realm,
                row.date_created_us,
            ])?;
        }
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// PBKDF2 with the Chromium constants is deterministic — every
    /// Chromium-on-Linux profile derives the same 16 bytes. Pinning
    /// the value here turns a key-derivation regression into an
    /// immediate test failure rather than a silent "Chromium can't
    /// read our blobs anymore". The pinned value matches Chromium's
    /// production key on Linux as derived by `openssl kdf -keylen 16
    /// -kdfopt digest:SHA1 -kdfopt pass:peanuts -kdfopt
    /// salt:saltysalt -kdfopt iter:1 PBKDF2`.
    #[test]
    fn chromium_basic_key_is_pinned() {
        let key = chromium_basic_key();
        assert_eq!(
            hex::encode(key),
            "fd621fe5a2b402539dfa147ca9272778",
            "Chromium PBKDF2 derivation drift — Chromium will reject our blobs"
        );
    }

    #[test]
    fn encrypt_emits_v10_prefix() {
        let blob = encrypt_chromium_v10(b"hunter2");
        assert!(
            blob.starts_with(b"v10"),
            "expected v10 prefix, got {:?}",
            &blob[..3.min(blob.len())]
        );
    }

    #[test]
    fn encrypt_output_is_block_aligned() {
        // PKCS#7 always pads to the next 16-byte boundary, including
        // when plaintext is itself block-aligned (then a full block
        // of padding is appended).
        let blob = encrypt_chromium_v10(b"x");
        let body = &blob[CHROMIUM_V10_PREFIX.len()..];
        assert_eq!(body.len() % 16, 0, "ciphertext must be block-aligned");
        assert!(!body.is_empty());
    }

    #[test]
    fn round_trip_short_password() {
        let pw = b"hunter2";
        let blob = encrypt_chromium_v10(pw);
        let decoded = decrypt_chromium_v10(&blob).expect("decrypt");
        assert_eq!(decoded, pw);
    }

    #[test]
    fn round_trip_block_aligned_password() {
        // Exactly one AES block — guards against PKCS#7 off-by-one.
        let pw = b"0123456789abcdef";
        let blob = encrypt_chromium_v10(pw);
        let decoded = decrypt_chromium_v10(&blob).expect("decrypt");
        assert_eq!(decoded, pw);
    }

    #[test]
    fn round_trip_long_password() {
        let pw = b"this-is-a-much-longer-password-spanning-multiple-blocks-!@#$%^&*()";
        let blob = encrypt_chromium_v10(pw);
        let decoded = decrypt_chromium_v10(&blob).expect("decrypt");
        assert_eq!(decoded, pw);
    }

    #[test]
    fn round_trip_empty_password() {
        // Edge case: empty plaintext still produces a single padding
        // block. Chromium accepts this.
        let blob = encrypt_chromium_v10(b"");
        let decoded = decrypt_chromium_v10(&blob).expect("decrypt");
        assert_eq!(decoded, b"");
    }

    #[test]
    fn round_trip_unicode_password() {
        let pw = "пароль🔐مرحبا".as_bytes();
        let blob = encrypt_chromium_v10(pw);
        let decoded = decrypt_chromium_v10(&blob).expect("decrypt");
        assert_eq!(decoded, pw);
    }

    #[test]
    fn encrypt_is_deterministic() {
        // Fixed key + fixed IV = same ciphertext every call. This is
        // intentional (matches Chromium's behaviour) — and it means a
        // session that re-runs the autofill writer doesn't drift.
        let a = encrypt_chromium_v10(b"hunter2");
        let b = encrypt_chromium_v10(b"hunter2");
        assert_eq!(a, b);
    }

    #[test]
    fn decrypt_rejects_missing_prefix() {
        let blob = encrypt_chromium_v10(b"hunter2");
        let stripped = &blob[CHROMIUM_V10_PREFIX.len()..];
        assert!(decrypt_chromium_v10(stripped).is_err());
    }

    #[test]
    fn logins_row_constructor_encrypts_inline() {
        let row = LoginsRow::new(
            "https://example.com/login",
            "https://example.com/login",
            "https://example.com/",
            "alice",
            "hunter2",
            1_700_000_000_000_000,
        );
        assert_eq!(row.username_value, "alice");
        assert!(row.password_value.starts_with(b"v10"));
        let pw = decrypt_chromium_v10(&row.password_value).expect("decrypt");
        assert_eq!(pw, b"hunter2");
    }

    #[test]
    fn schema_sql_includes_full_chromium_134_set() {
        // rustguac parity C2: the schema must include every table
        // Chromium 134's PasswordStore migration touches, otherwise
        // Chromium crashes on first read of the per-session profile.
        for table in [
            "CREATE TABLE meta",
            "CREATE TABLE logins",
            "CREATE TABLE sync_entities_metadata",
            "CREATE TABLE sync_model_metadata",
            "CREATE TABLE insecure_credentials",
            "CREATE TABLE password_notes",
            "CREATE TABLE stats",
        ] {
            assert!(
                LOGINS_TABLE_SCHEMA_SQL.contains(table),
                "schema missing required table fragment: {table}"
            );
        }
        // Required `meta` rows pinning the schema version.
        assert!(LOGINS_TABLE_SCHEMA_SQL.contains("'mmap_status','-1'"));
        assert!(LOGINS_TABLE_SCHEMA_SQL.contains("'version','43'"));
        assert!(LOGINS_TABLE_SCHEMA_SQL.contains("'last_compatible_version','40'"));
        // Indexes Chromium expects.
        assert!(LOGINS_TABLE_SCHEMA_SQL.contains("CREATE INDEX logins_signon"));
        assert!(LOGINS_TABLE_SCHEMA_SQL.contains("CREATE INDEX foreign_key_index "));
        assert!(LOGINS_TABLE_SCHEMA_SQL.contains("CREATE INDEX foreign_key_index_notes"));
        assert!(LOGINS_TABLE_SCHEMA_SQL.contains("CREATE INDEX stats_origin"));
        // Critical column.
        assert!(LOGINS_TABLE_SCHEMA_SQL.contains("password_value BLOB"));
    }

    #[test]
    fn preferences_json_enables_password_manager() {
        // rustguac parity C3: without these flags Chromium ignores
        // the rows we wrote into `logins`.
        let v: serde_json::Value =
            serde_json::from_str(PREFERENCES_JSON).expect("PREFERENCES_JSON is valid JSON");
        assert_eq!(v["credentials_enable_service"], true);
        assert_eq!(v["profile"]["password_manager_enabled"], true);
        assert_eq!(v["autofill"]["enabled"], true);
    }

    #[test]
    fn populate_login_data_writes_preferences_and_empty_db() {
        // rustguac parity C4: with no rows we still write Preferences
        // and an initialised `Login Data` SQLite (the password
        // manager UI requires the `meta` rows to exist on first read).
        let dir = tempfile::tempdir().expect("tempdir");
        populate_login_data(dir.path(), &[]).expect("populate empty");

        let prefs = dir.path().join("Default").join("Preferences");
        assert!(prefs.is_file(), "Preferences not written");
        let prefs_text = std::fs::read_to_string(&prefs).expect("read prefs");
        assert!(prefs_text.contains("\"password_manager_enabled\""));

        let db = dir.path().join("Default").join("Login Data");
        assert!(db.is_file(), "Login Data not written");
        let conn = rusqlite::Connection::open(&db).expect("open db");
        let version: String = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'version'",
                [],
                |r| r.get(0),
            )
            .expect("meta.version row");
        assert_eq!(version, "43");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM logins", [], |r| r.get(0))
            .expect("count logins");
        assert_eq!(count, 0);
    }

    #[test]
    fn populate_login_data_inserts_rows_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let row = LoginsRow::new(
            "https://example.com/login",
            "https://example.com/login",
            "https://example.com/",
            "alice",
            "hunter2",
            1_700_000_000_000_000,
        );
        populate_login_data(dir.path(), std::slice::from_ref(&row)).expect("populate");

        let db = dir.path().join("Default").join("Login Data");
        let conn = rusqlite::Connection::open(&db).expect("open db");
        let (origin, username, blob): (String, String, Vec<u8>) = conn
            .query_row(
                "SELECT origin_url, username_value, password_value FROM logins LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("row");
        assert_eq!(origin, "https://example.com/login");
        assert_eq!(username, "alice");
        let decoded = decrypt_chromium_v10(&blob).expect("decrypt");
        assert_eq!(decoded, b"hunter2");
    }

    #[test]
    fn populate_login_data_truncates_existing_db() {
        // Per-session ephemeral profile: a stale Login Data file from
        // a previous run must not interfere with the new schema.
        let dir = tempfile::tempdir().expect("tempdir");
        let row = LoginsRow::new(
            "https://example.com/login",
            "https://example.com/login",
            "https://example.com/",
            "alice",
            "first",
            1,
        );
        populate_login_data(dir.path(), std::slice::from_ref(&row)).expect("first populate");

        let row2 = LoginsRow::new(
            "https://other.example.com/login",
            "https://other.example.com/login",
            "https://other.example.com/",
            "bob",
            "second",
            2,
        );
        populate_login_data(dir.path(), std::slice::from_ref(&row2)).expect("second populate");

        let db = dir.path().join("Default").join("Login Data");
        let conn = rusqlite::Connection::open(&db).expect("open db");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM logins", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1, "second populate must replace, not append");
        let username: String = conn
            .query_row("SELECT username_value FROM logins", [], |r| r.get(0))
            .expect("user");
        assert_eq!(username, "bob");
    }
}
