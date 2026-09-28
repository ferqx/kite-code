# Agent Note: Preserve bounded Store maintenance admission reasons

Status: implemented

## Problem

A paired Desktop upgrade can fail before Store candidate conversion, while its public startup report says only `store_history_reconciliation_required` at `acquiring_maintenance`. The same report can represent a failed parent identity check, a mismatched paired manifest, incomplete old-process observation, or a non-admission preparation error. The user cannot choose an appropriate next action from that category, and the Service cannot establish the actual cause from the public report alone.

## Decision

The release entrypoint converts a known maintenance admission refusal into `store_admission_failed` with one finite `admissionReason`. Preparation preserves that reason and its stage through the Store error wrapper. The Service startup record, Runtime Client, Desktop, and CLI/TUI reports accept only the enumerated reason for this error category and render fixed, path-free guidance. A confirmed live old writer remains `store_busy` with bounded retry; identity, release-selection, and process-observation failures remain fail closed and non-retryable. Unknown internal refusal strings map to `admission_unverified` rather than entering the client report. Existing startup records without a reason remain readable.

## Alternatives considered

- Keep the generic reconciliation category: avoids a protocol change but hides the branch needed to diagnose a repeated upgrade failure.
- Forward the underlying Error text or Service stderr: may expose local paths, process arguments, or other private data and makes client behavior depend on uncontrolled strings.
- Retry every admission failure: can repeatedly encounter the same unverified identity and would weaken the distinction between observed contention and unproved safety.

## Consequences

The finite reason identifies which admission proof failed without declaring the Store contents corrupt or attempting conversion. A locally repackaged Desktop with an isolated Store 13 and WAL passed Store 13→14 conversion and a second current-format startup. The same packaged Service, launched by a deliberately unverified parent, returned `desktop_parent_unverified` before candidate creation while the old main/WAL hashes stayed unchanged. The macOS release-candidate job now runs this packaged test; its first hosted result is still pending. Later read-only inspection of the affected private candidate showed that its actual failure was after admission: Store 14 conversion had completed, but continuity validation rejected stale execution owners. The older generic report did not identify that later attempt. This admission-reason change remains relevant for genuine admission failures; it does not diagnose candidate validation. Store maintenance locks, source revalidation, and original-data preservation remain mandatory.
