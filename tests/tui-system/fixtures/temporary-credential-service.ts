/** Test-owned Service composition; production keeps its OS credential backend. */
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { runServiceProcess } from '../../../apps/service/src/main';

await runServiceProcess({ credentialBackend: createTemporaryCredentialBackend() });
