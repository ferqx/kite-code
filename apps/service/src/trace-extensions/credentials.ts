import { createHash } from 'node:crypto';
import type { createCredentialVault } from '@kite-ai/agent/config';
import type { TraceConsumerStore } from './consumer-store';
import { TraceHostError } from './types';

/** Host-only credential purpose binding. No resolve operation or secret crosses into the engine. */
export class TraceCredentialBroker {
  private readonly store: TraceConsumerStore;
  private readonly vault: Pick<
    ReturnType<typeof createCredentialVault>,
    'readOwned' | 'writeOwned' | 'removeOwned'
  >;
  constructor(
    store: TraceConsumerStore,
    vault: Pick<
      ReturnType<typeof createCredentialVault>,
      'readOwned' | 'writeOwned' | 'removeOwned'
    >,
  ) {
    this.store = store;
    this.vault = vault;
  }
  async bind(
    installationId: string,
    origin: string,
    secret: string,
  ): Promise<{ handle: string; origin: string }> {
    if (
      !secret ||
      Buffer.byteLength(secret) > 8192 ||
      [...secret].some((character) => character.charCodeAt(0) < 32)
    )
      throw new TraceHostError('trace_credential_invalid');
    const ownerDigest = createHash('sha256')
      .update(JSON.stringify(['kite.trace.http', installationId, origin, 'bearer']))
      .digest('hex');
    const handle = this.store.createCredentialBinding(installationId, origin, ownerDigest);
    await this.vault.writeOwned({ namespace: 'trace.http', ownerDigest }, secret);
    this.store.activateCredential(handle);
    return { handle, origin };
  }
  async revoke(installationId: string, handle: string): Promise<void> {
    const binding = this.store.credential(installationId, handle);
    this.store.revokeCredential(installationId, handle);
    await this.vault.removeOwned({ namespace: 'trace.http', ownerDigest: binding.ownerDigest });
  }
  async headers(input: {
    installationId: string;
    origin: string;
    handle: string;
    revision: string;
    epoch: string;
    generation: string;
  }): Promise<{ authorization: string }> {
    const check = () => {
      const grant = this.store.assertAuthorization(
        input.installationId,
        input.revision,
        input.epoch,
        input.generation,
      );
      const binding = this.store.credential(input.installationId, input.handle);
      if (
        !binding.active ||
        binding.origin !== input.origin ||
        !grant.grant.credentialHandles?.includes(input.handle) ||
        !grant.grant.origins.includes(input.origin)
      )
        throw new TraceHostError('trace_credential_scope_denied');
      return binding;
    };
    try {
      const binding = check();
      const secret = await this.vault.readOwned({
        namespace: 'trace.http',
        ownerDigest: binding.ownerDigest,
      });
      check();
      if (!secret || [...secret].some((character) => character.charCodeAt(0) < 32))
        throw new TraceHostError('trace_credential_unavailable');
      this.store.audit(input.installationId, 'credential_resolve', 'allowed');
      return { authorization: `Bearer ${secret}` };
    } catch {
      this.store.audit(input.installationId, 'credential_resolve', 'denied');
      throw new TraceHostError('trace_credential_unavailable');
    }
  }
}
