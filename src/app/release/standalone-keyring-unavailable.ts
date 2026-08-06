/**
 * Source-owned replacement for `@napi-rs/keyring` in a Bun standalone candidate.
 *
 * Bun standalone cannot reliably carry the N-API binding on every native target.
 * The candidate must therefore preserve normal construction/startup while every
 * credential operation fails closed, without providing a file, environment, or
 * plaintext fallback.
 */
/**
 * Stable, non-secret marker carried in every standalone candidate that replaces
 * the native keyring.  Qualification code binds only this marker's digest; it
 * never retains candidate executable bytes or an error transcript.
 */
export const STANDALONE_KEYRING_UNAVAILABLE_MARKER_V1 = 'openpx.standalone-keyring-unavailable.v1';

export const STANDALONE_KEYRING_UNAVAILABLE_MESSAGE_V1 = `Native credential store is unavailable in the standalone candidate. [${STANDALONE_KEYRING_UNAVAILABLE_MARKER_V1}]`;

export class StandaloneKeyringUnavailableError extends Error {
  constructor() {
    super(STANDALONE_KEYRING_UNAVAILABLE_MESSAGE_V1);
    this.name = 'StandaloneKeyringUnavailableError';
  }
}

function unavailable(): never {
  throw new StandaloneKeyringUnavailableError();
}

/** API-compatible fail-closed shape for the async native keyring entry. */
export class AsyncEntry {
  constructor(..._identity: [service: string, username: string]) {
    void _identity;
  }

  static withTarget(_target: string, service: string, username: string): AsyncEntry {
    return new AsyncEntry(service, username);
  }

  async setPassword(_password: string, _signal?: AbortSignal | null): Promise<void> {
    unavailable();
  }

  async setSecret(_secret: Uint8Array, _signal?: AbortSignal | null): Promise<void> {
    unavailable();
  }

  async getPassword(_signal?: AbortSignal | null): Promise<string | undefined> {
    unavailable();
  }

  async getSecret(_signal?: AbortSignal | null): Promise<Uint8Array | undefined> {
    unavailable();
  }

  async deleteCredential(_signal?: AbortSignal | null): Promise<boolean> {
    unavailable();
  }

  async deletePassword(_signal?: AbortSignal | null): Promise<unknown> {
    unavailable();
  }
}

/** API-compatible fail-closed shape for the synchronous native keyring entry. */
export class Entry {
  constructor(..._identity: [service: string, username: string]) {
    void _identity;
  }

  static withTarget(_target: string, service: string, username: string): Entry {
    return new Entry(service, username);
  }

  setPassword(_password: string): void {
    unavailable();
  }

  setSecret(_secret: Uint8Array): void {
    unavailable();
  }

  getPassword(): string | null {
    unavailable();
  }

  getSecret(): number[] | null {
    unavailable();
  }

  deleteCredential(): boolean {
    unavailable();
  }

  deletePassword(): boolean {
    unavailable();
  }
}

export interface Credential {
  account: string;
  password: string;
}

export function findCredentials(_service: string, _target?: string | null): Credential[] {
  unavailable();
}

export async function findCredentialsAsync(
  _service: string,
  _target?: string | null,
  _signal?: AbortSignal | null,
): Promise<Credential[]> {
  unavailable();
}
