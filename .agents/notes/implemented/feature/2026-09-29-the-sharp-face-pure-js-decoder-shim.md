# Agent Note: The sharp face is a pure-JS decoder shim over the vendored pins (decision-matrix D-c)

Status: implemented
Date: 2026-09-29
Class: feature
Related: D6, D-c (decision matrix), T-0071 (ledger item 11)

## Problem

The upstream dsh-tests attachment-local family (image / index / normalization /
request-image) and tool-fs's read_image spec exercise a sharp-driven raster face —
format sniffing, header-only probes, full decodes, EXIF orientation, 16-bit depth,
resize/rotate pipelines, and a webp/jpeg/png/gif quality ladder. sharp is a native
libvips binding: it cannot ride a QuickJS closure, so on the spike leg those four
specs failed at import ("unmapped module specifier 'sharp'") and read-image ran
27/41 with all 14 saveImage-path tests failing — the ledger's "read-image 14 测试".
The owner's decision-matrix (D-c) chose vendoring pure-JS decoders over accepting
the boundary.

## Decision

- **Pins**: `jpeg-js@0.4.4` + `pngjs@5.0.0` vendored through add-package.sh
  (sha256-pinned rows in ensure-dsh.sh, mirror tarballs committed). Their bytes do
  the pixel-hard work: jpeg-js encodes and decodes entropy coding; pngjs's
  filter-parse-sync → bitmapper → format-normaliser chain does PNG unfiltering,
  bit unpacking (8/16-bit), palette and interlace handling.
- **Adapter package** `upstream/shims/sharp/` (CJS — loads through the userland
  cjs-loader on the spike, plain require elsewhere): the sharp callable + pipeline
  (metadata/rotate/resize/toColourspace/raw/stats/toBuffer), format dispatch, and
  hand-written GIF (LZW both ways), WebP (extended-format VP8X + raw ALPH + a real
  VP8 keyframe over an RFC-6386 bool codec), SVG-subset (rects + a built-in 5x7
  bitmap font), and minimal-TIFF codecs. PNG encode is filter-0 scanlines + fflate
  zlib + own chunk writer; JPEG metadata rides spliced APP1 (EXIF orientation) and
  APP14 (Adobe cmyk tag) segments. fflate 0.8.2's CJS face (`lib/index.cjs`) is the
  zlib engine.
- **Registration** (the @xterm pattern): cjs-loader `BARE_PACKAGES['sharp']` →
  `/upstream/shims/sharp` serves attachment-local's `createLazyRequire('sharp')`;
  an npm-bridges-c2 row mirrors it for the ESM spelling the four specs import.
- **Embeds**: iOS adds TREES rows for the vendored engines (upstream/shims rides
  whole-directory); harmony stages the faces in the suite-extras HAP manifest
  (suite mode only — the family is test-suite-reachable, zero product-side
  callers, so BUNDLE_FILES carries nothing); android stages the engines plus a
  subdir-aware shims mirror.
- **Documented deltas** (the honest boundaries): lossy webp output is a
  facts-preserving skeleton — dimensions/alpha/depth/colourspace exact, pixel
  detail approximated (every MB intra DC_PRED with the coefficient flag set; alpha
  carried losslessly as the spec's raw ALPH spelling; each output padded to an
  8-byte file boundary). The stream is spec-conformant: a stock libwebp decodes it
  (verified against real sharp in a scratch directory). SVG is a subset rasterizer
  (rects + bitmap text, unantialiased, metric-free). ICC/orientation metadata is
  structural presence, not profile content. webp `quality`/`effort` select nothing
  (the ladder sizes are flat).

Result on dsh-spike-cli: image 7/0, index 8/0, normalization 21/0, request-image
16/0 (DSH_DEADLINE_SECONDS=1200 — the W6-U r3 backstop raise; the spec's
QuickJS runtime exceeds the 120s default), read-image 41/0 — 93 tests, failed:0.

## Alternatives considered

- **Accept the mobile boundary** (leave the family module-gapped) — rejected by the
  owner: D-c chose vendoring; the family covers the read_image product story.
- **Vendor real sharp's JS surface + a CJS linkage stub** — rejected: sharp's JS is
  a thin launcher over the libvips binary; without the binary the stub would fake
  every face. The adapter over pure-JS codecs does the real work instead.
- **A VP8L lossless webp codec** — rejected for scope: the family never asserts
  webp pixels (only facts), and a full VP8L encoder/decoder doubles the codec
  surface for nothing the vendored callers observe. The lossy skeleton keeps the
  file valid for real decoders.
- **Node differential parity for the family** — deferred: the sweep's node leg
  still lacks sharp (a native install in test/upstream-suite is a CI-native-dep
  decision for the differential's owner). The qjs leg is the acceptance surface.

## Consequences

- The attachment-local family + read_image are green on the spike leg; the
  upstream-suite sweep's request-image row moves from TIMEOUT-OR-ERROR to
  green-under-extended-deadline (the sweep's 90s cap still claims it — a
  diagnostic-only surface).
- Embed lists grew by the vendored engines' rows; the per-host staging is suite-
  scoped on harmony, whole-dir on iOS, mirror-dir on android.
- New upstream-suite specs touching sharp get the face automatically via the bare
  rows; anything outside the documented deltas (webp pixels, SVG text fidelity)
  fails loud or honestly red.
