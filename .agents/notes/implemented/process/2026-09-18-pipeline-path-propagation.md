# Agent Note: pipeline triggers propagate shared-layer changes

Status: implemented

## Problem

The dev pipelines filtered on platform paths only (`hosts/ios/**` etc.). A change to a shared
layer — `contract/`, `runtime/`, `system-plugins/`, `presentation/` — could alter behavior on
every platform while triggering **none** of the platform E2E pipelines: the platforms most
capable of catching the regression were silent exactly when the risk was highest.

## Decision

Each platform pipeline's `paths` (push and pull_request) now includes the four shared layers
plus its own host tree and workflow file. GitHub's `paths` filter is OR-semantics, which is
exactly the propagation model wanted here: shared change ⇒ all three platform pipelines run;
platform-only change ⇒ that platform's pipeline runs; docs-only change ⇒ only `gates`.

## Alternatives considered

- **dorny/paths-filter + dynamic job matrix**: more precise per-plugin attribution (e.g.
  `system-plugins/dsh-fs-ios` → iOS only), but adds a coordinator workflow and third-party
  action before any code exists. Revisit when `system-plugins/` grows host-specific plugins
  worth splitting from the shared semantic layer.
- **Run all pipelines on everything**: rejected — macOS-priced runners on every docs typo.

## Consequences

Platform-only changes stay cheap; shared-layer changes pay for full three-platform E2E — the
correct cost asymmetry, since shared code has the widest blast radius. When host-specific
system plugins appear (M2+), the shared-layer list in each workflow should be narrowed in the
same PR that splits them.
