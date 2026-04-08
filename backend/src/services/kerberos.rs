use std::path::Path;

/// A single Kerberos realm configuration.
pub struct RealmConfig {
    pub realm: String,
    pub kdcs: Vec<String>,
    pub admin_server: String,
    pub ticket_lifetime: String,
    pub renew_lifetime: String,
    pub is_default: bool,
}

/// Reject values that could inject krb5.conf directives (newlines, braces, etc.).
fn sanitize_krb5_value(val: &str, field: &str) -> anyhow::Result<()> {
    if val.contains('\n')
        || val.contains('\r')
        || val.contains('{')
        || val.contains('}')
        || val.contains('[')
        || val.contains(']')
        || val.contains('#')
        || val.contains(';')
    {
        anyhow::bail!("Invalid character in Kerberos {field}: {val:?}");
    }
    Ok(())
}

/// Generate a krb5.conf that contains all configured realms and write it out.
pub fn write_krb5_conf_multi(realms: &[RealmConfig], output_path: &str) -> anyhow::Result<()> {
    if realms.is_empty() {
        // Remove the file if no realms are configured
        let _ = std::fs::remove_file(output_path);
        tracing::info!("No Kerberos realms configured — removed {output_path}");
        return Ok(());
    }

    // Validate all values before generating config
    for r in realms {
        sanitize_krb5_value(&r.realm, "realm")?;
        sanitize_krb5_value(&r.admin_server, "admin_server")?;
        sanitize_krb5_value(&r.ticket_lifetime, "ticket_lifetime")?;
        sanitize_krb5_value(&r.renew_lifetime, "renew_lifetime")?;
        for kdc in &r.kdcs {
            sanitize_krb5_value(kdc, "kdc")?;
        }
    }

    // The default realm is whichever is flagged, or the first one
    let default = realms.iter().find(|r| r.is_default).unwrap_or(&realms[0]);

    let default_upper = default.realm.to_uppercase();

    // Use the default realm's lifetimes in [libdefaults]
    let ticket_lifetime = &default.ticket_lifetime;
    let renew_lifetime = &default.renew_lifetime;

    // [realms] section — one block per realm
    let mut realms_section = String::new();
    for r in realms {
        let upper = r.realm.to_uppercase();
        let kdc_lines: String = r
            .kdcs
            .iter()
            .map(|k| format!("        kdc = {k}"))
            .collect::<Vec<_>>()
            .join("\n");
        realms_section.push_str(&format!(
            "    {upper} = {{\n{kdc_lines}\n        admin_server = {admin}\n    }}\n",
            admin = r.admin_server,
        ));
    }

    // [domain_realm] section — map .domain and domain for every realm
    let mut domain_realm_section = String::new();
    for r in realms {
        let upper = r.realm.to_uppercase();
        let lower = r.realm.to_lowercase();
        domain_realm_section.push_str(&format!("    .{lower} = {upper}\n"));
        domain_realm_section.push_str(&format!("    {lower} = {upper}\n"));
    }

    // [capaths] section — cross-realm trust paths between all configured realms
    let mut capaths_section = String::new();
    if realms.len() > 1 {
        for r in realms {
            let upper = r.realm.to_uppercase();
            let mut inner = String::new();
            for other in realms {
                let other_upper = other.realm.to_uppercase();
                if other_upper != upper {
                    inner.push_str(&format!("        {other_upper} = .\n"));
                }
            }
            if !inner.is_empty() {
                capaths_section.push_str(&format!("    {upper} = {{\n{inner}    }}\n"));
            }
        }
    }

    let capaths_block = if capaths_section.is_empty() {
        String::new()
    } else {
        format!("\n[capaths]\n{capaths_section}")
    };

    let conf = format!(
        r#"[libdefaults]
    default_realm = {default_upper}
    dns_lookup_realm = false
    dns_lookup_kdc = false
    forwardable = true
    ticket_lifetime = {ticket_lifetime}
    renew_lifetime = {renew_lifetime}

[realms]
{realms_section}
[domain_realm]
{domain_realm_section}{capaths_block}
"#
    );

    if let Some(parent) = Path::new(output_path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(output_path, &conf)?;

    let realm_names: Vec<_> = realms.iter().map(|r| r.realm.to_uppercase()).collect();
    tracing::info!(
        "Wrote krb5.conf with {} realm(s) [{}] → {output_path}",
        realms.len(),
        realm_names.join(", ")
    );
    Ok(())
}

/// Backward-compatible single-realm helper (delegates to multi).
pub fn write_krb5_conf(
    realm: &str,
    kdcs: &[String],
    admin_server: &str,
    ticket_lifetime: &str,
    renew_lifetime: &str,
    output_path: &str,
) -> anyhow::Result<()> {
    let rc = RealmConfig {
        realm: realm.to_string(),
        kdcs: kdcs.to_vec(),
        admin_server: admin_server.to_string(),
        ticket_lifetime: ticket_lifetime.to_string(),
        renew_lifetime: renew_lifetime.to_string(),
        is_default: true,
    };
    write_krb5_conf_multi(&[rc], output_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_newline() {
        assert!(sanitize_krb5_value("REALM\ninjected", "realm").is_err());
    }

    #[test]
    fn sanitize_rejects_carriage_return() {
        assert!(sanitize_krb5_value("REALM\rinjected", "realm").is_err());
    }

    #[test]
    fn sanitize_rejects_braces() {
        assert!(sanitize_krb5_value("REALM{}", "realm").is_err());
        assert!(sanitize_krb5_value("REALM[x]", "realm").is_err());
    }

    #[test]
    fn sanitize_rejects_comment_chars() {
        assert!(sanitize_krb5_value("REALM#comment", "realm").is_err());
        assert!(sanitize_krb5_value("REALM;comment", "realm").is_err());
    }

    #[test]
    fn sanitize_allows_valid_values() {
        assert!(sanitize_krb5_value("EXAMPLE.COM", "realm").is_ok());
        assert!(sanitize_krb5_value("kdc.example.com", "kdc").is_ok());
        assert!(sanitize_krb5_value("24h", "ticket_lifetime").is_ok());
        assert!(sanitize_krb5_value("7d", "renew_lifetime").is_ok());
    }

    #[test]
    fn write_single_realm() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("krb5.conf");
        let path_str = path.to_str().unwrap();

        write_krb5_conf(
            "EXAMPLE.COM",
            &["kdc1.example.com".into(), "kdc2.example.com".into()],
            "admin.example.com",
            "24h",
            "7d",
            path_str,
        )
        .unwrap();

        let content = std::fs::read_to_string(path_str).unwrap();
        assert!(content.contains("default_realm = EXAMPLE.COM"));
        assert!(content.contains("kdc = kdc1.example.com"));
        assert!(content.contains("kdc = kdc2.example.com"));
        assert!(content.contains("admin_server = admin.example.com"));
        assert!(content.contains("ticket_lifetime = 24h"));
        assert!(content.contains("renew_lifetime = 7d"));
    }

    #[test]
    fn write_multi_realm_includes_capaths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("krb5.conf");
        let path_str = path.to_str().unwrap();

        let realms = vec![
            RealmConfig {
                realm: "ALPHA.COM".into(),
                kdcs: vec!["kdc.alpha.com".into()],
                admin_server: "admin.alpha.com".into(),
                ticket_lifetime: "24h".into(),
                renew_lifetime: "7d".into(),
                is_default: true,
            },
            RealmConfig {
                realm: "BETA.COM".into(),
                kdcs: vec!["kdc.beta.com".into()],
                admin_server: "admin.beta.com".into(),
                ticket_lifetime: "12h".into(),
                renew_lifetime: "3d".into(),
                is_default: false,
            },
        ];

        write_krb5_conf_multi(&realms, path_str).unwrap();

        let content = std::fs::read_to_string(path_str).unwrap();
        assert!(content.contains("default_realm = ALPHA.COM"));
        assert!(content.contains("ALPHA.COM = {"));
        assert!(content.contains("BETA.COM = {"));
        assert!(content.contains("[capaths]"));
    }

    #[test]
    fn write_empty_realms_removes_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("krb5.conf");
        let path_str = path.to_str().unwrap();

        // Create the file first
        std::fs::write(path_str, "placeholder").unwrap();
        assert!(path.exists());

        write_krb5_conf_multi(&[], path_str).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn write_rejects_injected_realm() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("krb5.conf");
        let path_str = path.to_str().unwrap();

        let result = write_krb5_conf(
            "EVIL\n[logging]",
            &["kdc.example.com".into()],
            "admin.example.com",
            "24h",
            "7d",
            path_str,
        );
        assert!(result.is_err());
    }
}
