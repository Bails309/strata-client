use std::path::Path;

/// Generate a krb5.conf file and write it to the shared volume.
pub fn write_krb5_conf(
    realm: &str,
    kdcs: &[String],
    admin_server: &str,
    ticket_lifetime: &str,
    renew_lifetime: &str,
    output_path: &str,
) -> anyhow::Result<()> {
    let realm_upper = realm.to_uppercase();
    let realm_lower = realm.to_lowercase();

    let kdc_lines: String = kdcs
        .iter()
        .map(|k| format!("        kdc = {k}"))
        .collect::<Vec<_>>()
        .join("\n");

    let conf = format!(
        r#"[libdefaults]
    default_realm = {realm_upper}
    dns_lookup_realm = false
    dns_lookup_kdc = false
    forwardable = true
    ticket_lifetime = {ticket_lifetime}
    renew_lifetime = {renew_lifetime}

[realms]
    {realm_upper} = {{
{kdc_lines}
        admin_server = {admin_server}
    }}

[domain_realm]
    .{realm_lower} = {realm_upper}
    {realm_lower} = {realm_upper}
"#
    );

    if let Some(parent) = Path::new(output_path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(output_path, conf)?;

    tracing::info!("Wrote krb5.conf for realm {realm_upper} → {output_path}");
    Ok(())
}
