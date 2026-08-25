import { InteractionMode } from '@kite-ai/runtime-contract';
import { appSandboxBackendAvailable, type SandboxBackend } from '#app/sandbox/types';

export type TuiInteractionMode =
  | typeof InteractionMode.AcceptEdits
  | typeof InteractionMode.Auto
  | typeof InteractionMode.Full;

export interface InteractionModeAdmission {
  allowed: boolean;
  mode: TuiInteractionMode;
  reason: string | null;
}

export { appSandboxBackendAvailable };

export function fullModeUnavailableReason(
  _interactionMode: TuiInteractionMode,
  _sandboxBackend: SandboxBackend,
): string | null {
  return null;
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
  return { allowed: true, mode: target, reason };
}
