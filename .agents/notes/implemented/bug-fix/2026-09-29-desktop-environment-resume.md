# Agent Note: Preserve the Desktop environment card while a session is rechecked

Status: implemented

## Problem

Leaving a running parent session releases its Runtime subscription and the associated background execution snapshot. Returning to that session could make the environment card briefly lose Shell and child status rows, then restore them after a new query. A visible child-list refresh and card entry animation added further movement on ordinary navigation.

## Decision

Desktop retains a bounded, per-session copy of the last confirmed background execution summary for presentation within the same connection. On return, the card immediately shows those rows with an explicit last-known-state label while fresh facts are fetched. Cached rows do not grant `ready` or stop authority; current Runtime facts replace them, and deletion, explicit parent history denial or identity mismatch, workspace change, or detach remove the presentation copy. Previously confirmed child lists refresh silently on automatic reentry, while an explicit user refresh keeps visible progress. The shared page animates environment card visibility only for user toggles and narrow-width automatic collapse, not for reading-identity changes.

## Alternatives considered

- Retain inactive Runtime subscriptions and snapshots: this would change Runtime Client's bounded retention and authority lifecycle for every visited session.
- Show last-known running rows as if current: an execution may have settled while another page was open, so an unlabeled state and stop action would be misleading.
- Clear the entire card until calibration finishes: this preserves strict freshness but causes the reported disappearance and reappearance of previously read information.

## Consequences

The card remains visually stable across parent, child, and other-session navigation while current status is re-established. Last-known rows are explicitly marked and read-only; initial reads and cache misses still use the normal empty or unconfirmed state. The presentation cache is separate from the Runtime subscription store and does not keep inactive execution authority alive. Current behavior and invalidation boundaries are described in the [Desktop history owner](../../../../apps/kite-desktop/docs/history-and-recovery.md) and [product handbook](../../../../docs/handbook/clients/desktop/README.md).
