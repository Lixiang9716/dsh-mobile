# Agent Note: the fs-watch StatWatcher rides the mutation registry — the idle timerSchedule flood dies (P3)

Status: implemented

## Problem

The device idles at ~53 gateway timer arms per second: 40 idle minutes
after the creation-mode pomodoro boot measured 126,977 `timerSchedule` +
17,707 `timerCancel` round trips, gateway debug lines crowding 95% of the
carrier capture and flushing the hilog ring buffer down to seconds of
history. The feed is the vendored skill plane: the deployment-default
preset join (T-0048) mounts it, `@deepseek-ai/dsh-skill-filesystem`
opens one ANCESTOR `watchFile` per missing skill root (up to 5:
`.dsh/skills`, `.agents/skills`, home variants, the custom dir) at the
default `watchPollIntervalMs=100`, and our
`shims/loader-faces-fs-watch.js` implemented node's `watchFile` as an
unconditional `setInterval(callerInterval)` poll — one gateway
`timerSchedule` round trip per tick per watcher, forever, while detecting
nothing: the workspace VFS stats every directory with `mtimeMs` 0, so an
ancestor directory's fingerprint NEVER moves. Measured node-side at the
same registration shape (3 × `watchFile(path, {interval: 100})`, 3s
window): 85 arms (28.3/s), zero detections. The poll is also a D8
violation standing alone — wall-clock polling where an event source
exists.

## Decision

`watchFile` change detection is now event-driven for paths inside the
writable workspace (D8: a write IS the event). The watcher subscribes to
the workspace mutation registry (`fs-workspace`'s `wsWatch` — the same
seam the chokidar linkage shim rides), whose exact-path notify re-stats
synchronously inside the mutation, and the wall-clock poll degrades to a
slow SAFETY NET (`max(interval, 5s)`) whose only remaining job is
mutations the registry cannot see — out-of-band real-disk writes by child
processes, which `statSync`'s real-disk fallback observes. To feed it,
the one mutating arm that never notified now does:
`fs-workspace-write`'s `mkdirSegments` calls `notifyWatches(dir)` per
created segment — the vendored ancestor watcher watches the MISSING root
path itself (`join(anchor, firstSegment)`), so the mkdir of that path is
precisely the event it waits for. Paths OUTSIDE the workspace (the seeded
test worlds, real-disk faces) keep the caller's interval verbatim — no
registry exists over those worlds and the differential spec's cadence
must stay node's. Node-side metric (ci/fs-watch-idle-probe.mjs, the
reproducible gauge): 85 → 1 arms per 3s window at the device's
registration shape, with the four file stat transitions
(missing→created→changed→removed) still detected and mkdir of the watched
path now heard.

## Alternatives considered

- Coalesce/batch timers at the gateway seam (host side): rejected — it
  treats every consumer's symptom, leaves the polling semantics (a D8
  violation and a 10×/s-per-watcher runtime wake) standing, and adds seam
  complexity the contract (v1.4.0 one-shot timers) does not carry.
- Patch the vendored `dsh-skill-filesystem` to a longer poll interval:
  rejected twice over — upstream discipline (D6: never vendor modified
  copies), and the 100ms-poll + deadline-fuse-per-await pattern is
  upstream-wide (`dsh-timeout` arms one `setTimeout` per `deadline()`),
  so it belongs in an upstream issue against deepseek-ai/deepseek-harness
  (filed alongside this change), not a local fork.
- Keep polling but only raise the workspace floor to 5s (no registry
  ride): rejected — still burns arms at idle and still detects real
  workspace writes seconds late when the exact-path event source already
  exists and is faster than any poll.
