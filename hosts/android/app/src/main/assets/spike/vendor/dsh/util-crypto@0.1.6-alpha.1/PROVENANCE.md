# Provenance — @deepseek-ai/dsh-util-crypto 0.1.6-alpha.1

- Upstream: DSH runtime, vendored by dsh-desktop at
  `vendor/dsh-runtime/0.1.6-alpha.1/deepseek-ai-dsh-util-crypto-0.1.6-alpha.1.tgz`
  (source repo per package.json: github.com/deepseek-ai/deepseek-harness,
  `packages/util/crypto`)
- Version: 0.1.6-alpha.1
- tgz sha256: 50c13f54ed665be0fb84132d61c502c7fe8cf3f7bf082c526628b5faf10b800c
- License: MIT (vendored `LICENSE` is upstream's)
- Files: verbatim `package.json`, `LICENSE`, `lib/index.js`,
  `lib/types/index.d.ts`. No local modifications — the quickjs-ng shim
  provides the Web-API seams the package needs (`crypto.getRandomValues`,
  `btoa`) instead of touching upstream code (upstream discipline: adapt in
  the shim, never edit the vendored copy).
