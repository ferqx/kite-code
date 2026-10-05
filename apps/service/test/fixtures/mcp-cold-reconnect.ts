import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { runServiceProcess } from '@kite-ai/service/main';

// This compiled, source-free Host uses the same public process assembly as default Main.
// The only test policy is independent Ask for Actions/connection Jobs and a loopback port.
const settings = JSON.parse(readFileSync(join(import.meta.dir, 'settings.json'), 'utf8')) as {
  root: string;
  phase: 'warm' | 'cold';
};
const log = (name: string, value: unknown) =>
  appendFileSync(join(settings.root, name), `${JSON.stringify(value)}\n`);
await runServiceProcess({
  configure(startup) {
    return createDefaultProcessConfiguration({
      profile: selectProfile(startup.profile),
      hostConfiguration: startup.hostConfiguration,
      permissions: {
        async authorize(request) {
          log('permission.jsonl', {
            phase: settings.phase,
            kind: request.kind,
            definitionId: request.definitionId,
            executionId: request.executionId,
            sessionId: request.sessionId,
          });
          return request.kind === 'job'
            ? {
                allowed: false,
                revision: 'owned-independent-ask',
                approval: { request: { effects: ['external'] }, grants: ['approve_once'] },
              }
            : { allowed: true, revision: 'owned-model-tool-allowed' };
        },
      },
      credentialBackend: {
        kind: 'temporary',
        async put() {
          log('credential.jsonl', { operation: 'put' });
          throw Error('owned_auth_none_credential_forbidden');
        },
        async resolve() {
          log('credential.jsonl', { operation: 'resolve' });
          throw Error('owned_auth_none_credential_forbidden');
        },
        async remove() {
          log('credential.jsonl', { operation: 'remove' });
          throw Error('owned_auth_none_credential_forbidden');
        },
      },
      mcpSources: {
        http: {
          allowLoopbackForTests: true,
          async resolveAddresses(hostname) {
            log('resolution.jsonl', { phase: settings.phase, hostname });
            if (hostname !== '127.0.0.1') throw Error('owned_remote_host_forbidden');
            return [{ address: '127.0.0.1', family: 4 as const }];
          },
        },
      },
    });
  },
});
