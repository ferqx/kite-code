/** Host-owned process-local opaque identity helpers. */

function randomHex(byteLength: number): string {
  const buffer = new Uint8Array(byteLength);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createRuntimeHostInteractionId(): string {
  return `int_${randomHex(4)}`;
}

export function createRuntimeHostTurnId(): string {
  return `turn_${randomHex(4)}`;
}
