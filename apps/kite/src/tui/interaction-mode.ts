import { InteractionMode } from '@kite/runtime-contract';
import { type SandboxBackend, sandboxSupportsFullMode } from '#app/sandbox/types';

export type TuiInteractionMode =
  | typeof InteractionMode.AcceptEdits
  | typeof InteractionMode.Auto
  | typeof InteractionMode.Full;

export interface InteractionModeAdmission {
  allowed: boolean;
  mode: TuiInteractionMode;
  reason: string | null;
}

export { sandboxSupportsFullMode };

export function fullModeUnavailableReason(
  interactionMode: TuiInteractionMode,
  sandboxBackend: SandboxBackend,
): string | null {
  if (interactionMode !== InteractionMode.Full) return null;
  if (sandboxSupportsFullMode(sandboxBackend)) return null;
  return '非沙箱环境无法开启full';
}

export function resolveInteractionModeTarget(
  requested: string | undefined,
): TuiInteractionMode | null {
  const normalized = (requested ?? '').toLowerCase();
  if (!normalized) return null;
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
