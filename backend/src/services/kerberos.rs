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

/// Generate a krb5.conf that contains all configured realms and write it out.
pub fn write_krb5_conf_multi(realms: &[RealmConfig], output_path: &str) -> anyhow::Result<()> {
    if realms.is_empty() {
        // Remove the file if no realms are configured
        let _ = std::fs::remove_file(output_path);
        tracing::info!("No Kerberos realms configured — removed {output_path}");
        return Ok(());
    }

    // The default realm is whichever is flagged, or the first one
    let default = realms
        .iter()
        .find(|r| r.is_default)
        .unwrap_or(&realms[0]);

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
