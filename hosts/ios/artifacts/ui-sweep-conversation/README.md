# ui-sweep-conversation — the conversation view's controls, exercised

The same sweep as [`../ui-sweep/`](../ui-sweep/) (same command, same checklist
schema), run against a conversation that contains a real model turn with one
tool call, so the transcript, the tool-call section and the trajectory tab are
all present.

```sh
tools/e2e/ios-ui.py sweep hosts/ios/artifacts/ui-sweep-conversation
```

## Result

60 control activations, 35 with a visible effect, across the transcript (the
tool-call section, 系统提示词, 复制, 点赞/点踩, 分支, the storage and clock
actions), the `对话` / `轨迹` tabs, the trajectory toolbar (使用实际时长,
收起所有轮次, 展开所有轮次, 收起所有调用, 展开所有调用, 搜索轨迹, 轨迹工具栏),
the session header (the session row, 0 个子代理, 更多操作, 重试恢复终端) and the
dock/panel controls (分栏, 退出全屏, 开始/关闭).

Rows whose frame is off-screen (the tree reports negative coordinates for
content scrolled above the viewport) are recorded as
`skipped: off-screen (needs scrolling)` rather than given a verdict: a press
there would land on whatever sits at that edge.

## The screenshots committed here

The checklist is the audit surface; this directory keeps the receipts for the
controls the notes cite — `17-更多操作-*.png`, `30-轨迹-*.png`,
`32-使用实际时长-*.png`, `33-收起所有轮次-*.png`, `37-搜索轨迹-*.png`. The full
set is ~60 pairs and regenerates with the command above.

## Defect found here

With the session sidebar open, the plugins panel collapses to roughly one
character wide and its text wraps vertically — the layout does not adapt two
panes to a 402pt-wide phone screen. The same panel renders correctly with the
sidebar closed (see `../ui-sweep/15-插件-*.png`). This is in the vendored
official client (D6: not editable here), so it is an upstream report.
