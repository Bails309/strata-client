use axum::extract::{ConnectInfo, Extension, OriginalUri, Path, Query, State, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Instant;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::AuthUser;
use crate::services::{recordings, settings, tunnel_tickets, vault};
use crate::tunnel::{self, HandshakeParams, NvrContext};

/// Per-user rate limiter for WebSocket tunnel connections.
static TUNNEL_RATE_LIMIT: std::sync::LazyLock<Mutex<HashMap<Uuid, Vec<Instant>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Maximum tunnel connections per user within the window.
const MAX_TUNNEL_PER_USER: usize = 30;
/// Rate limit window in seconds.
const TUNNEL_WINDOW_SECS: u64 = 60;
/// Maximum entries in the tunnel rate limiter to prevent OOM.
const MAX_TUNNEL_RATE_ENTRIES: usize = 50_000;

/// Clamp display dimensions to safe bounds.
fn clamp_dimension(val: u32, min: u32, max: u32, default: u32) -> u32 {
    if val == 0 {
        default
    } else {
        val.clamp(min, max)
    }
}
const MIN_DIM: u32 = 64;
const MAX_WIDTH: u32 = 7680; // 8K
const MAX_HEIGHT: u32 = 4320; // 8K
const MAX_DPI: u32 = 600;

/// Credential source for the tunnel.  Each variant carries the username
/// and password available from that source.
pub struct CredentialSource {
    pub username: Option<String>,
    pub password: Option<String>,
}

/// Resolve final tunnel credentials using a priority cascade:
///   1. One-off vault credential profile (from ticket)
///   2. Permanently-mapped vault credential profile
///   3. One-time ticket credentials
///   4. Legacy query-string fallback
///   5. None
///
/// `fallback_username` is used when the chosen source has a password but no username.
pub fn resolve_credentials(
    oneoff: &CredentialSource,
    vault: &CredentialSource,
    ticket: Option<&CredentialSource>,
    query: &CredentialSource,
    fallback_username: &str,
) -> (Option<String>, Option<String>) {
    if oneoff.password.is_some() {
        (
            oneoff
                .username
                .clone()
                .or_else(|| Some(fallback_username.to_string())),
            oneoff.password.clone(),
        )
    } else if vault.password.is_some() {
        (
            vault
                .username
                .clone()
                .or_else(|| Some(fallback_username.to_string())),
            vault.password.clone(),
        )
    } else if let Some(tc) = ticket.filter(|t| t.password.is_some()) {
        (
            tc.username
                .clone()
                .or_else(|| Some(fallback_username.to_string())),
            tc.password.clone(),
        )
    } else if query.password.is_some() {
        (
            query
                .username
                .clone()
                .or_else(|| Some(fallback_username.to_string())),
            query.password.clone(),
        )
    } else {
        (None, None)
    }
}

#[derive(Deserialize, Default)]
pub struct TunnelQuery {
    pub username: Option<String>,
    pub password: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub dpi: Option<u32>,
    pub ticket: Option<String>,
}

// ── Ticket creation ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateTicketRequest {
    pub connection_id: Uuid,
    pub username: Option<String>,
    pub password: Option<String>,
    pub credential_profile_id: Option<Uuid>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub dpi: Option<u32>,
    pub ignore_cert: Option<bool>,
}

pub async fn create_tunnel_ticket(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateTicketRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        s.db.clone().ok_or(AppError::SetupRequired)?
    };

    // Users with can_manage_connections or can_manage_system bypass role-based access check
    if !user.can_access_all_connections() {
        let has_access = crate::services::connections::user_has_role_access(
            &db.pool,
            user.id,
            body.connection_id,
        )
        .await?;
        if !has_access {
            return Err(AppError::Forbidden);
        }
    } else {
        // Even privileged users may not mint tickets for connections that
        // do not exist (or have been soft-deleted). Without this check
        // an admin could trigger a tunnel WebSocket attempt against a
        // bogus UUID and get a generic 200 back, which masks client
        // bugs and leaks "exists vs not" timing on the subsequent
        // upgrade. The non-admin branch above is implicitly covered by
        // user_has_role_access (no row → no access → 403).
        let exists =
            crate::services::connections::fetch_tunnel_details(&db.pool, body.connection_id)
                .await?
                .is_some();
        if !exists {
            return Err(AppError::NotFound("connection not found".into()));
        }
    }

    let ticket = tunnel_tickets::TunnelTicket {
        user_id: user.id,
        connection_id: body.connection_id,
        username: body.username,
        password: body.password,
        credential_profile_id: body.credential_profile_id,
        width: body.width.unwrap_or(1920),
        height: body.height.unwrap_or(1080),
        dpi: body.dpi.unwrap_or(96),
        ignore_cert: body.ignore_cert.unwrap_or(false),
        created_at: std::time::Instant::now(),
    };

    let ticket_id = tunnel_tickets::create(ticket);
    Ok(Json(serde_json::json!({ "ticket": ticket_id })))
}

// CodeQL note: `rust/unused-variable` misfires here on `e` bindings that are
// interpolated into `tracing::error!("… {e}")` macros inside `async move`
// closures; see alerts #81, #74. The variables are used; suppress the lint.
#[allow(unused_variables)]
#[allow(clippy::too_many_arguments)]
pub async fn ws_tunnel(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(connection_id): Path<Uuid>,
    Query(query): Query<TunnelQuery>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    OriginalUri(original_uri): OriginalUri,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    // Capture the access token used to authenticate this upgrade so the
    // tunnel watchdog (below) can react to explicit logout / admin
    // revocation while the long-lived WebSocket is open. The middleware
    // has already validated this token; we just keep a copy of the raw
    // string so the watchdog can call `is_revoked` against it. Match the
    // same priority order as `require_auth` to stay consistent.
    //
    // NOTE: We deliberately do NOT capture and enforce the token's `exp`
    // claim here. The 20-minute access-token TTL is rotated by the
    // frontend's proactive refresh on user activity, but the WebSocket
    // upgrade was authenticated with the token that existed at connect
    // time — we have no way to learn about subsequent rotations from
    // inside this future. Enforcing the original `exp` therefore tore
    // down active sessions every 20 minutes even when the user was still
    // logged in and actively using both the web UI and the remote
    // session. The hard cap on tunnel lifetime is enforced separately
    // below via `MAX_TUNNEL_DURATION` (measured from upgrade time), and
    // the idle / manual / admin logout paths all revoke the token, which
    // the watchdog still observes.
    let watchdog_token: Option<String> = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
        .or_else(|| crate::services::middleware::extract_cookie_value(&headers, "access_token"))
        .or_else(|| {
            crate::services::middleware::extract_token_from_query(
                original_uri.query().unwrap_or_default(),
            )
        });
    // ── Per-user tunnel rate limiting ──
    {
        let mut map = TUNNEL_RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > MAX_TUNNEL_RATE_ENTRIES {
            let cutoff = Instant::now() - std::time::Duration::from_secs(TUNNEL_WINDOW_SECS);
            map.retain(|_, attempts| {
                attempts.retain(|t| *t > cutoff);
                !attempts.is_empty()
            });
            if map.len() > MAX_TUNNEL_RATE_ENTRIES {
                map.clear();
            }
        }
        let cutoff = Instant::now() - std::time::Duration::from_secs(TUNNEL_WINDOW_SECS);
        let attempts = map.entry(user.id).or_default();
        attempts.retain(|t| *t > cutoff);
        if attempts.len() >= MAX_TUNNEL_PER_USER {
            return Err(AppError::Validation(
                "Too many tunnel connections. Please try again later.".into(),
            ));
        }
        attempts.push(Instant::now());
    }

    // Read state
    let (db, config, guacd_pool) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        let db = s.db.clone().ok_or(AppError::SetupRequired)?;
        let cfg = s.config.clone().ok_or(AppError::SetupRequired)?;
        let pool = s.guacd_pool.clone();
        (db, cfg, pool)
    };

    // Verify the user has access to this connection via their role
    // Users with connection management permissions bypass role-based access check
    if !user.can_access_all_connections() {
        let has_access =
            crate::services::connections::user_has_role_access(&db.pool, user.id, connection_id)
                .await?;
        if !has_access {
            return Err(AppError::Forbidden);
        }
    }

    // Fetch connection details
    let (protocol, hostname, port, domain, connection_name, extra_json) =
        crate::services::connections::fetch_tunnel_details(&db.pool, connection_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Connection not found".into()))?;

    // Parse extra JSONB into a HashMap for guacd params
    let mut extra = crate::tunnel::json_to_string_map(&extra_json);

    // ── Safeguard JIT branch ────────────────────────────────────────
    // When the connection is mapped to a `kind='safeguard'` credential
    // profile, perform a just-in-time password checkout from the
    // OneIdentity Safeguard appliance and use the returned credential
    // for this tunnel. The request_id is captured so we can checkin
    // when the WebSocket closes (see the `on_upgrade` closure below)
    // — UNLESS the admin has enabled `password_cache_enabled`, in
    // which case the password is Vault-cached for its full lifetime
    // and auto-checkin is suppressed so the appliance keeps the
    // request open for follow-up sessions.
    let mut safeguard_state: Option<(String, String, String)> = None; // (request_id, account_id, asset)
    let mut safeguard_password: Option<String> = None;
    let mut safeguard_username: Option<String> = None;
    if let Some(vault_cfg) = &config.vault {
        if let Some((profile_id, account_id, asset, profile_ttl_hours)) =
            crate::services::credential_profiles::safeguard_target_for_connection(
                &db.pool,
                connection_id,
                user.id,
            )
            .await?
        {
            let sg_cfg = crate::services::safeguard::config::load(&db.pool).await?;

            // 1. Try the cache first when admin-enabled. A live cache
            //    row short-circuits the entire JIT flow (no Safeguard
            //    API call) — that's the whole point of this mode. But
            //    if the user (or an admin) already checked the
            //    request back in via the Safeguard portal, the
            //    cached password is dead — verify with the appliance
            //    before reusing it. Validation failures fail closed:
            //    evict the row and fall through to a fresh JIT
            //    checkout so the user still gets a working tunnel.
            let mut from_cache = false;
            if sg_cfg.password_cache_enabled {
                if let Some(cached) = crate::services::safeguard::password_cache::load(
                    &db.pool, vault_cfg, user.id, profile_id,
                )
                .await?
                {
                    let validity = match cached.request_id.as_deref() {
                        Some(rid) => match crate::services::safeguard::check_request_validity(
                            &db.pool,
                            vault_cfg,
                            rid,
                            Some(user.id),
                        )
                        .await
                        {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::warn!(
                                    "Safeguard cache validation errored for profile {} (request {}): {e} — falling back to cached password",
                                    profile_id,
                                    rid
                                );
                                crate::services::safeguard::CacheValidity::Unknown
                            }
                        },
                        // No request_id stored — can't validate, but
                        // the row is otherwise fresh. Trust it.
                        None => crate::services::safeguard::CacheValidity::Unknown,
                    };
                    let still_active = !matches!(
                        validity,
                        crate::services::safeguard::CacheValidity::Inactive
                    );
                    if still_active {
                        tracing::info!(
                            "Safeguard password cache hit for profile {} (validity={:?}): username={:?}, expires_at={}",
                            profile_id,
                            validity,
                            cached.username,
                            cached.expires_at
                        );
                        safeguard_username = cached.username;
                        safeguard_password = Some(cached.password);
                        from_cache = true;
                    } else {
                        tracing::info!(
                            "Safeguard cached password for profile {} is no longer valid on the appliance (checked-in/expired) — refreshing",
                            profile_id
                        );
                        if let Err(e) = crate::services::safeguard::password_cache::clear(
                            &db.pool, user.id, profile_id,
                        )
                        .await
                        {
                            tracing::warn!(
                                "safeguard password_cache clear failed (profile={}): {e}",
                                profile_id
                            );
                        }
                    }
                }
            }

            // 2. Cache miss (or caching disabled) → JIT checkout.
            if !from_cache {
                let reason = crate::services::safeguard::render_reason(
                    &sg_cfg.request_reason_template,
                    &connection_id.to_string(),
                    &user.username,
                );
                let jit = crate::services::safeguard::jit_checkout(
                    &db.pool,
                    vault_cfg,
                    &account_id,
                    &asset,
                    &reason,
                    Some(user.id),
                    Some(connection_id),
                    Some(profile_id),
                    Some(profile_ttl_hours.max(1) as u32),
                )
                .await?;
                let outcome = match jit {
                    crate::services::safeguard::JitOutcome::Released(o) => o,
                    crate::services::safeguard::JitOutcome::PendingApproval {
                        request_id, ..
                    } => {
                        // Approval-gated profile: the user can't
                        // connect until an approver acts. Surface a
                        // stable validation code so the frontend can
                        // render a friendly modal pointing at the
                        // bulk-checkout / Request Checkout tab where
                        // the request can be tracked + released.
                        return Err(AppError::Validation(format!(
                            "safeguard.approval_required:{request_id}"
                        )));
                    }
                };
                tracing::info!(
                    "Safeguard JIT checkout succeeded: request_id={}, account_id={}, username={:?}",
                    outcome.request_id,
                    account_id,
                    outcome.username
                );

                if sg_cfg.password_cache_enabled {
                    // Cache the freshly-issued password for the
                    // profile's own lifetime (matches the Safeguard
                    // RequestedDurationHours we just sent). Skip
                    // auto-checkin so Safeguard keeps the request
                    // live for the same window. Best-effort: cache
                    // write failure must not break the user's
                    // connection.
                    let ttl_hours = profile_ttl_hours.max(1) as i64;
                    let expires_at = chrono::Utc::now() + chrono::Duration::hours(ttl_hours);
                    if let Err(e) = crate::services::safeguard::password_cache::store(
                        &db.pool,
                        vault_cfg,
                        user.id,
                        profile_id,
                        outcome.username.as_deref(),
                        &outcome.password,
                        Some(&outcome.request_id),
                        expires_at,
                    )
                    .await
                    {
                        tracing::warn!(
                            "safeguard password_cache store failed (profile={}): {e}",
                            profile_id
                        );
                    }
                } else {
                    // Classic JIT: remember the request so the close
                    // handler can call /CheckIn.
                    safeguard_state = Some((outcome.request_id, account_id.clone(), asset.clone()));
                }

                safeguard_username = outcome.username;
                safeguard_password = Some(outcome.password);
            }
        }
    }

    // Attempt to load and decrypt user credentials from credential profiles.
    // If the profile is linked to an active checkout, the managed credential's
    // username (sAMAccountName) and password fully replace the user's own profile
    // credentials — the user expects to connect AS the managed account.
    let (vault_username, vault_password) = if safeguard_password.is_some() {
        // Safeguard JIT path: password from CheckoutPassword + username
        // synthesised from the AccessRequest's AccountName/DomainName
        // (e.g. `CAPITA\sa1`). Falling back to None means the protocol
        // prompts in-band, which is what we did before — but for RDP
        // that surfaces as "invalid credentials" the moment the target
        // rejects the empty NLA username. Always prefer the resolved
        // name when the appliance gave us one.
        (safeguard_username.clone(), safeguard_password.clone())
    } else if let Some(vault_cfg) = &config.vault {
        // Check if the profile is linked to an active checkout with a managed credential
        let managed_cred = crate::services::user_credentials::load_mapping_managed(
            &db.pool,
            connection_id,
            user.id,
        )
        .await?;

        if let Some((enc_payload, enc_dek, nonce)) = managed_cred {
            // Managed checkout active — use its username and password directly
            let plaintext = vault::unseal(vault_cfg, &enc_dek, &enc_payload, &nonce).await?;
            let plain_str = String::from_utf8(plaintext).unwrap_or_default();
            let parsed: serde_json::Value = serde_json::from_str(&plain_str)
                .unwrap_or_else(|_| serde_json::json!({ "u": "", "p": plain_str }));
            let managed_user = parsed["u"].as_str().unwrap_or("").to_string();
            let managed_pass = parsed["p"].as_str().unwrap_or("").to_string();
            tracing::info!(
                "Tunnel using managed checkout credentials for connection {}, managed username={:?}",
                connection_id, managed_user
            );
            (
                if managed_user.is_empty() {
                    None
                } else {
                    Some(managed_user)
                },
                if managed_pass.is_empty() {
                    None
                } else {
                    Some(managed_pass)
                },
            )
        } else {
            // No active checkout — fall back to the user's own profile credentials
            let own_cred = crate::services::user_credentials::load_mapping_own(
                &db.pool,
                connection_id,
                user.id,
            )
            .await?;

            if let Some((enc_payload, enc_dek, nonce)) = own_cred {
                let plaintext = vault::unseal(vault_cfg, &enc_dek, &enc_payload, &nonce).await?;
                let plain_str = String::from_utf8(plaintext).unwrap_or_default();
                let parsed: serde_json::Value = serde_json::from_str(&plain_str)
                    .unwrap_or_else(|_| serde_json::json!({ "u": "", "p": plain_str }));
                let u = parsed["u"].as_str().unwrap_or("").to_string();
                let p = parsed["p"].as_str().unwrap_or("").to_string();
                (
                    if u.is_empty() { None } else { Some(u) },
                    if p.is_empty() { None } else { Some(p) },
                )
            } else {
                (None, None)
            }
        }
    } else {
        (None, None)
    };

    // Check recording config
    let rec_config = recordings::get_config(&db.pool).await?;
    let recording_path = if rec_config.enabled {
        Some("/var/lib/guacamole/recordings".to_string())
    } else {
        None
    };

    let guacd_host: String;
    let guacd_port: u16;
    if let Some(ref pool) = guacd_pool {
        let (h, p) = pool.next();
        guacd_host = h.to_string();
        guacd_port = p;
    } else {
        guacd_host = config.guacd_host.clone().unwrap_or_else(|| "guacd".into());
        guacd_port = config.guacd_port.unwrap_or(4822);
    };

    // ── Resolve credentials ──────────────────────────────────────────

    // Priority: Vault profile > ticket > query-string fallback
    // Consume the one-time ticket (if provided) to extract credentials
    let ticket_creds = query.ticket.as_deref().and_then(tunnel_tickets::consume);

    // Verify the ticket belongs to the authenticated user (prevent cross-user credential leakage)
    if let Some(ref tc) = ticket_creds {
        if tc.user_id != user.id {
            return Err(AppError::Auth(
                "Tunnel ticket does not belong to the authenticated user".into(),
            ));
        }
    }

    // If the ticket carries a one-off credential_profile_id, decrypt those
    // vault credentials directly (no permanent mapping required).
    // Same checkout-aware logic: prefer the managed profile's password but keep the profile's username.
    let oneoff_profile_id = ticket_creds.as_ref().and_then(|t| t.credential_profile_id);
    let (oneoff_username, oneoff_password) = if let (Some(profile_id), Some(vault_cfg)) =
        (oneoff_profile_id, &config.vault)
    {
        // Load the profile's own credentials
        let own_cred =
            crate::services::user_credentials::load_profile_own(&db.pool, profile_id, user.id)
                .await?;

        // Check for managed checkout credential
        let managed_cred =
            crate::services::user_credentials::load_profile_managed(&db.pool, profile_id, user.id)
                .await?;

        if let Some((enc_payload, enc_dek, nonce)) = managed_cred {
            // Managed checkout active — use its username and password directly
            let plaintext = vault::unseal(vault_cfg, &enc_dek, &enc_payload, &nonce).await?;
            let plain_str = String::from_utf8(plaintext).unwrap_or_default();
            let parsed: serde_json::Value = serde_json::from_str(&plain_str)
                .unwrap_or_else(|_| serde_json::json!({ "u": "", "p": plain_str }));
            let managed_user = parsed["u"].as_str().unwrap_or("").to_string();
            let managed_pass = parsed["p"].as_str().unwrap_or("").to_string();
            tracing::info!(
                "Tunnel (one-off) using managed checkout credentials, managed username={:?}",
                managed_user
            );
            (
                if managed_user.is_empty() {
                    None
                } else {
                    Some(managed_user)
                },
                if managed_pass.is_empty() {
                    None
                } else {
                    Some(managed_pass)
                },
            )
        } else if let Some((enc_payload, enc_dek, nonce)) = own_cred {
            // No active checkout — fall back to the profile's own credentials
            let plaintext = vault::unseal(vault_cfg, &enc_dek, &enc_payload, &nonce).await?;
            let plain_str = String::from_utf8(plaintext).unwrap_or_default();
            let parsed: serde_json::Value = serde_json::from_str(&plain_str)
                .unwrap_or_else(|_| serde_json::json!({ "u": "", "p": plain_str }));
            let u = parsed["u"].as_str().unwrap_or("").to_string();
            let p = parsed["p"].as_str().unwrap_or("").to_string();
            (
                if u.is_empty() { None } else { Some(u) },
                if p.is_empty() { None } else { Some(p) },
            )
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };
    // If ticket provided dimensions, use them
    let effective_width = clamp_dimension(
        ticket_creds
            .as_ref()
            .map(|t| t.width)
            .or(query.width)
            .unwrap_or(1920),
        MIN_DIM,
        MAX_WIDTH,
        1920,
    );
    let effective_height = clamp_dimension(
        ticket_creds
            .as_ref()
            .map(|t| t.height)
            .or(query.height)
            .unwrap_or(1080),
        MIN_DIM,
        MAX_HEIGHT,
        1080,
    );
    let effective_dpi = clamp_dimension(
        ticket_creds
            .as_ref()
            .map(|t| t.dpi)
            .or(query.dpi)
            .unwrap_or(96),
        MIN_DIM,
        MAX_DPI,
        96,
    );

    let (final_username, final_password) = resolve_credentials(
        &CredentialSource {
            username: oneoff_username,
            password: oneoff_password,
        },
        &CredentialSource {
            username: vault_username,
            password: vault_password,
        },
        ticket_creds
            .as_ref()
            .map(|tc| CredentialSource {
                username: tc.username.clone(),
                password: tc.password.clone(),
            })
            .as_ref(),
        &CredentialSource {
            username: query.username.clone(),
            password: query.password.clone(),
        },
        &user.username,
    );

    // ── Block expired managed credentials ────────────────────────────
    // If the user has a mapped credential profile linked to a checkout
    // (managed account) but that profile is expired, do NOT send stale
    // credentials to AD — that would trigger an auth-failure and could
    // cause account lockout.  Only block when no other credential source
    // (ticket, query-string) provided a password.
    if final_password.is_none() {
        let has_expired_managed = crate::services::user_credentials::has_expired_mapped_managed(
            &db.pool,
            connection_id,
            user.id,
        )
        .await
        .unwrap_or(false);

        if has_expired_managed {
            return Err(AppError::Validation(
                "Managed credential profile has expired. Please request a new checkout before connecting.".into(),
            ));
        }
    }

    let has_creds = final_password.is_some();

    let debug_msg = format!(
        "Tunnel creds: username={:?}, has_password={}, domain={:?}, protocol={}",
        &final_username, has_creds, &domain, &protocol
    );
    tracing::debug!(msg = debug_msg);

    // ── VDI: auto-provision ephemeral credentials ──
    // VDI containers are Strata-controlled on both sides of the auth
    // chain (the entrypoint materialises the local Linux account from
    // `VDI_USERNAME`/`VDI_PASSWORD`, guacd authenticates against xrdp
    // with the same pair). There's nothing for the operator to "log
    // in to", so prompting them for credentials is meaningless UX —
    // generate a fresh per-session pair instead. The username is
    // derived from the Strata user's name so `whoami` inside the
    // desktop matches the operator they already authenticated as.
    let (final_username, final_password) = if protocol == "vdi" && final_password.is_none() {
        let (u, p) = crate::services::vdi::ephemeral_credentials(&user.username);
        tracing::debug!(
            msg = "Auto-provisioned ephemeral VDI credentials",
            vdi_username = %u,
        );
        (Some(u), Some(p))
    } else {
        (final_username, final_password)
    };

    // Use per-connection security/ignore-cert from extra, with fallback defaults.
    // The one-time ticket can override the 'ignore-cert' database setting.
    let security = extra.get("security").cloned().or(Some("any".into()));
    let ignore_cert = ticket_creds
        .as_ref()
        .map(|t| t.ignore_cert)
        .unwrap_or_else(|| {
            extra
                .get("ignore-cert")
                .map(|v| v == "true")
                .unwrap_or(false)
        });

    // VDI: xrdp inside the spawned container uses a per-container
    // self-signed certificate that Strata never trusts. Because both
    // ends of the RDP hop are Strata-controlled and the traffic stays
    // on the internal `guac-internal` bridge, force `ignore-cert=true`
    // and let xrdp negotiate `security=any` regardless of what the
    // connection row says.
    let (security, ignore_cert) = if protocol == "vdi" {
        (Some("any".into()), true)
    } else {
        (security, ignore_cert)
    };

    // VDI: xrdp's display-update virtual channel is unreliable in the
    // sample image — a sidebar toggle or window resize on the
    // operator's browser routinely drops the RDP session. Until we
    // ship an xrdp build with a stable display-update implementation,
    // pin VDI to a fixed framebuffer (the frontend display layer
    // continues to scale to fit the viewport client-side, so the
    // experience is "letterbox/scale" rather than "disconnect").
    if protocol == "vdi" {
        extra.insert("resize-method".into(), String::new());
    }

    let safe_port: u16 = port
        .try_into()
        .map_err(|_| AppError::Validation("Invalid port number".into()))?;

    // ── rustguac parity Phase 2/3: protocol translation ──
    // `web`  → `vnc` (Xvnc + Chromium kiosk on the spawned web display)
    // `vdi`  → `rdp` (xrdp inside the spawned container)
    // The original (`web`/`vdi`) is preserved on `nvr_protocol` below so
    // recordings keep the operator-facing label. The wire-level protocol
    // is what guacd negotiates against.
    let wire_protocol = match protocol.as_str() {
        "web" => "vnc".to_string(),
        "vdi" => "rdp".to_string(),
        _ => protocol.clone(),
    };

    // ── Kubernetes: vault password slot carries the PEM-encoded client
    // private key. guacd's `kubernetes` protocol has no password arg —
    // it uses `client-cert` + `client-key` for SSL client auth — so we
    // move the resolved secret into `extra["client-key"]` and clear the
    // password so it isn't forwarded as a stray protocol arg. The
    // public `client-cert` and `ca-cert` already flow through `extra`
    // via the connection editor (both are PEM-encoded X.509 certs and
    // are public material; only the private key needs Vault Transit
    // envelope encryption). See `tunnel.rs::is_allowed_guacd_param`.
    let (final_username, final_password) = if wire_protocol == "kubernetes" {
        if let Some(key_pem) = final_password {
            extra.insert("client-key".into(), key_pem);
        }
        // Username is meaningless for the kubernetes protocol; drop it
        // so guacd doesn't see a phantom arg.
        (None, None)
    } else {
        (final_username, final_password)
    };

    // ── rustguac parity Phase 3: ensure VDI container is running ──
    // For `vdi` connections, ask the driver to spawn (or reuse) the
    // per-(connection,user) container. We override hostname/port with
    // the driver-returned endpoint so guacd connects to the spawned
    // container instead of the operator-typed hostname (which on the
    // `vdi` profile is intentionally a no-op placeholder).
    //
    // When the driver is the `NoopVdiDriver` (i.e. `STRATA_VDI_ENABLED`
    // is unset), `ensure_container` returns `DriverUnavailable` and we
    // surface it as a 503 — the connection editor was able to save the
    // row but this replica isn't configured to spawn it.
    let (final_hostname, final_safe_port) = if protocol == "vdi" {
        let cfg = crate::services::vdi::VdiConfig::from_extra(&extra_json);
        let image = cfg.image.clone().unwrap_or_default();
        if image.is_empty() {
            return Err(AppError::Validation(
                "VDI connection is missing the 'image' extra field".into(),
            ));
        }
        let home_base_raw =
            crate::services::settings::get(&db.pool, crate::services::vdi::SETTING_VDI_HOME_BASE)
                .await?
                .unwrap_or_else(|| "/var/lib/strata/vdi-home".to_owned());
        let spec = crate::services::vdi::VdiSpawnSpec {
            image: image.clone(),
            username: final_username.clone().unwrap_or_default(),
            password: final_password.clone().unwrap_or_default(),
            env: cfg.env_vars.clone(),
            cpu_limit: cfg.cpu_limit,
            memory_limit_mb: cfg.memory_limit_mb,
            persistent_home: cfg.persistent_home,
            home_base: std::path::PathBuf::from(home_base_raw),
        };
        let driver = {
            let s = state.read().await;
            s.vdi_driver.clone()
        };
        let endpoint = driver
            .ensure_container(connection_id, user.id, &spec)
            .await
            .map_err(|e| match e {
                crate::services::vdi::VdiError::DriverUnavailable(m) => {
                    AppError::Internal(format!("vdi driver unavailable: {m}"))
                }
                crate::services::vdi::VdiError::ImageNotAllowed(img) => {
                    AppError::Validation(format!("vdi image not allowed: {img}"))
                }
                other => AppError::Internal(format!("vdi ensure_container failed: {other}")),
            })?;
        // Upsert the bookkeeping row so the reaper can see it.
        let _ = sqlx::query(
            r#"
            INSERT INTO vdi_containers
                (connection_id, user_id, container_name, image, state, last_seen_at)
            VALUES ($1, $2, $3, $4, 'running', now())
            ON CONFLICT (connection_id, user_id) DO UPDATE
                SET container_name = EXCLUDED.container_name,
                    image          = EXCLUDED.image,
                    state          = 'running',
                    last_seen_at   = now()
            "#,
        )
        .bind(connection_id)
        .bind(user.id)
        .bind(&endpoint.container_name)
        .bind(&image)
        .execute(&db.pool)
        .await;
        let _ = crate::services::audit::log(
            &db.pool,
            Some(user.id),
            crate::services::vdi::AUDIT_VDI_CONTAINER_ENSURE,
            &serde_json::json!({
                "connection_id": connection_id.to_string(),
                "container_name": endpoint.container_name,
                "image": image,
            }),
        )
        .await;
        (endpoint.host, endpoint.port)
    } else if protocol == "web" {
        // ── rustguac parity Phase 2: ensure web kiosk is running ──
        // Spawn pipeline (or reuse existing): allocates display + CDP
        // port, writes Login Data autofill (C3 + C4), spawns Xvnc
        // (B9), waits for the listener (B10), spawns Chromium (B2–B6),
        // detects immediate crashes (B11), runs the configured login
        // script if any (D1–D4), registers the handle. The returned
        // endpoint is `127.0.0.1:{5900+display}`, which we hand to
        // guacd in place of the operator-typed hostname/port (which
        // for `web` is a no-op placeholder, same as for `vdi`).
        let cfg = match crate::services::web_session::WebSessionConfig::from_extra(&extra_json) {
            Some(c) => c,
            None => {
                return Err(AppError::Validation(
                    "Web connection is missing or has empty 'url' extra field".into(),
                ));
            }
        };

        // Resolve operator-overridable settings with sensible defaults.
        // The defaults match Debian's package layout (`Xvnc` and
        // `chromium` on $PATH); operators on the Alpine image, NixOS,
        // or a custom path override via system_settings.
        let xvnc_path_str = crate::services::settings::get(
            &db.pool,
            crate::services::web_session::SETTING_WEB_XVNC_PATH,
        )
        .await?
        .unwrap_or_else(|| "Xvnc".to_owned());
        let chromium_path_str = crate::services::settings::get(
            &db.pool,
            crate::services::web_session::SETTING_WEB_CHROMIUM_PATH,
        )
        .await?
        .unwrap_or_else(|| "chromium".to_owned());
        let scripts_dir_str = crate::services::settings::get(
            &db.pool,
            crate::services::web_runtime::SETTING_WEB_LOGIN_SCRIPTS_DIR,
        )
        .await?
        .unwrap_or_else(|| "/var/lib/strata/web-login-scripts".to_owned());

        // Optional credentials: only feed them to autofill if the
        // operator chose username/password auth. Empty username is
        // treated as "no autofill" so passwordless connections don't
        // write a meaningless Login Data row.
        let credentials = match (&final_username, &final_password) {
            (Some(u), Some(p)) if !u.is_empty() => {
                Some(crate::services::web_runtime::WebCredentials {
                    username: u.clone(),
                    password: p.clone(),
                })
            }
            _ => None,
        };

        // Resolve the trusted-CA bundle (if attached) into the PEM
        // the runtime will hand to certutil. Doing this lookup here
        // keeps `web_runtime` sqlx-free.
        let (trusted_ca_pem, trusted_ca_label) = match cfg.trusted_ca_id {
            Some(id) => {
                let pem = crate::services::trusted_ca::get(&db.pool, id)
                    .await?
                    .map(|d| d.pem);
                (pem, Some(id.to_string()))
            }
            None => (None, None),
        };

        let spec = crate::services::web_runtime::WebSpawnSpec {
            config: cfg,
            credentials,
            xvnc_binary: std::path::PathBuf::from(xvnc_path_str),
            chromium_binary: std::path::PathBuf::from(chromium_path_str),
            login_scripts_dir: std::path::PathBuf::from(scripts_dir_str),
            // Match the framebuffer to the operator's actual browser
            // tab so the kiosk fills it edge-to-edge with no black
            // bars. Saturating cast: u32 → u16 is safe because the
            // tunnel route already clamped these to MAX_WIDTH/HEIGHT
            // (8K), and once Xvnc is running we never resize it.
            width: u16::try_from(effective_width).unwrap_or(u16::MAX),
            height: u16::try_from(effective_height).unwrap_or(u16::MAX),
            // Default Strata compose stack runs the backend as root
            // (uid 0), matching rustguac's reference deployment. When
            // operators harden by running unprivileged, they MUST
            // expose chromium-sandbox SUID-root in the image; once
            // that's in place this can be flipped to `false`.
            running_as_root: true,
            trusted_ca_pem,
            trusted_ca_label,
        };

        let runtime = {
            let s = state.read().await;
            s.web_runtime.clone()
        };

        // The session_id we hand to the login-script runner is the
        // connection_id stringified — login scripts log against this
        // and ops correlates it to the audit `web.session.start`
        // event below.
        let session_id = connection_id.to_string();

        let handle = runtime
            .ensure(connection_id, user.id, &session_id, spec)
            .await
            .map_err(|e| {
                use crate::services::web_runtime::WebRuntimeError as WE;
                match e {
                    WE::DisplayExhausted | WE::CdpPortExhausted => {
                        AppError::Internal(format!("web session capacity exhausted: {e}"))
                    }
                    WE::XvncNotReady(_) | WE::XvncSpawn(_) => {
                        AppError::Internal(format!("xvnc spawn failed: {e}"))
                    }
                    WE::ChromiumSpawn(_) | WE::ChromiumImmediateExit(_) => {
                        AppError::Internal(format!("chromium spawn failed: {e}"))
                    }
                    WE::LoginScript(_) => AppError::Internal(format!("login script failed: {e}")),
                    WE::Profile(_) | WE::Autofill(_) => {
                        AppError::Internal(format!("web profile prep failed: {e}"))
                    }
                    WE::TrustedCaImport(_) => {
                        AppError::Internal(format!("trusted CA import failed: {e}"))
                    }
                }
            })?;

        let _ = crate::services::audit::log(
            &db.pool,
            Some(user.id),
            crate::services::web_session::AUDIT_WEB_SESSION_START,
            &serde_json::json!({
                "connection_id": connection_id.to_string(),
                "display": handle.display,
                "cdp_port": handle.cdp_port,
            }),
        )
        .await;

        (handle.endpoint.host.to_string(), handle.endpoint.port)
    } else {
        (hostname, safe_port)
    };

    let mut recording_name = recording_path.as_ref().map(|_| {
        format!(
            "{}-{}.guac",
            connection_id,
            chrono::Utc::now().timestamp_millis()
        )
    });

    // Audit log the tunnel connection
    let user_id = user.id;
    crate::services::audit::log(
        &db.pool,
        Some(user_id),
        "tunnel.connected",
        &serde_json::json!({ "connection_id": connection_id.to_string() }),
    )
    .await?;

    // Update per-user last_accessed timestamp
    crate::services::connections::touch_user_access(&db.pool, user_id, connection_id).await?;

    // Resolve the originating client IP. Preference order:
    //   1. Trusted-edge-signed `x-strata-edge-client-ip` (DMZ deployments).
    //      Verified via HMAC by the edge_header middleware and surfaced
    //      through a task-local; this is the only attribution we can
    //      trust end-to-end when a DMZ node fronts the backend.
    //   2. Shared XFF / X-Real-IP helper (`try_extract_client_ip`),
    //      gated by `STRATA_TRUST_XFF` + `STRATA_TRUSTED_PROXIES`.
    //   3. ConnectInfo peer address — which for DMZ-originated traffic
    //      is the docker bridge / loopback (127.0.0.1) and is therefore
    //      the wrong value to surface to admins.
    let edge_ip = crate::services::edge_header::current_edge_context().map(|c| c.client_ip);
    let resolved = edge_ip
        .clone()
        .or_else(|| crate::routes::auth::try_extract_client_ip(&headers))
        .unwrap_or_else(|| addr.ip().to_string());
    tracing::debug!(
        x_forwarded_for = ?headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()),
        x_real_ip = ?headers.get("x-real-ip").and_then(|v| v.to_str().ok()),
        edge_client_ip = ?edge_ip,
        peer = %addr.ip(),
        resolved_client_ip = %resolved,
        "resolved client IP for tunnel"
    );
    let client_ip = resolved;

    // Build NVR context for session recording into the in-memory ring buffer
    let (session_registry, file_store) = {
        let s = state.read().await;
        (s.session_registry.clone(), s.file_store.clone())
    };
    let nvr_session_id = format!(
        "{}-{}",
        connection_id,
        chrono::Utc::now().timestamp_millis()
    );
    let nvr_connection_name = connection_name.clone();
    // Preserve the operator-facing label (`web` / `vdi`) on recording
    // metadata even though the wire protocol on `handshake.protocol` is
    // already translated to `vnc` / `rdp`.
    let nvr_protocol = protocol.clone();
    let nvr_user_id = user_id;
    let nvr_username = user.username.clone();
    let started_at = chrono::Utc::now();

    // Log the start of the recording if enabled.
    //
    // This used to be `tokio::spawn`-and-forget. That race-loses on short
    // sessions: the finalize UPDATE in tunnel.rs runs against `session_id`,
    // and if the INSERT hasn't reached the DB yet the UPDATE matches 0
    // rows and the recording's duration_secs stays NULL forever. It also
    // hides INSERT failures (FK violation, pool exhaustion) entirely — we
    // would happily record bytes to disk for a session with no DB row,
    // producing an orphaned file the cleanup task never sees. Await it
    // here, *before* the handshake is built, so that on INSERT failure we
    // can clear `recording_name` and the handshake never asks guacd to
    // open a recording file we can't finalize.
    if let Some(ref rn) = recording_name {
        if let Err(e) = recordings::insert_start(
            &db.pool,
            nvr_session_id.clone(),
            connection_id,
            connection_name.clone(),
            user_id,
            user.username.clone(),
            rn.clone(),
            started_at,
            Some(client_ip.clone()),
        )
        .await
        {
            tracing::error!(
                "Failed to insert recording row for session '{}': {e} — \
                 aborting recording for this session to avoid orphaned files",
                nvr_session_id
            );
            // Disable recording for this session. The session itself
            // proceeds unrecorded — better than silently losing audit data
            // by writing a recording file that has no DB row to point at.
            recording_name = None;
        }
    }

    let handshake = HandshakeParams {
        protocol: wire_protocol,
        hostname: final_hostname,
        port: final_safe_port,
        username: final_username,
        password: final_password,
        domain,
        security,
        ignore_cert,
        recording_path,
        recording_name: recording_name.clone(),
        create_recording_path: true,
        width: effective_width,
        height: effective_height,
        dpi: effective_dpi,
        extra,
    };

    // Fetch timezone for the Guacamole handshake
    let display_timezone = settings::get(&db.pool, "display_timezone")
        .await?
        .unwrap_or_else(|| "UTC".to_string());

    let audit_pool = db.pool.clone();
    // Capture for the web-kiosk eviction after the WebSocket closes.
    // When the user closes their browser tab the upgraded WebSocket
    // half-closes; without explicit eviction the kiosk handle stays
    // in `WebRuntimeRegistry`, holding the Chromium + Xvnc children
    // alive. The next `ensure()` would then return that stale handle
    // and the user sees the abandoned tab in whatever state it was
    // left in (often a closed/blank window). Evicting on disconnect
    // drops the Arc → kills both children → removes the profile dir,
    // so the *next* reopen spawns a fresh kiosk.
    let web_runtime = if protocol == "web" {
        Some(state.read().await.web_runtime.clone())
    } else {
        None
    };
    let web_user_id = user_id;
    // Capture Safeguard checkout state for auto-checkin on disconnect.
    // The vault config is needed at checkin time to unseal A2A secrets;
    // we clone it into the closure to keep `state` ownership clean.
    let safeguard_close = safeguard_state.clone();
    let safeguard_vault_cfg = config.vault.clone();
    let safeguard_auto_checkin = if safeguard_close.is_some() {
        crate::services::safeguard::config::load(&db.pool)
            .await
            .map(|c| c.auto_checkin_on_session_end)
            .unwrap_or(false)
    } else {
        false
    };
    Ok(ws
        .protocols(["guacamole"])
        .max_message_size(1024 * 1024)
        .on_upgrade(move |socket| async move {
            let nvr = NvrContext {
                registry: session_registry,
                session_id: nvr_session_id,
                connection_id,
                connection_name: nvr_connection_name,
                protocol: nvr_protocol,
                user_id: nvr_user_id,
                username: nvr_username,
                client_ip,
                started_at,
                db_pool: audit_pool.clone(),
                file_store,
            };
            // ── Auth watchdog ─────────────────────────────────────
            // Defence-in-depth: even if the frontend never tells us the
            // user logged out (browser killed, network died, hostile
            // client), close the tunnel as soon as the access token is
            // explicitly revoked OR a hard maximum tunnel lifetime is
            // reached. Without this the session_registry entry — and the
            // recording write — would continue indefinitely.
            //
            // Revocation covers: manual logout, idle-timeout logout
            // (frontend calls /auth/logout which revokes both access &
            let proxy_result = tunnel::proxy(
                socket,
                &guacd_host,
                guacd_port,
                handshake,
                Some(nvr),
                display_timezone,
                watchdog_token.clone(),
                user_id,
            )
            .await;

            if let Err(e) = proxy_result {
                let err_str = e.to_string();
                tracing::error!("Tunnel error: {}", err_str);
                // Audit log the tunnel failure
                let _ = crate::services::audit::log(
                    &audit_pool,
                    Some(user_id),
                    "tunnel.failed",
                    &serde_json::json!({
                        "connection_id": connection_id.to_string(),
                        "error": e.to_string()
                    }),
                )
                .await;
            }

            // Web kiosk teardown on disconnect. Runs whether the
            // tunnel proxy returned Ok or Err — both mean the
            // browser-side WebSocket is gone and there's no point
            // keeping Chromium + Xvnc burning a display slot. The
            // `evict` call drops the registry's `Arc` reference; if
            // no other tab is currently holding the same handle the
            // refcount hits zero, `WebSessionHandle::Drop` runs, and
            // the children are SIGKILL'd via `kill_on_drop(true)` and
            // the profile tempdir is removed. Eviction is also a
            // no-op when the entry was already removed (e.g. by an
            // admin force-close), so it's safe to always call.
            if let Some(rt) = web_runtime {
                let _ = rt.evict(connection_id, web_user_id).await;
                let _ = crate::services::audit::log(
                    &audit_pool,
                    Some(web_user_id),
                    crate::services::web_session::AUDIT_WEB_SESSION_END,
                    &serde_json::json!({
                        "connection_id": connection_id.to_string(),
                        "reason": "tunnel_disconnect",
                    }),
                )
                .await;
            }

            // ── Safeguard JIT auto-checkin ─────────────────────────
            // When the operator has enabled `auto_checkin_on_session_end`
            // (default true) and this tunnel was opened with a JIT
            // checkout, release the access request now. Failures are
            // logged but never propagated — the browser side is already
            // gone and there's nothing to surface them to. Safeguard's
            // policy-driven max-lease window is the safety net if this
            // call ever silently drops.
            if let (Some((request_id, account_id, asset)), Some(vault_cfg)) =
                (safeguard_close, safeguard_vault_cfg)
            {
                if safeguard_auto_checkin {
                    if let Err(e) = crate::services::safeguard::jit_checkin(
                        &audit_pool,
                        &vault_cfg,
                        &request_id,
                        &account_id,
                        &asset,
                        Some(user_id),
                        Some(connection_id),
                    )
                    .await
                    {
                        // Bind to a String before the macro so CodeQL's
                        // rust/unused-variable query (which can't see
                        // through tracing's macro expansion) doesn't
                        // mis-flag `e` as unused. Same pattern as #142.
                        let err_str = e.to_string();
                        tracing::warn!(
                            "Safeguard auto-checkin failed for request_id={request_id}: {err_str}"
                        );
                    } else {
                        tracing::info!(
                            "Safeguard auto-checkin succeeded for request_id={request_id}"
                        );
                    }
                }
            }
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── clamp_dimension ────────────────────────────────────────────
    #[test]
    fn clamp_dimension_zero_returns_default() {
        assert_eq!(clamp_dimension(0, MIN_DIM, MAX_WIDTH, 1920), 1920);
    }

    #[test]
    fn clamp_dimension_below_min() {
        assert_eq!(clamp_dimension(10, MIN_DIM, MAX_WIDTH, 1920), MIN_DIM);
    }

    #[test]
    fn clamp_dimension_above_max() {
        assert_eq!(clamp_dimension(10000, MIN_DIM, MAX_WIDTH, 1920), MAX_WIDTH);
    }

    #[test]
    fn clamp_dimension_normal_passthrough() {
        assert_eq!(clamp_dimension(1024, MIN_DIM, MAX_WIDTH, 1920), 1024);
    }

    #[test]
    fn clamp_dimension_exactly_min() {
        assert_eq!(clamp_dimension(MIN_DIM, MIN_DIM, MAX_WIDTH, 1920), MIN_DIM);
    }

    #[test]
    fn clamp_dimension_exactly_max() {
        assert_eq!(
            clamp_dimension(MAX_WIDTH, MIN_DIM, MAX_WIDTH, 1920),
            MAX_WIDTH
        );
    }

    #[test]
    fn clamp_dpi_values() {
        assert_eq!(clamp_dimension(0, MIN_DIM, MAX_DPI, 96), 96);
        assert_eq!(clamp_dimension(700, MIN_DIM, MAX_DPI, 96), MAX_DPI);
        assert_eq!(clamp_dimension(144, MIN_DIM, MAX_DPI, 96), 144);
    }

    // ── TunnelQuery deserialization ────────────────────────────────
    #[test]
    fn tunnel_query_defaults() {
        let q: TunnelQuery = serde_json::from_str("{}").unwrap();
        assert!(q.username.is_none());
        assert!(q.password.is_none());
        assert!(q.width.is_none());
        assert!(q.height.is_none());
        assert!(q.dpi.is_none());
        assert!(q.ticket.is_none());
    }

    #[test]
    fn tunnel_query_with_values() {
        let q: TunnelQuery = serde_json::from_str(
            r#"{"username":"admin","password":"pw","width":1920,"height":1080,"dpi":96,"ticket":"abc"}"#,
        )
        .unwrap();
        assert_eq!(q.username.unwrap(), "admin");
        assert_eq!(q.password.unwrap(), "pw");
        assert_eq!(q.width.unwrap(), 1920);
    }

    // ── CreateTicketRequest deserialization ─────────────────────────
    #[test]
    fn create_ticket_request_minimal() {
        let json = r#"{"connection_id":"550e8400-e29b-41d4-a716-446655440000"}"#;
        let r: CreateTicketRequest = serde_json::from_str(json).unwrap();
        assert_eq!(
            r.connection_id.to_string(),
            "550e8400-e29b-41d4-a716-446655440000"
        );
        assert!(r.username.is_none());
        assert!(r.width.is_none());
    }

    // ── Dimension constants make sense ─────────────────────────────
    #[test]
    fn dimension_constants_valid() {
        const { assert!(MIN_DIM < MAX_WIDTH) };
        const { assert!(MIN_DIM < MAX_HEIGHT) };
        const { assert!(MIN_DIM < MAX_DPI) };
        const { assert!(MAX_WIDTH >= 3840) }; // at least 4K
        const { assert!(MAX_HEIGHT >= 2160) }; // at least 4K
    }

    #[test]
    fn clamp_dimension_height_variants() {
        assert_eq!(clamp_dimension(0, MIN_DIM, MAX_HEIGHT, 1080), 1080);
        assert_eq!(clamp_dimension(30, MIN_DIM, MAX_HEIGHT, 1080), MIN_DIM);
        assert_eq!(clamp_dimension(5000, MIN_DIM, MAX_HEIGHT, 1080), MAX_HEIGHT);
        assert_eq!(clamp_dimension(720, MIN_DIM, MAX_HEIGHT, 1080), 720);
    }

    #[test]
    fn clamp_dimension_boundary_values() {
        assert_eq!(clamp_dimension(1, MIN_DIM, MAX_WIDTH, 1920), MIN_DIM);
        assert_eq!(clamp_dimension(63, MIN_DIM, MAX_WIDTH, 1920), MIN_DIM);
        assert_eq!(clamp_dimension(65, MIN_DIM, MAX_WIDTH, 1920), 65);
        assert_eq!(clamp_dimension(7679, MIN_DIM, MAX_WIDTH, 1920), 7679);
        assert_eq!(clamp_dimension(7681, MIN_DIM, MAX_WIDTH, 1920), MAX_WIDTH);
    }

    #[test]
    fn tunnel_query_partial_values() {
        let q: TunnelQuery = serde_json::from_str(r#"{"width":2560}"#).unwrap();
        assert_eq!(q.width.unwrap(), 2560);
        assert!(q.height.is_none());
        assert!(q.dpi.is_none());
        assert!(q.username.is_none());
    }

    #[test]
    fn create_ticket_request_full() {
        let json = r#"{"connection_id":"550e8400-e29b-41d4-a716-446655440000","username":"admin","password":"secret","width":3840,"height":2160,"dpi":192}"#;
        let r: CreateTicketRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.username.as_deref(), Some("admin"));
        assert_eq!(r.password.as_deref(), Some("secret"));
        assert_eq!(r.width, Some(3840));
        assert_eq!(r.height, Some(2160));
        assert_eq!(r.dpi, Some(192));
    }

    // ── Additional clamp_dimension tests ───────────────────────────

    #[test]
    fn clamp_dimension_default_is_returned_for_zero() {
        // Different defaults for different use cases
        assert_eq!(clamp_dimension(0, MIN_DIM, MAX_WIDTH, 1920), 1920);
        assert_eq!(clamp_dimension(0, MIN_DIM, MAX_HEIGHT, 1080), 1080);
        assert_eq!(clamp_dimension(0, MIN_DIM, MAX_DPI, 96), 96);
    }

    #[test]
    fn clamp_dimension_u32_max() {
        assert_eq!(
            clamp_dimension(u32::MAX, MIN_DIM, MAX_WIDTH, 1920),
            MAX_WIDTH
        );
    }

    #[test]
    fn clamp_dimension_value_equals_default() {
        assert_eq!(clamp_dimension(1920, MIN_DIM, MAX_WIDTH, 1920), 1920);
    }

    // ── TunnelQuery edge cases ─────────────────────────────────────

    #[test]
    fn tunnel_query_with_ticket_only() {
        let q: TunnelQuery = serde_json::from_str(r#"{"ticket":"abc-ticket-123"}"#).unwrap();
        assert_eq!(q.ticket.as_deref(), Some("abc-ticket-123"));
        assert!(q.username.is_none());
    }

    // ── CreateTicketRequest edge cases ─────────────────────────────

    #[test]
    fn create_ticket_request_with_credential_profile() {
        let json = r#"{"connection_id":"550e8400-e29b-41d4-a716-446655440000","credential_profile_id":"660e8400-e29b-41d4-a716-446655440000"}"#;
        let r: CreateTicketRequest = serde_json::from_str(json).unwrap();
        assert!(r.credential_profile_id.is_some());
    }

    #[test]
    fn create_ticket_request_with_ignore_cert() {
        let json = r#"{"connection_id":"550e8400-e29b-41d4-a716-446655440000","ignore_cert":true}"#;
        let r: CreateTicketRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.ignore_cert, Some(true));
    }

    // ── Rate limit constants ───────────────────────────────────────

    #[test]
    fn tunnel_rate_limit_constants() {
        assert_eq!(MAX_TUNNEL_PER_USER, 30);
        assert_eq!(TUNNEL_WINDOW_SECS, 60);
        const { assert!(MAX_TUNNEL_RATE_ENTRIES >= 10_000) };
    }

    // ── Dimension constants for completeness ───────────────────────

    #[test]
    fn max_width_at_least_8k() {
        const { assert!(MAX_WIDTH >= 7680) };
    }

    #[test]
    fn max_height_at_least_8k() {
        const { assert!(MAX_HEIGHT >= 4320) };
    }

    #[test]
    fn max_dpi_is_reasonable() {
        const { assert!(MAX_DPI >= 300) };
        const { assert!(MAX_DPI <= 1200) };
    }

    // ── resolve_credentials ────────────────────────────────────────

    fn cred(u: Option<&str>, p: Option<&str>) -> CredentialSource {
        CredentialSource {
            username: u.map(|s| s.to_string()),
            password: p.map(|s| s.to_string()),
        }
    }

    #[test]
    fn resolve_creds_oneoff_wins() {
        let (u, p) = resolve_credentials(
            &cred(Some("oneoff_u"), Some("oneoff_p")),
            &cred(Some("vault_u"), Some("vault_p")),
            Some(&cred(Some("ticket_u"), Some("ticket_p"))),
            &cred(Some("query_u"), Some("query_p")),
            "fallback",
        );
        assert_eq!(u.as_deref(), Some("oneoff_u"));
        assert_eq!(p.as_deref(), Some("oneoff_p"));
    }

    #[test]
    fn resolve_creds_vault_wins_over_ticket() {
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(Some("vault_u"), Some("vault_p")),
            Some(&cred(Some("ticket_u"), Some("ticket_p"))),
            &cred(None, None),
            "fallback",
        );
        assert_eq!(u.as_deref(), Some("vault_u"));
        assert_eq!(p.as_deref(), Some("vault_p"));
    }

    #[test]
    fn resolve_creds_ticket_wins_over_query() {
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(None, None),
            Some(&cred(Some("ticket_u"), Some("ticket_p"))),
            &cred(Some("query_u"), Some("query_p")),
            "fallback",
        );
        assert_eq!(u.as_deref(), Some("ticket_u"));
        assert_eq!(p.as_deref(), Some("ticket_p"));
    }

    #[test]
    fn resolve_creds_query_fallback() {
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(None, None),
            None,
            &cred(Some("query_u"), Some("query_p")),
            "fallback",
        );
        assert_eq!(u.as_deref(), Some("query_u"));
        assert_eq!(p.as_deref(), Some("query_p"));
    }

    #[test]
    fn resolve_creds_none_when_empty() {
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(None, None),
            None,
            &cred(None, None),
            "fallback",
        );
        assert!(u.is_none());
        assert!(p.is_none());
    }

    #[test]
    fn resolve_creds_fallback_username_when_missing() {
        let (u, p) = resolve_credentials(
            &cred(None, Some("oneoff_p")),
            &cred(None, None),
            None,
            &cred(None, None),
            "fallback",
        );
        assert_eq!(u.as_deref(), Some("fallback"));
        assert_eq!(p.as_deref(), Some("oneoff_p"));
    }

    #[test]
    fn resolve_creds_vault_fallback_username() {
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(None, Some("vault_p")),
            None,
            &cred(None, None),
            "user1",
        );
        assert_eq!(u.as_deref(), Some("user1"));
        assert_eq!(p.as_deref(), Some("vault_p"));
    }

    #[test]
    fn resolve_creds_ticket_with_password_only() {
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(None, None),
            Some(&cred(None, Some("tp"))),
            &cred(None, None),
            "fb_user",
        );
        assert_eq!(u.as_deref(), Some("fb_user"));
        assert_eq!(p.as_deref(), Some("tp"));
    }

    #[test]
    fn resolve_creds_ticket_no_password_skipped() {
        // Ticket with a username but no password must NOT short-circuit
        // the cascade — otherwise an empty ticket silently wins over a
        // later source that DOES have a password (see the `query`
        // CredentialSource here). The cascade must fall through to the
        // next source that actually carries a password.
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(None, None),
            Some(&cred(Some("tu"), None)),
            &cred(Some("qu"), Some("qp")),
            "fb",
        );
        assert_eq!(u.as_deref(), Some("qu"));
        assert_eq!(p.as_deref(), Some("qp"));
    }

    #[test]
    fn resolve_creds_query_fallback_username() {
        let (u, _p) = resolve_credentials(
            &cred(None, None),
            &cred(None, None),
            None,
            &cred(None, Some("qp")),
            "me",
        );
        assert_eq!(u.as_deref(), Some("me"));
    }

    #[test]
    fn resolve_creds_oneoff_priority() {
        let oneoff = cred(Some("oneoff"), Some("p1"));
        let vault = cred(Some("vault"), Some("p2"));
        let (u, p) = resolve_credentials(&oneoff, &vault, None, &vault, "fb");
        assert_eq!(u.as_deref(), Some("oneoff"));
        assert_eq!(p.as_deref(), Some("p1"));
    }

    #[test]
    fn resolve_creds_vault_priority() {
        let oneoff = cred(None, None);
        let vault = cred(Some("vault"), Some("p2"));
        let (u, p) = resolve_credentials(&oneoff, &vault, None, &vault, "fb");
        assert_eq!(u.as_deref(), Some("vault"));
        assert_eq!(p.as_deref(), Some("p2"));
    }

    #[test]
    fn resolve_creds_ticket_priority() {
        let none = cred(None, None);
        let ticket = cred(Some("ticket"), Some("p3"));
        let (u, p) = resolve_credentials(&none, &none, Some(&ticket), &none, "fb");
        assert_eq!(u.as_deref(), Some("ticket"));
        assert_eq!(p.as_deref(), Some("p3"));
    }

    #[test]
    fn resolve_creds_fallback_username_for_password_only() {
        let none = cred(None, None);
        let query = cred(None, Some("p4"));
        let (u, p) = resolve_credentials(&none, &none, None, &query, "john");
        assert_eq!(u.as_deref(), Some("john"));
        assert_eq!(p.as_deref(), Some("p4"));
    }

    /// Regression: an empty ticket (no password, no username) must NOT
    /// trigger the fallback-username path. Otherwise SSH connections with
    /// no preselected credentials get a free "username=<strata user>"
    /// silently injected into the guacd handshake, the SSH server
    /// short-circuits the in-band username prompt and only asks for a
    /// password — leaving the operator no way to specify the actual remote
    /// account they want to log in as.
    #[test]
    fn resolve_creds_empty_ticket_returns_none() {
        let none = cred(None, None);
        let empty_ticket = cred(None, None);
        let (u, p) = resolve_credentials(&none, &none, Some(&empty_ticket), &none, "fb");
        // Don't interpolate `u` / `p` into the panic message — even in a
        // test these are typed as `Option<String>` carrying credential
        // material in production callers, and CodeQL flags any format!()
        // of those types as cleartext logging of sensitive information.
        assert!(u.is_none(), "expected no fallback username");
        assert!(p.is_none(), "expected no password");
    }
}
