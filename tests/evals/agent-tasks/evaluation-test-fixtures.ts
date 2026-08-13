import { sha256Digest } from '../../../scripts/release/canonical-json';
import type { SuiteBehaviorIdentityV1 } from './suite-registry';

export function syntheticBehaviorIdentity(): SuiteBehaviorIdentityV1 {
  return {
    version: 1,
    routeDigest: digest('route'),
    artifactDigest: digest('artifact'),
    contractDigest: digest('contract'),
    toolSchemaDigest: digest('tools'),
    evaluatorDigest: digest('evaluator'),
  };
}

export function digest(value: string): `sha256:${string}` {
  return sha256Digest(value);
}
