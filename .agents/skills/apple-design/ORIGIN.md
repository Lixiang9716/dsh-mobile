# Origin

Vendored agent skill, per the repo's pinned-copy discipline:

- Upstream: https://github.com/dickwu/apple-design-skill
- Pinned commit: 904b0eedc7cc778152f545506075d5bb5219ce77 (pulled 2026-10-03)
- Contents: SKILL.md (the review workflow), references/ (123 HIG pages
  pulled from developer.apple.com by the upstream script — Apple Inc.
  copyright, reproduced with source links per upstream's own notice),
  scripts/pull-hig.mjs (regenerates references/ from the live site).
- Upstream license notice (README.md "Origin and license"): the guideline
  text belongs to Apple Inc.; the skill is not affiliated with or endorsed
  by Apple; provided as is. The upstream repo ships no OSS license file —
  treat as pinned vendor evidence, not redistributable product code.
- Refresh: re-clone upstream, copy the same four paths, update this file,
  and run scripts/pull-hig.mjs only if the reference set needs regenerating.
