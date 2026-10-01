// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! The policy every native SFTP transfer passes through (SEC-10).
//!
//! The file browser moves files without going through the HTTP routes,
//! so without this gate it would bypass both controls Quick Share
//! enforces: uploads are AV scanned like inbound Quick Share, and
//! downloads are scanned and then submitted to the outbound approval
//! queue exactly as an outbound share would be.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use strata_session::engine::sftp::TransferGate;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::av::{FailMode, Scanner, Verdict};
use crate::services::outbound_shares::{self, OutboundShareStatus};

/// [`TransferGate`] for one session, applying the Quick Share policy.
pub struct PolicyGate {
    pub pool: sqlx::PgPool,
    pub vault: Option<crate::config::VaultConfig>,
    pub scanner: Arc<dyn Scanner>,
    pub fail_mode: FailMode,
    pub user_id: Uuid,
    pub connection_id: Uuid,
    pub session_id: String,
}

impl PolicyGate {
    /// Scan a staged file, auditing and refusing it when the verdict blocks.
    async fn scan(&self, staged: &Path, filename: &str, source: &str) -> Result<Verdict, String> {
        let verdict = self.scanner.scan(staged).await;
        if verdict.blocks(self.fail_mode) {
            let _ = crate::services::audit::log(
                &self.pool,
                Some(self.user_id),
                "file.av_blocked",
                &serde_json::json!({
                    "source": source,
                    "session_id": self.session_id,
                    "connection_id": self.connection_id,
                    "filename": filename,
                    "size": file_size(staged).await,
                    "av_status": verdict.as_str(),
                    "av_signature": verdict.signature(),
                    "av_message": verdict.message(),
                    "av_backend": self.scanner.backend_tag(),
                }),
            )
            .await;
            tracing::warn!(
                filename = %filename,
                source = source,
                av_status = verdict.as_str(),
                "SFTP transfer blocked by AV scan"
            );
            return Err(verdict.user_facing_block_message());
        }
        Ok(verdict)
    }
}

#[async_trait]
impl TransferGate for PolicyGate {
    async fn admit_upload(&self, staged: &Path, name: &str) -> Result<(), String> {
        let filename = leaf(name);
        let verdict = self.scan(staged, filename, "sftp_upload").await?;
        let _ = crate::services::audit::log(
            &self.pool,
            Some(self.user_id),
            "file.sftp_uploaded",
            &serde_json::json!({
                "session_id": self.session_id,
                "connection_id": self.connection_id,
                "filename": filename,
                "size": file_size(staged).await,
                "av_status": verdict.as_str(),
                "av_backend": self.scanner.backend_tag(),
            }),
        )
        .await;
        Ok(())
    }

    async fn admit_download(&self, staged: &Path, name: &str) -> Result<(), String> {
        let filename = leaf(name);
        let verdict = self.scan(staged, filename, "sftp_download").await?;
        let vault = self
            .vault
            .as_ref()
            .ok_or("downloads need Vault, which is not configured")?;
        let plaintext = tokio::fs::read(staged)
            .await
            .map_err(|_| "cannot read file".to_owned())?;
        let justification = format!("Downloaded from the session file browser: {name}");
        let submitted = crate::routes::outbound_shares::finalize_submit(
            &self.pool,
            vault,
            self.user_id,
            Some(&self.session_id),
            Some(self.connection_id),
            Some(&justification),
            filename,
            "application/octet-stream",
            &plaintext,
            &verdict,
            self.scanner.backend_tag(),
        )
        .await
        .map_err(|err| refusal(&err))?;

        if submitted.status != OutboundShareStatus::Approved.as_str() {
            return Err(format!(
                "{filename} was submitted for approval. Download it from \
                 Outbound Quick Share once it is approved."
            ));
        }
        // Auto-approved: the browser receives it now, so the one-shot
        // link must not deliver it a second time.
        outbound_shares::mark_delivered(&self.pool, submitted.id)
            .await
            .map_err(|err| refusal(&err))?;
        Ok(())
    }
}

/// The last component of a browser path, which is what the share records.
fn leaf(name: &str) -> &str {
    name.rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or(name)
}

async fn file_size(path: &Path) -> u64 {
    tokio::fs::metadata(path).await.map_or(0, |m| m.len())
}

/// What the user is told when the share could not be submitted. Validation
/// messages are written for users; anything else stays in the log.
fn refusal(err: &AppError) -> String {
    match err {
        AppError::Validation(message) => message.clone(),
        other => {
            tracing::warn!(error = %other, "SFTP download could not be submitted");
            "the download could not be submitted for approval".to_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_share_is_named_after_the_file_not_its_path() {
        assert_eq!(leaf("/home/strata/report.pdf"), "report.pdf");
        assert_eq!(leaf("report.pdf"), "report.pdf");
        assert_eq!(leaf("/home/strata/dir/"), "dir");
    }

    #[test]
    fn only_validation_errors_reach_the_user() {
        assert_eq!(
            refusal(&AppError::Validation("Empty file".into())),
            "Empty file"
        );
        assert_eq!(
            refusal(&AppError::Internal("db password wrong".into())),
            "the download could not be submitted for approval"
        );
    }
}
