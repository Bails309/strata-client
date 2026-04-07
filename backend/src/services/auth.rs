use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// Standard OIDC claims extracted from the access token.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: String,
    pub preferred_username: Option<String>,
    pub email: Option<String>,
    pub exp: usize,
    pub iat: usize,
}

/// OIDC discovery document (subset).
#[derive(Deserialize)]
struct OidcDiscovery {
    jwks_uri: String,
    issuer: String,
}

/// JSON Web Key Set.
#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Jwk {
    kid: Option<String>,
    n: String,
    e: String,
    kty: String,
}

/// Validate an OIDC bearer token against the dynamically-configured issuer.
pub async fn validate_token(
    issuer_url: &str,
    client_id: &str,
    token: &str,
) -> Result<Claims, AppError> {
    let client = Client::new();

    // 1. Fetch OIDC discovery
    let discovery_url = format!(
        "{}/.well-known/openid-configuration",
        issuer_url.trim_end_matches('/')
    );
    let discovery: OidcDiscovery = client
        .get(&discovery_url)
        .send()
        .await
        .map_err(|e| AppError::Auth(format!("OIDC discovery failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Auth(format!("OIDC discovery parse: {e}")))?;

    // 2. Fetch JWKS
    let jwks: Jwks = client
        .get(&discovery.jwks_uri)
        .send()
        .await
        .map_err(|e| AppError::Auth(format!("JWKS fetch failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Auth(format!("JWKS parse: {e}")))?;

    // 3. Decode header to find kid
    let header = jsonwebtoken::decode_header(token)
        .map_err(|e| AppError::Auth(format!("Token header: {e}")))?;

    let jwk = if let Some(kid) = &header.kid {
        jwks.keys
            .iter()
            .find(|k| k.kid.as_deref() == Some(kid))
            .ok_or_else(|| AppError::Auth("No matching JWK kid".into()))?
    } else {
        jwks.keys
            .first()
            .ok_or_else(|| AppError::Auth("JWKS empty".into()))?
    };

    if jwk.kty != "RSA" {
        return Err(AppError::Auth("Unsupported key type".into()));
    }

    // 4. Build decoding key and validate
    let key = DecodingKey::from_rsa_components(&jwk.n, &jwk.e)
        .map_err(|e| AppError::Auth(format!("RSA key: {e}")))?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&[&discovery.issuer]);

    let token_data = decode::<Claims>(token, &key, &validation)
        .map_err(|e| AppError::Auth(format!("Token validation: {e}")))?;

    Ok(token_data.claims)
}
