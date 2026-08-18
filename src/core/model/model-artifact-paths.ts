import { join } from 'node:path';
import { userKiteCodeDir } from '@/core/config/paths';

/** Private model request/response artifacts; never a Session Logger directory. */
export function modelArtifactRoot(): string {
  return join(userKiteCodeDir(), 'model-artifacts');
}
