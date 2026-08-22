import { homedir } from 'node:os';
import { join } from 'node:path';

/** Installation-private root shared by current Artifact namespaces. */
export function userKiteCodeDirV1(): string {
  return join(process.env.KITE_CODE_HOME ?? homedir(), '.kite-code');
}

/** Private model request/response artifacts; never a Session Logger directory. */
export function modelArtifactRoot(): string {
  return join(userKiteCodeDirV1(), 'model-artifacts');
}
