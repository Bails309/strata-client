// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

// Scriptless-fallback module: items below are exercised by unit tests
// and reserved for the in-process DSL path; the runtime currently
// drives login automation through `web_login_script` instead.
#![allow(dead_code)]

//! Chrome DevTools Protocol (CDP) login-script command compiler —
//! rustguac parity (Phase 2, tracker
//! [`docs/runbooks/rustguac-parity-tracker.md`]).
//!
//! ## Status: scriptless fallback only (rustguac parity D5)
//!
//! After the rustguac design alignment audit (tracker section *D.
//! CDP login automation*), Strata's **primary** login automation path
//! is the external operator-supplied script runner in
//! [`web_login_script`](super::web_login_script) (rustguac parity
//! D1–D4). Operator scripts get spawned via `tokio::process::Command`
//! with stdin-JSON credentials and env-var context — that path keeps
//! the maintenance burden of CDP version drift with the operator,
//! not with Strata.
//!
//! This in-process DSL compiler is retained as a **scriptless
//! fallback** for simple Strata-managed login flows where the
//! operator hasn't shipped a script. The `js_string` escape helper
//! and the URL/selector validation are also called by the script
//! runner for parameter sanitisation.
//!
//! When a `web` connection is configured with `extra.login_script`, the
//! spawn-runtime layer connects to the Chromium kiosk's
//! `--remote-debugging-port=N` over WebSocket and drives a scripted
//! login flow (typing usernames, clicking submit, waiting for the
//! post-login URL). This module compiles the operator-facing **script
//! DSL** into the **CDP JSON-RPC payloads** that the WebSocket
//! transport sends.
//!
//! Why split compilation from transport?
//! -------------------------------------
//!
//! 1. Compilation is pure data-in / data-out and exhaustively
//!    unit-testable without spinning up a Chromium.
//! 2. The WebSocket transport adds `tokio-tungstenite`, retries,
//!    timeouts, and matching response IDs back to requests — that's a
//!    separate commit landing with the spawn runtime.
//! 3. Operators iterating on a script don't need to touch the
//!    transport code; they only ever see the DSL.
//!
//! Script DSL
//! ----------
//!
//! Each step is a single-key JSON object. Steps execute sequentially
//! and the next step starts only after the previous step's CDP call
//! has returned.
//!
//! ```json
//! [
//!   { "navigate":   "https://idp.example.com/saml/login" },
//!   { "wait_for":   "input[name=username]" },
//!   { "type":       { "selector": "input[name=username]", "text": "${USERNAME}" } },
//!   { "type":       { "selector": "input[name=password]", "text": "${PASSWORD}" } },
//!   { "click":      "button[type=submit]" },
//!   { "wait_for_url": "https://app.example.com/dashboard" }
//! ]
//! ```
//!
//! Variables: `${USERNAME}` and `${PASSWORD}` are substituted from the
//! per-session credentials at compile time. No other variables are
//! supported — keeping the substitution closed avoids accidentally
//! leaking environment bits into the page.
//!
//! Element matching: every selector is run via
//! `Runtime.evaluate { expression: "document.querySelector(...)" }`
//! so operators get the full power of CSS selectors without us having
//! to ship a parser.

use serde::{Deserialize, Serialize};

/// Polling interval the runtime uses for `wait_for` / `wait_for_url`.
/// Pinned here so script semantics are fully captured by this module
/// (the transport layer just consumes it).
#[allow(dead_code)] // Consumed by the deferred CDP transport runtime.
pub const WAIT_POLL_INTERVAL_MS: u64 = 200;

/// Default timeout for any single step. The transport layer enforces
/// this; the compiler only emits commands. Kept conservative —
/// rustguac uses 30s and the same value works fine for SAML/OIDC IdPs.
pub const DEFAULT_STEP_TIMEOUT_SECS: u64 = 30;

// ─────────────────────────────────────────────────────────────────────
// DSL
// ─────────────────────────────────────────────────────────────────────

/// A single step in the operator-facing login script. Externally
/// tagged (one key per object) so the JSON form is human-readable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LoginScriptStep {
    /// `Page.navigate { url }`
    Navigate(String),

    /// Poll `Runtime.evaluate` until the selector matches a node, or
    /// the step timeout expires. Selector is a CSS selector.
    WaitFor(String),

    /// Poll `Runtime.evaluate` until `document.location.href ===
    /// <url>` (exact equality — operators wanting prefix-match should
    /// say so explicitly with a more permissive selector-based step).
    WaitForUrl(String),

    /// Type literal text into the matched input. Internally compiled
    /// to `Runtime.evaluate` that sets `.value` and dispatches the
    /// `input` and `change` events so React/Vue listeners fire.
    Type {
        selector: String,
        text: String,
    },

    /// `Runtime.evaluate` that calls `.click()` on the matched node.
    Click(String),

    /// Sleep for N milliseconds. Last-resort step for IdPs that do
    /// post-redirect JS work; using `wait_for_url` is preferred.
    Sleep { ms: u64 },
}

/// Inputs to [`compile_script`]. Holding these in a struct rather than
/// passing four positional args makes the call site readable.
#[derive(Debug, Clone)]
pub struct ScriptContext<'a> {
    pub username: &'a str,
    pub password: &'a str,
}

/// Errors that can occur during compilation. All are operator
/// configuration mistakes — the transport never sees them.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LoginScriptError {
    #[error("script step {step} references unknown variable '{var}'")]
    UnknownVariable { step: usize, var: String },
    #[error("script step {step}: empty selector")]
    EmptySelector { step: usize },
    #[error("script step {step}: empty url")]
    EmptyUrl { step: usize },
}

/// One CDP JSON-RPC request payload. The `id` field is filled in by
/// the transport layer at send time so the request/response pairing
/// works correctly when multiple commands are in flight (which we
/// never do, but defending against the day someone pipelines).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CdpCommand {
    /// CDP method, e.g. `Page.navigate`.
    pub method: String,
    /// JSON params object. Always an object (never null) so the
    /// JSON-RPC payload is uniform.
    pub params: serde_json::Value,
    /// Per-step timeout. The transport layer enforces this.
    pub timeout_secs: u64,
    /// True when the step polls until a condition is satisfied. The
    /// transport layer re-evaluates with [`WAIT_POLL_INTERVAL_MS`]
    /// when the result is `false`.
    pub is_poll: bool,
    /// When `is_poll` is true, the JS expression returning a truthy
    /// value when the wait completes. Stored separately from `params`
    /// because the transport reuses the same `Runtime.evaluate` shape
    /// for each poll.
    pub poll_expression: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────
// Compilation
// ─────────────────────────────────────────────────────────────────────

/// Compile the operator's DSL steps to a vector of CDP commands ready
/// for the transport layer to dispatch. Variable substitution
/// (`${USERNAME}` / `${PASSWORD}`) happens here.
pub fn compile_script(
    steps: &[LoginScriptStep],
    ctx: &ScriptContext<'_>,
) -> Result<Vec<CdpCommand>, LoginScriptError> {
    let mut out = Vec::with_capacity(steps.len());
    for (idx, step) in steps.iter().enumerate() {
        out.push(compile_step(idx, step, ctx)?);
    }
    Ok(out)
}

fn compile_step(
    idx: usize,
    step: &LoginScriptStep,
    ctx: &ScriptContext<'_>,
) -> Result<CdpCommand, LoginScriptError> {
    match step {
        LoginScriptStep::Navigate(url) => {
            if url.is_empty() {
                return Err(LoginScriptError::EmptyUrl { step: idx });
            }
            Ok(CdpCommand {
                method: "Page.navigate".into(),
                params: serde_json::json!({ "url": url }),
                timeout_secs: DEFAULT_STEP_TIMEOUT_SECS,
                is_poll: false,
                poll_expression: None,
            })
        }
        LoginScriptStep::WaitFor(selector) => {
            if selector.is_empty() {
                return Err(LoginScriptError::EmptySelector { step: idx });
            }
            // The transport will dispatch `Runtime.evaluate { expression: <expr> }`
            // every WAIT_POLL_INTERVAL_MS until the result.value is true.
            Ok(CdpCommand {
                method: "Runtime.evaluate".into(),
                params: serde_json::json!({
                    "expression": format!(
                        "!!document.querySelector({})", js_string(selector)
                    ),
                    "returnByValue": true,
                }),
                timeout_secs: DEFAULT_STEP_TIMEOUT_SECS,
                is_poll: true,
                poll_expression: Some(format!(
                    "!!document.querySelector({})",
                    js_string(selector)
                )),
            })
        }
        LoginScriptStep::WaitForUrl(url) => {
            if url.is_empty() {
                return Err(LoginScriptError::EmptyUrl { step: idx });
            }
            Ok(CdpCommand {
                method: "Runtime.evaluate".into(),
                params: serde_json::json!({
                    "expression": format!(
                        "document.location.href === {}", js_string(url)
                    ),
                    "returnByValue": true,
                }),
                timeout_secs: DEFAULT_STEP_TIMEOUT_SECS,
                is_poll: true,
                poll_expression: Some(format!(
                    "document.location.href === {}",
                    js_string(url)
                )),
            })
        }
        LoginScriptStep::Type { selector, text } => {
            if selector.is_empty() {
                return Err(LoginScriptError::EmptySelector { step: idx });
            }
            let resolved = substitute_vars(text, ctx, idx)?;
            // Set `.value` and dispatch input/change events so SPA
            // frameworks (React controlled inputs in particular) pick
            // up the change. JSON-encoding both sides means we don't
            // have to worry about quoting in selectors or text.
            let expr = format!(
                "(() => {{ \
                    const el = document.querySelector({sel}); \
                    if (!el) return false; \
                    el.focus(); \
                    el.value = {txt}; \
                    el.dispatchEvent(new Event('input',  {{ bubbles: true }})); \
                    el.dispatchEvent(new Event('change', {{ bubbles: true }})); \
                    return true; \
                }})()",
                sel = js_string(selector),
                txt = js_string(&resolved),
            );
            Ok(CdpCommand {
                method: "Runtime.evaluate".into(),
                params: serde_json::json!({
                    "expression": expr,
                    "returnByValue": true,
                }),
                timeout_secs: DEFAULT_STEP_TIMEOUT_SECS,
                is_poll: false,
                poll_expression: None,
            })
        }
        LoginScriptStep::Click(selector) => {
            if selector.is_empty() {
                return Err(LoginScriptError::EmptySelector { step: idx });
            }
            let expr = format!(
                "(() => {{ \
                    const el = document.querySelector({sel}); \
                    if (!el) return false; \
                    el.click(); \
                    return true; \
                }})()",
                sel = js_string(selector),
            );
            Ok(CdpCommand {
                method: "Runtime.evaluate".into(),
                params: serde_json::json!({
                    "expression": expr,
                    "returnByValue": true,
                }),
                timeout_secs: DEFAULT_STEP_TIMEOUT_SECS,
                is_poll: false,
                poll_expression: None,
            })
        }
        LoginScriptStep::Sleep { ms } => {
            // Modelled as a poll that always returns false plus a
            // tight timeout. The transport's poll loop gives us the
            // actual delay, capped at the step timeout. This keeps the
            // transport semantics uniform across all step types.
            Ok(CdpCommand {
                method: "Runtime.evaluate".into(),
                params: serde_json::json!({
                    "expression": "false",
                    "returnByValue": true,
                }),
                timeout_secs: (ms / 1000).max(1),
                is_poll: true,
                poll_expression: Some("false".into()),
            })
        }
    }
}

/// Substitute `${USERNAME}` and `${PASSWORD}` placeholders in the
/// step's text. Any other `${...}` placeholder is rejected — closed
/// substitution surface keeps environment bits out of the page.
fn substitute_vars(
    s: &str,
    ctx: &ScriptContext<'_>,
    step_idx: usize,
) -> Result<String, LoginScriptError> {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' && chars.peek() == Some(&'{') {
            chars.next(); // consume `{`
            let mut name = String::new();
            let mut closed = false;
            for nc in chars.by_ref() {
                if nc == '}' {
                    closed = true;
                    break;
                }
                name.push(nc);
            }
            if !closed {
                // Unterminated placeholder — treat as literal,
                // preserves the original `${...` substring.
                out.push('$');
                out.push('{');
                out.push_str(&name);
                continue;
            }
            match name.as_str() {
                "USERNAME" => out.push_str(ctx.username),
                "PASSWORD" => out.push_str(ctx.password),
                other => {
                    return Err(LoginScriptError::UnknownVariable {
                        step: step_idx,
                        var: other.to_string(),
                    });
                }
            }
        } else {
            out.push(c);
        }
    }
    Ok(out)
}

/// Encode a Rust string as a valid JavaScript string literal —
/// double-quoted, with `\`, `"`, control characters, and Unicode line
/// separators escaped. Used both for selectors and for typed text so
/// neither can break out of the surrounding `Runtime.evaluate`
/// expression. Equivalent to `JSON.stringify(s)` for plain strings.
pub fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"'  => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR are
            // valid in JSON but break JS source code.
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ScriptContext<'static> {
        ScriptContext {
            username: "alice",
            password: "hunter2",
        }
    }

    // ── js_string ───────────────────────────────────────────────────
    #[test]
    fn js_string_quotes_simple() {
        assert_eq!(js_string("hello"), r#""hello""#);
    }

    #[test]
    fn js_string_escapes_backslash_and_quote() {
        assert_eq!(js_string("a\"b\\c"), r#""a\"b\\c""#);
    }

    #[test]
    fn js_string_escapes_control_chars() {
        assert_eq!(js_string("a\nb\tc"), r#""a\nb\tc""#);
    }

    #[test]
    fn js_string_escapes_line_separators() {
        // U+2028 must be escaped or the JS parser breaks mid-string.
        let result = js_string("a\u{2028}b");
        assert!(result.contains("\\u2028"));
    }

    // ── substitute_vars ─────────────────────────────────────────────
    #[test]
    fn substitute_replaces_username() {
        let s = substitute_vars("user=${USERNAME}", &ctx(), 0).unwrap();
        assert_eq!(s, "user=alice");
    }

    #[test]
    fn substitute_replaces_password() {
        let s = substitute_vars("pw=${PASSWORD}", &ctx(), 0).unwrap();
        assert_eq!(s, "pw=hunter2");
    }

    #[test]
    fn substitute_replaces_both() {
        let s = substitute_vars("${USERNAME}:${PASSWORD}", &ctx(), 0).unwrap();
        assert_eq!(s, "alice:hunter2");
    }

    #[test]
    fn substitute_rejects_unknown_var() {
        let err = substitute_vars("${HOME}", &ctx(), 7).unwrap_err();
        assert_eq!(
            err,
            LoginScriptError::UnknownVariable {
                step: 7,
                var: "HOME".into()
            }
        );
    }

    #[test]
    fn substitute_passes_through_no_placeholders() {
        let s = substitute_vars("plain text", &ctx(), 0).unwrap();
        assert_eq!(s, "plain text");
    }

    #[test]
    fn substitute_handles_unterminated_placeholder_literally() {
        // Unterminated `${USERNAME` (no closing `}`) is preserved as-is
        // rather than erroring. Defensive: prevents script DSL typos
        // from breaking at runtime when the substitution surface is
        // mostly literal text.
        let s = substitute_vars("u=${USERNAME and more", &ctx(), 0).unwrap();
        assert_eq!(s, "u=${USERNAME and more");
    }

    // ── compile_script ──────────────────────────────────────────────
    #[test]
    fn compile_navigate_step() {
        let cmds = compile_script(
            &[LoginScriptStep::Navigate("https://idp/login".into())],
            &ctx(),
        )
        .unwrap();
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].method, "Page.navigate");
        assert_eq!(cmds[0].params["url"], "https://idp/login");
        assert!(!cmds[0].is_poll);
    }

    #[test]
    fn compile_navigate_rejects_empty_url() {
        let err = compile_script(&[LoginScriptStep::Navigate("".into())], &ctx()).unwrap_err();
        assert_eq!(err, LoginScriptError::EmptyUrl { step: 0 });
    }

    #[test]
    fn compile_wait_for_uses_query_selector() {
        let cmds = compile_script(
            &[LoginScriptStep::WaitFor("input[name=user]".into())],
            &ctx(),
        )
        .unwrap();
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].method, "Runtime.evaluate");
        assert!(cmds[0].is_poll);
        let expr = cmds[0].params["expression"].as_str().unwrap();
        assert!(expr.contains("document.querySelector"));
        assert!(expr.contains(r#""input[name=user]""#));
    }

    #[test]
    fn compile_wait_for_url_compares_location() {
        let cmds = compile_script(
            &[LoginScriptStep::WaitForUrl("https://app/dash".into())],
            &ctx(),
        )
        .unwrap();
        let expr = cmds[0].params["expression"].as_str().unwrap();
        assert!(expr.contains("document.location.href ==="));
        assert!(cmds[0].is_poll);
    }

    #[test]
    fn compile_type_substitutes_username_and_dispatches_events() {
        let cmds = compile_script(
            &[LoginScriptStep::Type {
                selector: "#u".into(),
                text: "${USERNAME}".into(),
            }],
            &ctx(),
        )
        .unwrap();
        let expr = cmds[0].params["expression"].as_str().unwrap();
        assert!(expr.contains(r#""alice""#), "expected substituted username in {expr}");
        assert!(expr.contains("dispatchEvent(new Event('input'"));
        assert!(expr.contains("dispatchEvent(new Event('change'"));
    }

    #[test]
    fn compile_type_quotes_password_safely() {
        // Adversarial password containing `"` and `\` must not break
        // out of the JS string literal.
        let ctx = ScriptContext {
            username: "u",
            password: r#"hun"ter\2"#,
        };
        let cmds = compile_script(
            &[LoginScriptStep::Type {
                selector: "#p".into(),
                text: "${PASSWORD}".into(),
            }],
            &ctx,
        )
        .unwrap();
        let expr = cmds[0].params["expression"].as_str().unwrap();
        // `"` -> \"   `\` -> \\
        assert!(expr.contains(r#""hun\"ter\\2""#), "expr was {expr}");
    }

    #[test]
    fn compile_type_rejects_empty_selector() {
        let err = compile_script(
            &[LoginScriptStep::Type {
                selector: "".into(),
                text: "x".into(),
            }],
            &ctx(),
        )
        .unwrap_err();
        assert_eq!(err, LoginScriptError::EmptySelector { step: 0 });
    }

    #[test]
    fn compile_type_rejects_unknown_variable() {
        let err = compile_script(
            &[LoginScriptStep::Type {
                selector: "#u".into(),
                text: "${HOME}".into(),
            }],
            &ctx(),
        )
        .unwrap_err();
        assert_eq!(
            err,
            LoginScriptError::UnknownVariable {
                step: 0,
                var: "HOME".into()
            }
        );
    }

    #[test]
    fn compile_click_calls_dot_click() {
        let cmds = compile_script(
            &[LoginScriptStep::Click("button[type=submit]".into())],
            &ctx(),
        )
        .unwrap();
        let expr = cmds[0].params["expression"].as_str().unwrap();
        assert!(expr.contains(".click()"));
    }

    #[test]
    fn compile_sleep_emits_poll_with_timeout() {
        let cmds = compile_script(&[LoginScriptStep::Sleep { ms: 1500 }], &ctx()).unwrap();
        assert!(cmds[0].is_poll);
        // 1500ms / 1000 = 1, but `.max(1)` guards the rounding case.
        assert_eq!(cmds[0].timeout_secs, 1);
    }

    #[test]
    fn compile_full_saml_flow() {
        let steps = vec![
            LoginScriptStep::Navigate("https://idp/saml".into()),
            LoginScriptStep::WaitFor("input[name=u]".into()),
            LoginScriptStep::Type {
                selector: "input[name=u]".into(),
                text: "${USERNAME}".into(),
            },
            LoginScriptStep::Type {
                selector: "input[name=p]".into(),
                text: "${PASSWORD}".into(),
            },
            LoginScriptStep::Click("button[type=submit]".into())
,
            LoginScriptStep::WaitForUrl("https://app/dash".into()),
        ];
        let cmds = compile_script(&steps, &ctx()).unwrap();
        assert_eq!(cmds.len(), 6);
        assert_eq!(cmds[0].method, "Page.navigate");
        assert!(cmds[1].is_poll);
        assert!(cmds[2].params["expression"].as_str().unwrap().contains(r#""alice""#));
        assert!(cmds[3].params["expression"].as_str().unwrap().contains(r#""hunter2""#));
        assert!(cmds[4].params["expression"].as_str().unwrap().contains(".click()"));
        assert!(cmds[5].is_poll);
    }

    // ── DSL deserialization ─────────────────────────────────────────
    #[test]
    fn dsl_parses_externally_tagged_json() {
        let json = serde_json::json!([
            { "navigate": "https://idp" },
            { "wait_for": "#user" },
            { "type": { "selector": "#user", "text": "${USERNAME}" } },
            { "click": "#submit" },
            { "wait_for_url": "https://app" },
            { "sleep": { "ms": 250 } },
        ]);
        let steps: Vec<LoginScriptStep> = serde_json::from_value(json).expect("deserialize");
        assert_eq!(steps.len(), 6);
        assert_eq!(
            steps[0],
            LoginScriptStep::Navigate("https://idp".into())
        );
        assert_eq!(steps[3], LoginScriptStep::Click("#submit".into()));
        assert_eq!(steps[5], LoginScriptStep::Sleep { ms: 250 });
    }
}
