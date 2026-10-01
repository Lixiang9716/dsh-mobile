# Agent Note: the interactive seat's slash palette gains /goal (dsh-command-goal joins the mobile composition)

Status: implemented
Related: D9

## Problem

The interactive functional battery (2026-10-01/02, android release seat) found the
composer's "/" surface carrying exactly ONE command: `commands/list` answered only
`dsh-command-feedback`. The cause is structural, not a rendering bug: commands are
plugin-owned (boot.js's own words — "the registry carries no built-ins, so the
surface is only as rich as the plugins mounted after it"), and `mountCommandPlane`
mounted only dsh-commands + dsh-command-feedback, while the desktop composition
(`agent-presets@0.1.6-alpha.2/presets/cordis/agent.cordis.yml`) mounts two more
command plugins — command-goal and command-compact. The slash palette had nothing
to offer the mobile user.

## Decision

`runtime/spike/upstream/boot.js` mounts `@deepseek-ai/dsh-command-goal` right after
the goal plane (`mountGoalCommand`), gated on `identity.goals && identity.commands`
— the same interactive flags the user-facing seat already sends, so drive legs stay
byte-identical. The placement is forced by the inject contract: dsh-command-goal
injects `["commands", "goals"]`, and the command plane mounts BEFORE the goal plane,
so the plugin can only apply once the goal service exists. Its dependencies
(dsh-goal, dsh-llm, dsh-commands/brand) are already vendored and staged on all three
hosts; `command-goal@…/lib/types/` prunes to typings-only under the existing
staging convention. The composer's "/" palette now offers /goal beside /feedback.
command-compact stays OUT: it injects the compaction service, which the mobile
composition does not mount — recorded as the follow-up plane.

## Alternatives considered

- Mounting command-compact too: rejected — its inject requires the compaction
  service (compaction-basic + thresholds + token-meter), a whole unplumbed plane;
  half-mounting it would fail the inject at boot.
- Mounting command-goal inside `mountCommandPlane`: rejected — the goal service is
  not yet on the context at that point (the goal plane mounts later), so the
  inject would throw; the mount has to follow the goal plane.
- Teaching the client to render a richer palette from the one feedback command:
  rejected — the surface is honestly as rich as the registry; the registry was the
  thing to fix.
