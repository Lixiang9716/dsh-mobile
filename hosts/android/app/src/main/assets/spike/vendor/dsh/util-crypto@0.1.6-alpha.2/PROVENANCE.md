# Provenance — @deepseek-ai/dsh-util-crypto 0.1.6-alpha.2

- Upstream: DSH runtime, vendored by dsh-desktop at
  `vendor/dsh-runtime/0.1.6-alpha.2/deepseek-ai-dsh-util-crypto-0.1.6-alpha.2.tgz`
- Version: 0.1.6-alpha.2
- tgz sha256: 71ef6845f82a76ec058d405ca1c15c0f410e609216eb01dd9cc4873255af4d91
- License: MIT (vendored `LICENSE` is upstream's)
- Files: the unpacked tarball VERBATIM (`package.json`, `lib/`, `LICENSE`,
  source maps of its own). No local modifications — the quickjs shim layer
  (`runtime/spike/upstream/shims/`) provides the node/Web-API seams the
  package needs; adaptation lives in the shim, never in the vendored copy
  (D6 upstream discipline).
- Re-fetch: `runtime/spike/vendor/ensure-dsh.sh` (pin table above sha).
