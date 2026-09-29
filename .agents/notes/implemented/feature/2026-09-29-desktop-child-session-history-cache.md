# Agent Note: Desktop child history reuses the bounded reading cache

Status: implemented

## Problem

Desktop already kept recently visited parent transcripts, but leaving a child detail discarded its transcript. Reopening that child briefly showed the full loading view even while its parent and sibling remained readable. Repeated parent, child, and other session navigation made this visible during an active run.

## Decision

The Desktop client stores a previously loaded child transcript in the existing bounded inactive history cache, keyed by the exact parent and child IDs. Parent and child entries share the 12 entry, 64 MiB total, and 16 MiB per entry limits. A revisit after the current parent's child list authorizes the child displays that transcript immediately, including an empty loaded History, while a full History read, projection query, subscription, and calibration proceed. Reconciliation replaces changed messages and reuses unchanged message references. The cached transcript grants no operation or reading authority by itself. A confirmed child or parent deletion, a child detail read that confirms it is unavailable, and an explicit parent history denial remove affected entries. Connection replacement clears inactive child entries; explicit disconnect clears the entire inactive cache.

The cache owns message data rather than mounted React trees. The chosen boundary and invalidation rules are implemented in [DesktopClient](../../../../apps/kite-desktop/src/client.ts) and described in the [history owner document](../../../../apps/kite-desktop/docs/history-and-recovery.md).

An interrupted connection is different from leaving the current reading page. The inactive child cache is discarded, while bounded, previously read main transcripts remain available if the directory confirms the same session and workspace digest. The currently visible child transcript and parent child list remain on that page with reading authority revoked until the new connection verifies them. Main transcript cache entries likewise grant no ready state: the new connection performs a full History read and calibration. The restore intent belongs to the child page, so an explicit return to the parent, a different child, or another main session cancels it before any late list response can reopen the old child. A reconnecting list is visible but cannot authorize a child read.

## Alternatives considered

- Keep every visited parent and child page mounted: that would preserve DOM state but retain large message trees and live component effects outside the existing memory budget.
- Skip the History request on cache hits: equal sequence numbers do not prove equal History content, and a cached child list is not a fresh read authorization.
- Give child details a separate unbounded cache: that would make memory retention grow with background agent fan-out and bypass the measured parent cache budget.

## Consequences

Reentering a cached child no longer replaces its transcript with a blank loading view. A remount still incurs React rendering cost, and the Service still transfers and verifies History. The cache can miss after eviction or deletion; reconnect clears inactive child entries, preserves eligible main transcripts, and keeps the current child page visible during fresh verification. Existing scroll and disclosure state remain with the UI reading-state owner. Integration, UI, and native-window checks cover cached revisits and navigation during a real model run.
