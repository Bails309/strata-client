#!/usr/bin/env bash
# Has the ironrdp upgrade unblocked yet?
#
# `ironrdp-connector` 0.8+ reaches `picky`, which pins
# `curve25519-dalek = "=5.0.0-rc.1"`. Every `russh` that carries the
# RUSTSEC-2026-0154 fix (>=0.60.3) needs `^5`, which resolves to 5.0.0
# stable. Cargo cannot hold two 5.x versions, so the two engines do not
# resolve together. See docs/adr/ADR-0015-native-rust-session-engine.md.
#
# Exit 0  -> the conflict has cleared; follow the unblock procedure in the ADR.
# Exit 1  -> still blocked (expected).
#
# Deliberately resolves in a throwaway crate rather than editing the
# workspace: this answers "can it?" without disturbing Cargo.lock.

set -uo pipefail

IRONRDP="${IRONRDP_VERSION:-0.10}"
RUSSH="${RUSSH_VERSION:-0.63}"

probe_dir="$(mktemp -d)"
trap 'rm -rf "$probe_dir"' EXIT

mkdir -p "$probe_dir/src"
echo 'fn main() {}' > "$probe_dir/src/main.rs"
cat > "$probe_dir/Cargo.toml" <<EOF
[package]
name = "ironrdp-unblock-probe"
version = "0.0.0"
edition = "2021"

[dependencies]
ironrdp-connector = "$IRONRDP"
russh = { version = "$RUSSH", default-features = false, features = ["ring", "flate2"] }
EOF

echo "Probing ironrdp-connector $IRONRDP against russh $RUSSH ..."
if output=$(cd "$probe_dir" && cargo generate-lockfile 2>&1); then
  dalek=$(grep -A1 'name = "curve25519-dalek"' "$probe_dir/Cargo.lock" | grep version | head -1 | tr -d ' "' | cut -d= -f2)
  russh_resolved=$(grep -A1 'name = "russh"' "$probe_dir/Cargo.lock" | grep version | head -1 | tr -d ' "' | cut -d= -f2)

  # A resolving-but-vulnerable russh is the trap this check exists to catch.
  if [ "$(printf '%s\n0.60.3\n' "$russh_resolved" | sort -V | head -1)" != "0.60.3" ]; then
    echo "STILL BLOCKED: resolves only by selecting russh $russh_resolved,"
    echo "which is below the RUSTSEC-2026-0154 fix (>=0.60.3)."
    exit 1
  fi

  echo "UNBLOCKED: ironrdp $IRONRDP resolves with russh $russh_resolved (dalek $dalek)."
  echo "Follow the unblock procedure in docs/adr/ADR-0015-native-rust-session-engine.md."
  exit 0
fi

echo "Still blocked:"
echo "$output" | grep -m1 'failed to select a version for' || echo "$output" | tail -5
exit 1
