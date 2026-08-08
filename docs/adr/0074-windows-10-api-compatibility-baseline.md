# ADR-0074: Windows 10 API compatibility baseline; Win11-first native evidence

Status: accepted

Date: 2026-08-05

## Context

The Windows Shell candidate is developed and exercised on Windows 11. The
current scope explicitly does not include a physical Windows 10 machine or VM.
We still need a precise compatibility claim that prevents accidental Win11-only
imports or an implicit lower-OS fallback.

## Decision

1. The candidate's supported API/build baseline is Windows 10 22H2
   (10.0.19045) or later. It is not a claim of physical Windows 10
   conformance.
2. The native runner uses `RtlGetVersion` before accepting an invocation.
   Versions below 10.0.19045 receive a typed, fail-closed error and execute no
   Shell. A PE-subsystem override is deliberately not used because the GNU
   Windows linker variant produced an unloadable binary with that override.
3. The runner manifest contains the exact `minimumWindowsVersion` value; the
   TypeScript resolver rejects a missing or different value. The API audit must
   use only APIs whose documented minimum version is no later than Windows 10.
4. Win11 native E2E and the Platform Capability Probe remain the priority
   actual evidence. Windows 10 has no physical/VM conformance gate in this
   scope.
5. This changes only the candidate compatibility objective. It neither marks
   Windows production-supported nor removes the separate native evidence and
   release-gate requirements for production qualification.

## Consequences

- A future Win11-only API import, an altered manifest baseline, or an older
  Windows invocation is detected by build/review, manifest validation, or the
  startup gate instead of silently changing compatibility.
- This ADR supersedes ADR-0072's two-client physical-evidence prerequisite
