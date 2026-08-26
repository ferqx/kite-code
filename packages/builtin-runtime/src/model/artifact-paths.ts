import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Installation-private root shared by current Artifact namespaces.
 *
 * Legacy callers set `KITE_CODE_HOME` to the user home and therefore expect
 * the resolver to append `.kite-code`.  The Service boundary, however,
 * injects `KITE_CODE_HOME` as the already validated, exact code root
 * (`<home>/.kite-code`).  Keep the legacy default while treating a configured
 * value as an explicit root; appending another suffix would make Service
 * artifacts invisible to the rest of the Service owner.
 */
export function userKiteCodeDir(explicitRoot?: string): string {
  if (explicitRoot !== undefined && explicitRoot.length > 0) return explicitRoot;
  const configuredRoot = process.env.KITE_CODE_HOME;
  if (configuredRoot !== undefined && configuredRoot.length > 0) return configuredRoot;
  return join(homedir(), '.kite-code');
}

/** Private model request/response artifacts; never a Session Logger directory. */
export function modelArtifactRoot(explicitRoot?: string): string {
  return join(userKiteCodeDir(explicitRoot), 'model-artifacts');
}
