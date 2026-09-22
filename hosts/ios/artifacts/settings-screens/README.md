# settings-screens — human evidence for the settings screens (T-0035)

Human evidence ONLY (the repo's acceptance bar is logs — AGENTS.md rule 7;
the machine assertions for everything below live in
`hosts/ios/artifacts/b4-write-live/` and
`runtime/spike/artifacts/macos-cli-settings-surfaces/`). Captured 2026-09-22
on the `dsh-iphone` simulator, Release serving seat (`-dsh-mode
session-write`), driven by label through WDA (`tools/e2e/ios-ui.py`).

| File | What it shows |
| --- | --- |
| `screens/01-settings-open.png` | The settings dialog on a ~390pt phone: near-full-bleed (zero radius, edge-to-edge — upstream's stock panel is a fixed 800px desktop modal with a 188px side nav), section nav as a horizontal chip row (通用设置/模型/内置插件/Agent 预设/已归档会话), readable controls. This is the carrier §1.5 `style` row patch (≤1024 near-full-bleed, ≤560 full-bleed + horizontal chip nav), structurally scoped so upstream re-pins cannot break it. |
| `screens/02-plugins-panel.png` | The 内置插件 section open. The panel shell's own loads now answer (`session/modelCatalog` forwarded — the subagent model-selection card renders instead of erroring). The remaining 警告/正在加载 cards in frame belong to features this host serves as honestly-unavailable or lazily loading, not to the plugin list transport. |

`app-stdout.log` is the session's structured runtime log: it records
`agentPresets/list → forwarded` and the claim frame carrying
`pluginInventory/list`, `pluginManager/listBundles|listPlugins`,
`credentials/describe`, `session/modelCatalog` — the surfaces whose DATA
correctness is asserted one-to-one by the b4 drive (46/46) on this same
build.

Known capture limitation (honest): WDA label taps could not switch the
in-section tab to the plugin-inventory list or to the Agent 预设 roster
panel (the chip-row tap coordinates hit the scroll container), so no frame
of those two lists exists here — their content is asserted by logs only
(`settings.preset.roster` presets=standard/ptc/minimal/cordis;
`settings.plugin.inventory` entries=74).
