import { join } from 'node:path';
import {
  type NativeRuntimeProtection,
  parseNativeRuntimeProtection,
  verifyNativeRuntimeProtection,
} from './native-runtime-assets';
import {
  parseTerminalRuntimeProtection,
  type TerminalRuntimeProtection,
  verifyTerminalRuntimeProtection,
} from './runtime-assets';

/** Trusted host selection only; no HTTP, Model or configuration authority. */
export type RuntimeProtection = TerminalRuntimeProtection | NativeRuntimeProtection;

/** Closed metadata parsing performs no filesystem or package access. */
export function parseRuntimeProtection(value: unknown): RuntimeProtection {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'kind' in value &&
    value.kind === 'native.candidate'
  )
    return parseNativeRuntimeProtection(value);
  return parseTerminalRuntimeProtection(value);
}

/** Fixed lease roots are acquired together before verifying the selected closure. */
export function runtimeProtectionRoots(value: RuntimeProtection): readonly string[] {
  const proof = parseRuntimeProtection(value);
  return Object.freeze(
    proof.kind === 'native.candidate' ? [proof.root, join(proof.root, 'terminal')] : [proof.root],
  );
}

/** Integrity and exact entry pins; neither this metadata nor its hash grants execution. */
export function verifyRuntimeProtection(
  value: RuntimeProtection,
  actual: { entrypoint: string; executable: string; buildId: string },
): readonly string[] {
  const proof = parseRuntimeProtection(value);
  if (proof.kind === 'native.candidate') verifyNativeRuntimeProtection(proof, actual);
  else verifyTerminalRuntimeProtection(proof, actual);
  return runtimeProtectionRoots(proof);
}
