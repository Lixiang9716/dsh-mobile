# dsh-mobile

English | [简体中文](README.zh.md)

A **mobile host** for the DSH (DeepSeek Harness) ecosystem. Built on the community Fabric interoperability model, dsh-mobile makes mobile a first-class peer host of the Harness runtime: a QuickJS single-threaded coroutine runtime carries the Harness core, iOS system capabilities are wrapped as a three-layer stack (privileged layer / capability gateway / system implementation plugins), and the UI itself is a pluggable Web Client plugin.

> Community project, not an official DeepSeek product. Upstream ecosystem: [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) and the DSH Community Fabric draft RFCs.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — layered design, key technical decisions, milestones

## Milestones

| Phase | Scope | Status |
| --- | --- | --- |
| M0 | Primitive contract v0 + data protocols (bundle layout / manifest / receipt) | Done (frozen v1.0.0) |
| M1 | Spikes: quickjs-ng shim over upstream pure-logic packages + iOS host skeleton + local carrier | Done (runtime spike verified on iOS/Android/HarmonyOS + macOS; local carrier — loopback static files + WS↔QuickJS pump — verified on the iOS simulator) |
| M2 | System implementation plugins (fs/subprocess/ui) + Web Client mount + first on-device session | Planned |
| M3 | Plugin install pipeline + UI pluggability (slot / Web Client swap) | Planned |
| M4 | Android host (QuickJS-isomorphic) | Planned |
| M5 | HarmonyOS host (ArkTS + NAPI) | Planned |

## Governance

This repository is gated by [govrail](https://github.com/Lixiang9716/govrail): pre-commit content gates, a `gov run` gate DAG before push, CI enforcement (`.github/workflows/gov.yml`), and the `agent-heavy` preset for multi-agent development. Run `gov --help` (installed via `pip install govrail`; entry point is `gov`).

## License

MIT
