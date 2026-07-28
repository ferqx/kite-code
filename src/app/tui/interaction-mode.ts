import type { SandboxBackend } from '@/core/sandbox/index';
import { InteractionMode } from '@/protocol/events';

export type TuiInteractionMode =
  | typeof InteractionMode.AcceptEdits
  | typeof InteractionMode.Auto
  | typeof InteractionMode.Full;

export interface InteractionModeAdmission {
  allowed: boolean;
  mode: TuiInteractionMode;
  reason: string | null;
}

export function executionBoundaryLabel(
  platform: NodeJS.Platform,
  sandboxBackend: SandboxBackend,
): string | null {
  return platform === 'win32' && sandboxBackend === 'none' ? 'Unsandboxed Bash' : null;
}

export function fullModeUnavailableReason(
  interactionMode: TuiInteractionMode,
  sandboxBackend: SandboxBackend,
): string | null {
  if (interactionMode !== InteractionMode.Full) return null;
  if (sandboxBackend !== 'none') return null;
  return '未启用沙箱，Full 不可用';
}

export function resolveInteractionModeTarget(
  requested: string | undefined,
  current: TuiInteractionMode,
  sandboxBackend?: SandboxBackend,
): TuiInteractionMode | null {
  const normalized = (requested ?? '').toLowerCase();
  if (!normalized) {
    if (current === InteractionMode.AcceptEdits) return InteractionMode.Auto;
    if (current === InteractionMode.Auto && sandboxBackend === 'none')
      return InteractionMode.AcceptEdits;
    if (current === InteractionMode.Auto) return InteractionMode.Full;
    return InteractionMode.AcceptEdits;
  }
  if (normalized === 'a' || normalized === InteractionMode.AcceptEdits)
    return InteractionMode.AcceptEdits;
  if (normalized === 'au' || normalized === InteractionMode.Auto) return InteractionMode.Auto;
  if (normalized === 'f' || normalized === InteractionMode.Full) return InteractionMode.Full;
  if (
    normalized === InteractionMode.AcceptEdits ||
    normalized === InteractionMode.Auto ||
    normalized === InteractionMode.Full
  ) {
    return normalized as TuiInteractionMode;
  }
  return null;
}

export function admitInteractionModeTarget(
  target: TuiInteractionMode,
  sandboxBackend: SandboxBackend,
): InteractionModeAdmission {
  const reason = fullModeUnavailableReason(target, sandboxBackend);
  if (reason) {
    return { allowed: false, mode: InteractionMode.AcceptEdits, reason };
  }
  return { allowed: true, mode: target, reason: null };
}
