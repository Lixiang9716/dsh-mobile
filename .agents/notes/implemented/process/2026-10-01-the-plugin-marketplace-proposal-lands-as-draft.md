# Agent Note: The plugin marketplace proposal lands as a draft

Status: implemented

## Problem

The registry is one of the four named gaps toward the product identity (an
app with no predefined identity), and the owner asked for a marketplace
survey before any design. The survey (2026-10-01) compared full marketplace
backends (Open VSX, Flathub), registry kernels (Verdaccio, cnpmcore), and
signed-distribution precedents (F-Droid, Accrescent), and surfaced a fact
that changes the shape of the work: the DSH package format is already frozen
(data-protocols v1.0.0) and the M3 installer already consumes a trust record
that its own header describes as standing in for "the signed catalog a real
installer consults". The gap is therefore not a marketplace platform — it is
a signed catalog.

## Decision

The owner decided (2026-10-01): the marketplace is the mobile-side dsh
plugin marketplace, and the plugin format is exactly the existing DSH
package format. This PR lands the D5 draft (data-protocols v1.1.0 candidate):
a signed static `index.json` (ed25519, repo/CI-held keys, dual-signed
rotation window) whose entries carry the installer's existing
`blobSha256`/`manifestSha256` trust record verbatim; one new seam (the
resolver — lookup + verify + cache policy) feeding the UNCHANGED
`installFromFetch`/`install-pipeline`; grants stay install-time capability
negotiation in the frozen pipeline. v0 has no resident service and no user
accounts; Verdaccio (v1, publish API — the DSH tarball is npm-shaped) and an
OIDC IdP with an Open VSX-style review model (v2) are named evolution, not
design.

## Alternatives considered

- Deploying Open VSX or Flathub now: rejected — heavy server stacks bound to
  their own package metadata models, while ours is frozen elsewhere and the
  installer seam already exists; their publisher/review models are worth
  copying at v2, the servers are not.
- Adopting the npm registry protocol as the package format: unnecessary — the
  frozen format is already tarball+manifest shaped; Verdaccio compatibility
  survives as a v1 deployment option regardless.
- An unsigned catalog trusting transport only (HTTPS): rejected — it makes
  the hosting account the single point of compromise; the signature layer
  keeps trust in the repo/CI, out of any server.
