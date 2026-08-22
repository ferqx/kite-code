import { createProjectIdentityStoreV1 } from '../../src/project-identity';

const [path, workspace] = process.argv.slice(2);
if (!path || !workspace) throw new Error('project identity child arguments missing');
const store = createProjectIdentityStoreV1({
  path,
});
process.stdout.write(`${JSON.stringify(store.resolveOrCreateSync(workspace))}\n`);
