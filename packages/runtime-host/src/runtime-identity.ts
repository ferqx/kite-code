/** Host-owned process-local opaque identity helpers. */

function randomHexV1(byteLength: number): string {
  const buffer = new Uint8Array(byteLength);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createRuntimeHostInteractionIdV1(): string {
  return `int_${randomHexV1(4)}`;
}

export function createRuntimeHostTurnIdV1(): string {
  return `turn_${randomHexV1(4)}`;
}
