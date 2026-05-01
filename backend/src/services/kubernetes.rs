// Kubernetes-protocol helpers (v1.4.0).
//
// At the moment this module exists for one workflow: importing a
// kubeconfig YAML into Strata's connection-editor form. Operators
// drop their `~/.kube/config` (or the cluster-specific subset their
// IdP hands out) into a textarea, the backend parses it, and we
// hand back the broken-out pieces the connection editor needs:
//
//   • `server`             → top-level hostname[:port] for the connection
//   • `namespace`          → connection extras (`namespace` key)
//   • `ca_cert_pem`        → connection extras (`ca-cert`)
//   • `client_cert_pem`    → connection extras (`client-cert`)
//   • `client_key_pem`     → returned ONCE in the response so the operator
//                            can paste it into a credential profile.
//                            We deliberately do NOT persist the private
//                            key from this endpoint — Strata's policy is
//                            that private keys live exclusively in
//                            Vault-encrypted credential profiles, never
//                            in connection extras.
//
// Why a hand-rolled parser instead of the `kube` crate?  The full
// `kube` client pulls in roughly 80+ transitive dependencies (k8s-openapi,
// hyper, tower-http, kube-derive, …) just so we can read a YAML file.
// That's a lot of attack surface and build time for what is, at heart,
// "find five strings in a YAML document". `serde_yaml` + a tiny set of
// typed structs is sufficient.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Deserialize;

use crate::error::AppError;

/// Output of a successful kubeconfig parse.
///
/// Every field is optional because real-world kubeconfigs are
/// delightfully heterogeneous — some embed certs as base64 blobs
/// (`*-data`), some reference files on disk (`*` paths), some use
/// bearer tokens, exec plugins, or username/password instead of
/// mTLS. We extract whatever we can and let the frontend render
/// "missing — paste manually" hints for the rest.
#[derive(Debug, Default, serde::Serialize)]
pub struct ParsedKubeconfig {
    /// API server URL, e.g. `https://10.0.0.1:6443`.
    pub server: Option<String>,
    /// Default namespace declared on the selected context, if any.
    pub namespace: Option<String>,
    /// Cluster CA certificate in PEM form, if the kubeconfig embedded
    /// it as `certificate-authority-data` (base64). File-path references
    /// (`certificate-authority: /path/to/ca.crt`) are NOT followed for
    /// security reasons — the backend has no business reading random
    /// admin-controlled file paths.
    pub ca_cert_pem: Option<String>,
    /// User client certificate in PEM form (mTLS authn).
    pub client_cert_pem: Option<String>,
    /// User client private key in PEM form (mTLS authn). Returned to
    /// the caller exactly once; the caller is responsible for stashing
    /// it in a credential profile.
    pub client_key_pem: Option<String>,
    /// Whichever context the kubeconfig pointed `current-context` at,
    /// so the UI can show "imported context: prod-east" for clarity.
    pub current_context: Option<String>,
    /// Non-fatal warnings the operator should see — e.g. "auth uses
    /// exec plugin, please paste a bearer token manually".
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawKubeconfig {
    #[serde(default)]
    clusters: Vec<NamedCluster>,
    #[serde(default)]
    users: Vec<NamedUser>,
    #[serde(default)]
    contexts: Vec<NamedContext>,
    #[serde(default, rename = "current-context")]
    current_context: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NamedCluster {
    name: String,
    cluster: ClusterInner,
}

#[derive(Debug, Deserialize)]
struct ClusterInner {
    #[serde(default)]
    server: Option<String>,
    #[serde(default, rename = "certificate-authority-data")]
    ca_data: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NamedUser {
    name: String,
    user: UserInner,
}

#[derive(Debug, Default, Deserialize)]
struct UserInner {
    #[serde(default, rename = "client-certificate-data")]
    client_cert_data: Option<String>,
    #[serde(default, rename = "client-key-data")]
    client_key_data: Option<String>,
    /// Presence-only — if the user uses an exec plugin we surface a
    /// warning to the operator.
    #[serde(default)]
    exec: Option<serde_yaml::Value>,
    #[serde(default)]
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NamedContext {
    name: String,
    context: ContextInner,
}

#[derive(Debug, Deserialize)]
struct ContextInner {
    cluster: String,
    user: String,
    #[serde(default)]
    namespace: Option<String>,
}

/// Decode a base64 PEM blob, returning the decoded UTF-8 string.
fn decode_b64_pem(b64: &str) -> Result<String, AppError> {
    let bytes = B64
        .decode(b64.trim())
        .map_err(|e| AppError::Validation(format!("invalid base64 in kubeconfig: {e}")))?;
    String::from_utf8(bytes)
        .map_err(|_| AppError::Validation("kubeconfig PEM data was not valid UTF-8".into()))
}

/// Parse a pasted kubeconfig YAML body. The selected context defaults
/// to the kubeconfig's `current-context` field; callers may override
/// by passing `Some(ctx_name)`.
pub fn parse_kubeconfig(
    yaml: &str,
    context_override: Option<&str>,
) -> Result<ParsedKubeconfig, AppError> {
    if yaml.trim().is_empty() {
        return Err(AppError::Validation("kubeconfig body is empty".into()));
    }
    if yaml.len() > 1024 * 1024 {
        // Hard cap — a real kubeconfig is typically <16 KB. Anything
        // approaching a megabyte is a misuse or an attack.
        return Err(AppError::Validation(
            "kubeconfig body too large (>1 MiB)".into(),
        ));
    }

    let raw: RawKubeconfig = serde_yaml::from_str(yaml)
        .map_err(|e| AppError::Validation(format!("invalid kubeconfig YAML: {e}")))?;

    let mut out = ParsedKubeconfig {
        current_context: raw.current_context.clone(),
        ..Default::default()
    };

    // Resolve which context to use.
    let ctx_name: Option<&str> = context_override.or(raw.current_context.as_deref());
    let ctx = ctx_name.and_then(|n| raw.contexts.iter().find(|c| c.name == n));

    let (cluster_name, user_name) = if let Some(ctx) = ctx {
        out.namespace = ctx.context.namespace.clone();
        (
            Some(ctx.context.cluster.as_str()),
            Some(ctx.context.user.as_str()),
        )
    } else if raw.contexts.len() == 1 {
        // Fall back to the only context if `current-context` is absent
        // — common in cluster-specific kubeconfigs handed out by IdPs.
        let ctx = &raw.contexts[0];
        out.namespace = ctx.context.namespace.clone();
        (
            Some(ctx.context.cluster.as_str()),
            Some(ctx.context.user.as_str()),
        )
    } else {
        out.warnings.push(
            "no current-context set and multiple contexts present — please select a context manually".into(),
        );
        (None, None)
    };

    if let Some(name) = cluster_name {
        if let Some(cluster) = raw.clusters.iter().find(|c| c.name == name) {
            out.server = cluster.cluster.server.clone();
            if let Some(ref b64) = cluster.cluster.ca_data {
                match decode_b64_pem(b64) {
                    Ok(pem) => out.ca_cert_pem = Some(pem),
                    Err(e) => out
                        .warnings
                        .push(format!("could not decode cluster CA: {e}")),
                }
            }
        }
    }

    if let Some(name) = user_name {
        if let Some(user) = raw.users.iter().find(|u| u.name == name) {
            if let Some(ref b64) = user.user.client_cert_data {
                match decode_b64_pem(b64) {
                    Ok(pem) => out.client_cert_pem = Some(pem),
                    Err(e) => out
                        .warnings
                        .push(format!("could not decode client cert: {e}")),
                }
            }
            if let Some(ref b64) = user.user.client_key_data {
                match decode_b64_pem(b64) {
                    Ok(pem) => out.client_key_pem = Some(pem),
                    Err(e) => out
                        .warnings
                        .push(format!("could not decode client key: {e}")),
                }
            }
            if user.user.exec.is_some() {
                out.warnings.push(
                    "this user authenticates via an exec plugin — paste a bearer token into the credential profile manually".into(),
                );
            }
            if user.user.token.is_some() && user.user.client_key_data.is_none() {
                out.warnings.push(
                    "this user authenticates with a static bearer token — copy the `token` field into the credential profile's password slot".into(),
                );
            }
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
apiVersion: v1
kind: Config
current-context: prod
clusters:
- name: prod-cluster
  cluster:
    server: https://10.0.0.1:6443
    certificate-authority-data: SGVsbG8gQ0E=
users:
- name: prod-user
  user:
    client-certificate-data: SGVsbG8gQ0VSVA==
    client-key-data: SGVsbG8gS0VZ
contexts:
- name: prod
  context:
    cluster: prod-cluster
    user: prod-user
    namespace: my-ns
"#;

    #[test]
    fn parses_full_kubeconfig() {
        let p = parse_kubeconfig(SAMPLE, None).expect("parses");
        assert_eq!(p.server.as_deref(), Some("https://10.0.0.1:6443"));
        assert_eq!(p.namespace.as_deref(), Some("my-ns"));
        assert_eq!(p.ca_cert_pem.as_deref(), Some("Hello CA"));
        assert_eq!(p.client_cert_pem.as_deref(), Some("Hello CERT"));
        assert_eq!(p.client_key_pem.as_deref(), Some("Hello KEY"));
        assert_eq!(p.current_context.as_deref(), Some("prod"));
        assert!(p.warnings.is_empty());
    }

    #[test]
    fn empty_body_rejected() {
        let err = parse_kubeconfig("   \n", None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn warns_on_exec_plugin() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: c
clusters:
- name: cl
  cluster:
    server: https://k.example.com
users:
- name: u
  user:
    exec:
      command: aws-iam-authenticator
contexts:
- name: c
  context:
    cluster: cl
    user: u
"#;
        let p = parse_kubeconfig(yaml, None).expect("parses");
        assert!(p.warnings.iter().any(|w| w.contains("exec plugin")));
        assert!(p.client_key_pem.is_none());
    }

    #[test]
    fn warns_on_bearer_token() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: c
clusters:
- name: cl
  cluster:
    server: https://k.example.com
users:
- name: u
  user:
    token: abc123
contexts:
- name: c
  context:
    cluster: cl
    user: u
"#;
        let p = parse_kubeconfig(yaml, None).expect("parses");
        assert!(p.warnings.iter().any(|w| w.contains("bearer token")));
    }

    #[test]
    fn falls_back_to_only_context() {
        let yaml = r#"
apiVersion: v1
kind: Config
clusters:
- name: cl
  cluster:
    server: https://k.example.com
users:
- name: u
  user: {}
contexts:
- name: only
  context:
    cluster: cl
    user: u
    namespace: ns1
"#;
        let p = parse_kubeconfig(yaml, None).expect("parses");
        assert_eq!(p.namespace.as_deref(), Some("ns1"));
        assert_eq!(p.server.as_deref(), Some("https://k.example.com"));
    }

    #[test]
    fn rejects_oversized_body() {
        let big = "x".repeat(1024 * 1024 + 10);
        let err = parse_kubeconfig(&big, None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
