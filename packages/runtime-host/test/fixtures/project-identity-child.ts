import { createProjectIdentityStoreV1 } from '../../src/project-identity';

const [path, workspace] = process.argv.slice(2);
if (!path || !workspace) throw new Error('project identity child arguments missing');
const store = createProjectIdentityStoreV1({
  path,
  installationId: 'install_test',
  keyId: `sha256:${'7'.repeat(64)}`,
  authenticatorKey: new Uint8Array(32).fill(7),
});
process.stdout.write(`${JSON.stringify(store.resolveOrCreateSync(workspace))}\n`);
