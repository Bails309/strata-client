# Strata-protocol fuzz harness

[`cargo-fuzz`](https://rust-fuzz.github.io/book/cargo-fuzz.html) targets
covering every input the DMZ accepts from an untrusted peer:

| Target | What it fuzzes |
|---|---|
| `handshake_hello`     | The first frame the internal node sends. JSON parser must not crash on any byte sequence. |
| `handshake_challenge` | DMZ → internal nonce frame. |
| `edge_header_verify`  | The HMAC verifier. Headers map + MAC string come from the input. |
| `frame_decoder`       | Length-prefixed framing. Confirms `MAX_FRAME_PAYLOAD` rejects oversized lengths without allocating. |

This crate is **detached from the workspace** because `libfuzzer-sys`
needs nightly + a custom profile, and we don't want either to
contaminate `cargo build` for the main tree.

## Run locally

```bash
rustup install nightly
cargo +nightly install cargo-fuzz

cd crates/strata-protocol/fuzz
cargo +nightly fuzz run handshake_hello -- -max_total_time=60
cargo +nightly fuzz run handshake_challenge -- -max_total_time=60
cargo +nightly fuzz run edge_header_verify -- -max_total_time=60
cargo +nightly fuzz run frame_decoder -- -max_total_time=60
```

## CI

The nightly CI lane runs each target for 5 minutes. Crashes write
`crates/strata-protocol/fuzz/artifacts/<target>/crash-*` and fail the
build. Add the artifact to `corpus/<target>/` to lock the regression
in once it's fixed.
