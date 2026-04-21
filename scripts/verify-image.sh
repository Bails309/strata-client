#!/usr/bin/env bash
# verify-image.sh — supply-chain verification for a signed, attested Strata image.
#
# Implements the consumer side of Coding Standards §13.7 / W1-14. Any
# deployment pipeline MUST invoke this script against the exact digest it is
# about to roll out, and MUST abort the rollout if it exits non-zero.
#
# Verifies:
#   1. The image digest is signed by the expected GitHub Actions workflow
#      identity via Cosign keyless (Sigstore Fulcio + Rekor transparency log).
#   2. A CycloneDX SBOM in-toto attestation is present and signed by the same
#      identity.
#   3. SLSA Level 3 build provenance is present, signed by the same identity,
#      and names the expected source repository as the builder.
#
# Usage:
#   ./scripts/verify-image.sh <image-ref-with-digest>
# Example:
#   ./scripts/verify-image.sh ghcr.io/acme/strata-client/backend@sha256:<digest>
#
# Requires: cosign >= 2.2 and slsa-verifier >= 2.5 in PATH.

set -euo pipefail

IMAGE="${1:-}"
if [[ -z "${IMAGE}" ]]; then
  echo "usage: $0 <image-ref-with-digest>" >&2
  exit 2
fi

if [[ "${IMAGE}" != *"@sha256:"* ]]; then
  echo "ERROR: image reference must pin a digest (@sha256:...); got: ${IMAGE}" >&2
  exit 2
fi

# Expected identity — the GitHub Actions workflow that produced the image.
# Override via environment to verify a fork or a moved repo.
EXPECTED_REPO="${EXPECTED_REPO:-$(echo "${IMAGE}" | awk -F/ '{print $2"/"$3}')}"
EXPECTED_ISSUER="${EXPECTED_ISSUER:-https://token.actions.githubusercontent.com}"
EXPECTED_IDENTITY_REGEXP="${EXPECTED_IDENTITY_REGEXP:-^https://github.com/${EXPECTED_REPO}/\\.github/workflows/release\\.yml@refs/tags/v.*$}"

for bin in cosign slsa-verifier; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "ERROR: required tool '${bin}' not found in PATH" >&2
    exit 2
  fi
done

echo "▶ Verifying ${IMAGE}"
echo "  expected repo:     ${EXPECTED_REPO}"
echo "  expected issuer:   ${EXPECTED_ISSUER}"
echo "  expected identity: ${EXPECTED_IDENTITY_REGEXP}"
echo

echo "── 1/3 cosign verify (signature) ──"
cosign verify "${IMAGE}" \
  --certificate-identity-regexp="${EXPECTED_IDENTITY_REGEXP}" \
  --certificate-oidc-issuer="${EXPECTED_ISSUER}" \
  >/dev/null
echo "  ✓ signature OK"
echo

echo "── 2/3 cosign verify-attestation (CycloneDX SBOM) ──"
cosign verify-attestation "${IMAGE}" \
  --type=cyclonedx \
  --certificate-identity-regexp="${EXPECTED_IDENTITY_REGEXP}" \
  --certificate-oidc-issuer="${EXPECTED_ISSUER}" \
  >/dev/null
echo "  ✓ SBOM attestation OK"
echo

echo "── 3/3 slsa-verifier (SLSA L3 provenance) ──"
slsa-verifier verify-image "${IMAGE}" \
  --source-uri "github.com/${EXPECTED_REPO}" \
  --source-tag "$(echo "${IMAGE}" | sed -E 's/.*:v([^@]*)@.*/v\1/')" \
  >/dev/null 2>&1 || \
slsa-verifier verify-image "${IMAGE}" \
  --source-uri "github.com/${EXPECTED_REPO}"
echo "  ✓ SLSA provenance OK"
echo

echo "✓ ${IMAGE} passed all supply-chain checks."
