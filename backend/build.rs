use std::fs;

fn main() {
    // Read the canonical version from the repo-root VERSION file.
    // During Docker builds the file is copied into the build context.
    let version = fs::read_to_string("VERSION")
        .or_else(|_| fs::read_to_string("../VERSION"))
        .unwrap_or_else(|_| String::from("0.0.0-unknown"));
    let version = version.trim();
    println!("cargo:rustc-env=STRATA_VERSION={version}");
    println!("cargo:rerun-if-changed=VERSION");
    println!("cargo:rerun-if-changed=../VERSION");
}
