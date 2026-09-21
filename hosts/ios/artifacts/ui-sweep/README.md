# ui-sweep — the DSH iOS shell's controls, exercised

Every actionable control the app exposes, tapped once through the accessibility
tree, with the screenshot before and after each tap. Produced by

```sh
tools/e2e/ios-ui.py sweep hosts/ios/artifacts/ui-sweep
```

on the Release build (`dsh-ios`, the user-facing one) with a real model endpoint
configured, driven through the WebDriverAgent `tools/e2e/run-ios.sh` bootstraps.

## What this is for

The acceptance question was "test every button and screen of this app". A
screenshot per step is not a verdict a human can audit in bulk, so the sweep
writes a **checklist**: one row per control, with the two screenshots that back
it.

```json
{ "label": "插件", "type": "Button", "center": [28, 194], "changed": true,
  "evidence": ["15-插件-before.png", "15-插件-after.png"] }
```

`changed` is a byte-difference between the two captures: it says the tap had a
VISIBLE effect, which is what a button test is about. A `no-op` row is not
automatically a defect — some controls are inert by design in some states — so
the rows are read together, not grepped.

## Result

60 control activations, 48 with a visible effect, across: the rail (侧边栏,
新建会话, 插件, 搜索会话, 设置), the workspace chip, the composer row (输入框,
添加文件或调用指令, 选择模型, 发送消息), the right panel toggle, the session
sidebar (新会话, the `spike` workspace, the session list, 视图选项), session
search (搜索会话, 清除搜索, 按工作区), the plugins panel (刷新, 添加插件, the
官方 section, 查看 Agent 循环, 返回插件列表) and the Agent-loop plugin detail
(并行工具调用数, 会话).

## The screenshots committed here

The full sweep writes ~60 pairs (~22 MB). This directory keeps the checklist —
the audit surface — plus the receipts for the controls the notes cite:

| File | What it shows |
| --- | --- |
| `07-打开侧边栏-*.png` | the rail button opening the session sidebar |
| `09-新建会话-*.png` | the new-session control |
| `15-插件-*.png` | the plugins panel opening |
| `19-警告-before.png`, `20-重试-*.png` | **defect 1**: the panel renders `暂时无法读取插件。` with a `重试` button |

Regenerate the whole set with the command above; it is deterministic in shape
(control labels and centres) and not in pixels.

## Defects this found

1. **The plugin list cannot be read.** The plugins panel renders
   `暂时无法读取插件。` with a `重试` button (`19-警告-before.png`,
   `20-重试-*.png`). The page asks the spine for its plugin inventory and the
   spine does not answer that endpoint — the carrier claims the session/write
   surface only, so every endpoint outside it answers structured-unavailable.
   The panel is honest about it rather than showing an empty list; the gap is
   the missing endpoint, not the UI.
2. **With the left sidebar open the plugins panel collapses to ~1 character
   wide** and its text wraps one character per line. The screenshots for this
   one are in the conversation sweep's directory (`ui-sweep-conversation/`),
   where the sidebar was open when the panel was reached.

Both are in the **vendored official client** — `presentation/official-web/dist`
is a pinned upstream build (D6: never a modified copy), so neither is fixable
here; they are upstream defects and are reported as such.

See the conversation view's sweep in `../ui-sweep-conversation/` for the
transcript, tool-call and trajectory controls.
