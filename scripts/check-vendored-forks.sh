#!/usr/bin/env bash
# Can we drop any of the vendored forks yet?
#
# Every fork in crates/vendor/ is a liability: it pins us to a snapshot of
# someone else's code, outside the crates.io supply chain, and it silently
# stops receiving upstream fixes. Each one exists for a specific, narrow
# reason, and each should be deleted the moment upstream catches up.
#
# Run this on every dependency bump, and before every release. It answers
# one question per fork: is the reason it exists still true?
#
# Exit 0 -> at least one fork can go. Exit 1 -> all still needed.
# See docs/adr/ADR-0015-native-rust-session-engine.md.

set -uo pipefail

droppable=0

# ── Fork 1: ironrdp-connector ────────────────────────────────────────────
#
# Stock `ironrdp-connector` pins `picky = "=7.0.0-rc.25"`, and rc.25 pins
# `curve25519-dalek = "=5.0.0-rc.1"`. Every `russh` carrying the
# RUSTSEC-2026-0154 fix (>=0.60.3) needs `^5`, which resolves to 5.0.0
# stable, and Cargo cannot hold two 5.x versions. `picky` rc.26 already
# admits 5.0.0 stable; the fork only moves the connector onto it.
#
# The fork can go when a published `ironrdp-connector` resolves against a
# patched `russh` on its own.
#
# It now also carries two behaviour patches, which this probe cannot see.
# Both have to be upstreamed or reapplied before the fork is deleted:
#   * advertises SUPPORT_DYN_VC_GFX_PROTOCOL, without which the server
#     never opens the graphics pipeline channel;
#   * drops SUPPORT_NET_CHAR_AUTODETECT, which we advertise but only half
#     implement, leaving Windows retrying bandwidth measurement forever.
IRONRDP="${IRONRDP_VERSION:-0.10}"
RUSSH="${RUSSH_VERSION:-0.63}"

probe_dir="$(mktemp -d)"
trap 'rm -rf "$probe_dir"' EXIT

mkdir -p "$probe_dir/src"
echo 'fn main() {}' > "$probe_dir/src/main.rs"
cat > "$probe_dir/Cargo.toml" <<EOF
[package]
name = "fork-probe"
version = "0.0.0"
edition = "2021"

[dependencies]
ironrdp-connector = "$IRONRDP"
russh = { version = "$RUSSH", default-features = false, features = ["ring", "flate2"] }
EOF

echo "== fork 1: crates/vendor/ironrdp-connector =="
echo "   probing stock ironrdp-connector $IRONRDP against russh $RUSSH ..."
if (cd "$probe_dir" && cargo generate-lockfile >/dev/null 2>&1); then
  russh_resolved=$(grep -A1 'name = "russh"' "$probe_dir/Cargo.lock" \
    | grep version | head -1 | tr -d ' "' | cut -d= -f2)

  # A resolving-but-vulnerable russh is the trap this check exists to catch.
  if [ "$(printf '%s\n0.60.3\n' "$russh_resolved" | sort -V | head -1)" != "0.60.3" ]; then
    echo "   STILL NEEDED: resolves only by selecting russh $russh_resolved,"
    echo "   which is below the RUSTSEC-2026-0154 fix (>=0.60.3)."
  else
    echo "   CAN BE DROPPED: stock connector resolves with russh $russh_resolved."
    echo "   First reapply or upstream the GFX and auto-detect capability patches."
    droppable=1
  fi
else
  echo "   STILL NEEDED: stock connector does not resolve beside russh $RUSSH."
fi

# ── Fork 2: sspi ─────────────────────────────────────────────────────────
#
# sspi 0.22.0 added an equality check on the SPNEGO mechListMIC sequence
# number. Windows RDP hosts send that MIC with seq_num 0, so the check
# rejects every Kerberos NLA session -- before the MIC checksum, the part
# that actually carries the downgrade protection, is ever verified.
#
# The fork can go when a published sspi no longer contains the check.
echo
echo "== fork 2: crates/vendor/sspi =="
# Queried from outside the workspace: in it, `[patch.crates-io]` makes
# cargo report our own vendored copy as the newest sspi there is.
outside="$(mktemp -d)"
version_line=$(cd "$outside" && cargo info sspi 2>/dev/null | grep -m1 '^version:')
rm -rf "$outside"
latest=$(printf '%s' "$version_line" \
  | sed -E 's/.*\(latest ([^)]+)\).*/\1/; t; s/^version: *//' \
  | tr -d ' ')
if [ -z "$latest" ]; then
  echo "   could not determine the latest sspi version; check by hand."
else
  echo "   latest published sspi: $latest"
  src_dir="$(mktemp -d)"
  if curl -sfL "https://static.crates.io/crates/sspi/sspi-$latest.crate" \
       -o "$src_dir/s.tgz" && tar xzf "$src_dir/s.tgz" -C "$src_dir"; then
    if grep -rq "invalid MIC token sequence number" "$src_dir/sspi-$latest/src/"; then
      echo "   STILL NEEDED: sspi $latest still rejects on the MIC sequence number."
    else
      echo "   CAN BE DROPPED: sspi $latest no longer has the MIC sequence check."
      droppable=1
    fi
  else
    echo "   could not fetch sspi $latest; check by hand."
  fi
  rm -rf "$src_dir"
fi

# ── Fork 3: ironrdp-egfx ─────────────────────────────────────────────────
#
# Stock `ironrdp-egfx` only surfaces AVC frames once its own H.264 decoder
# has turned them into bitmaps, and builds its capability set from whether
# that decoder exists. Strata forwards the bitstream to the browser's
# WebCodecs decoder untouched, so the fork adds a handler hook that claims
# AVC frames before the decode path and advertises AVC without a decoder.
#
# The fork can go when upstream can hand out AVC frames undecoded.
echo
echo "== fork 3: crates/vendor/ironrdp-egfx =="
outside="$(mktemp -d)"
version_line=$(cd "$outside" && cargo info ironrdp-egfx 2>/dev/null | grep -m1 '^version:')
rm -rf "$outside"
latest=$(printf '%s' "$version_line" \
  | sed -E 's/.*\(latest ([^)]+)\).*/\1/; t; s/^version: *//' \
  | tr -d ' ')
if [ -z "$latest" ]; then
  echo "   could not determine the latest ironrdp-egfx version; check by hand."
else
  echo "   latest published ironrdp-egfx: $latest"
  src_dir="$(mktemp -d)"
  if curl -sfL "https://static.crates.io/crates/ironrdp-egfx/ironrdp-egfx-$latest.crate" \
       -o "$src_dir/e.tgz" && tar xzf "$src_dir/e.tgz" -C "$src_dir"; then
    # Upstream will not use our method names, so match the concept rather
    # than the spelling: a hook that hands out the encoded bitstream.
    if grep -rqiE 'passthrough|bitstream' "$src_dir/ironrdp-egfx-$latest/src/client.rs"; then
      echo "   MAY BE DROPPABLE: ironrdp-egfx $latest mentions a bitstream or"
      echo "   passthrough hook in client.rs. Read it before deleting the fork."
      droppable=1
    else
      echo "   STILL NEEDED: ironrdp-egfx $latest only yields decoded bitmaps."
    fi
  else
    echo "   could not fetch ironrdp-egfx $latest; check by hand."
  fi
  rm -rf "$src_dir"
fi

echo
if [ "$droppable" -eq 1 ]; then
  echo "At least one fork can go. Follow the un-fork procedure in"
  echo "docs/adr/ADR-0015-native-rust-session-engine.md."
  exit 0
fi
echo "All vendored forks are still required."
exit 1
