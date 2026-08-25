import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { verifyBootstrapArtifact } from './bootstrap-verifier';
import { canonicalJsonBytes, parseCanonicalJson, sha256Digest } from './canonical-json';

export const RELEASE_PLATFORM_IDENTITIES_ = [
  'macos-15-seatbelt',
  'ubuntu-24.04-bubblewrap',
  'windows-server-2025-none',
] as const;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const syntheticPlatformLauncherIdentitySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('synthetic-platform-launcher-identity-v1'),
    platform: z.enum(RELEASE_PLATFORM_IDENTITIES_),
    launcherSha256: digestSchema,
    canonicalManifestDigest: digestSchema,
    nativeSignatureStatus: z.literal('not_verified_synthetic_fixture'),
    nonDistributable: z.literal(true),
    productionSupportClaim: z.literal(false),
    realPlatformSigningEnabled: z.literal(false),
  })
  .strict();

export type SyntheticPlatformLauncherIdentity = z.infer<
  typeof syntheticPlatformLauncherIdentitySchema
>;

export interface BlockedPlatformArtifactSmoke {
  version: 1;
  status: 'blocked';
  reason: 'production_support_set_empty';
  platform: SyntheticPlatformLauncherIdentity['platform'];
  nonDistributable: true;
  productionArtifact: false;
  checks: {
    canonicalManifest: 'verified_synthetic';
    payloadDigest: 'verified_synthetic';
    launcherDigest: 'verified_synthetic';
    nativePlatformSignature: 'not_run';
  };
}

export class PlatformArtifactSmokeError extends Error {
  readonly code: 'launcher_identity_invalid' | 'launcher_digest_mismatch';

  constructor(code: 'launcher_identity_invalid' | 'launcher_digest_mismatch') {
    super(`Platform artifact smoke failed closed: ${code}`);
    this.name = 'PlatformArtifactSmokeError';
    this.code = code;
  }
}

/**
 * Verify exact synthetic artifact and launcher bytes without executing either.
 * D-04 has no production-supported target, so success remains a blocked record.
 */
export function runPlatformArtifactSmoke(input: {
  artifactDirectory: string;
  launcherBytes: Uint8Array;
  launcherIdentity: unknown;
}): BlockedPlatformArtifactSmoke {
  const artifact = verifyBootstrapArtifact(input.artifactDirectory);
  const parsed = syntheticPlatformLauncherIdentitySchema.safeParse(input.launcherIdentity);
  if (!parsed.success) throw new PlatformArtifactSmokeError('launcher_identity_invalid');
  const launcherIdentity = parsed.data;
  if (launcherIdentity.launcherSha256 !== sha256Digest(input.launcherBytes)) {
    throw new PlatformArtifactSmokeError('launcher_digest_mismatch');
  }
  if (launcherIdentity.canonicalManifestDigest !== artifact.signature.manifestSha256) {
    throw new PlatformArtifactSmokeError('launcher_identity_invalid');
  }

  return {
    version: 1,
    status: 'blocked',
    reason: 'production_support_set_empty',
    platform: launcherIdentity.platform,
    nonDistributable: true,
    productionArtifact: false,
    checks: {
      canonicalManifest: 'verified_synthetic',
      payloadDigest: 'verified_synthetic',
      launcherDigest: 'verified_synthetic',
      nativePlatformSignature: 'not_run',
    },
  };
}

export function createSyntheticPlatformLauncherIdentity(input: {
  platform: SyntheticPlatformLauncherIdentity['platform'];
  launcherBytes: Uint8Array;
  canonicalManifestDigest: `sha256:${string}`;
}): SyntheticPlatformLauncherIdentity {
  return syntheticPlatformLauncherIdentitySchema.parse({
    version: 1,
    kind: 'synthetic-platform-launcher-identity-v1',
    platform: input.platform,
    launcherSha256: sha256Digest(input.launcherBytes),
    canonicalManifestDigest: input.canonicalManifestDigest,
    nativeSignatureStatus: 'not_verified_synthetic_fixture',
    nonDistributable: true,
    productionSupportClaim: false,
    realPlatformSigningEnabled: false,
  });
}

if (import.meta.main) {
  const artifactDirectory = resolve(process.argv[2] ?? 'dist/release-synthetic');
  const launcherPath = resolve(process.argv[3] ?? 'scripts/release/bootstrap-verifier.ts');
  const identityPath = process.argv[4];
  if (!identityPath) throw new Error('A synthetic launcher identity JSON path is required.');
  const result = runPlatformArtifactSmoke({
    artifactDirectory,
    launcherBytes: readFileSync(launcherPath),
    launcherIdentity: parseCanonicalJson(readFileSync(resolve(identityPath))),
  });
  process.stdout.write(`${new TextDecoder().decode(canonicalJsonBytes(result))}\n`);
}
