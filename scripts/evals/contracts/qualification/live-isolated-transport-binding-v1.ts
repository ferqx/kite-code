import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';

/**
 * Source-owned identity for the fixed L3 child transport. The transport is
 * diagnostic plumbing, not a release artifact: it binds the immutable launch
 * shape, protocol, parent boundary, and production child source bytes so a
 * verifier cannot silently accept a runner whose real provider boundary was
 * swapped underneath it.
 */
export const LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1 = [
  'scripts/evals/qualification/live-model-transport-v1.ts',
  'scripts/evals/qualification/live-isolated-transport-v1.ts',
  'scripts/evals/qualification/live-isolated-transport-protocol-v1.ts',
  'scripts/evals/qualification/live-isolated-transport-child-v1.ts',
  'scripts/evals/qualification/live-scratch-supervisor-health-v1.ts',
] as const;

type LiveIsolatedTransportSourcePathV1 = (typeof LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1)[number];

interface LiveIsolatedTransportSourceEntryV1 {
  readonly path: LiveIsolatedTransportSourcePathV1;
  readonly sourceDigest: `sha256:${string}`;
}

interface LiveIsolatedTransportBindingMaterialV1 {
  readonly schema: 'LiveIsolatedTransportBindingV1';
  readonly version: 1;
  readonly launch: {
    readonly executable: 'process.execPath';
    readonly argv: readonly ['--no-env-file', 'live-isolated-transport-child-v1.ts'];
    readonly detached: true;
    readonly stdin: 'pipe';
    readonly stdout: 'pipe';
    readonly stderr: 'ignore';
    readonly windowsProcessTree: 'fail_closed';
    readonly authority: 'fixed_non_exported_launcher_only';
  };
  readonly protocol: {
    readonly schema: 'LiveIsolatedTransportProtocolV1';
    readonly version: 1;
    readonly maxFrameBytes: 98_304;
    readonly credentialDelivery: 'ready_then_private_stdin_lease';
    readonly rawProviderContentAcrossIpc: 'forbidden';
    readonly callerEnvironment: 'not_accepted';
    readonly childEnvironment: 'fixed_path_locale_timezone_and_scratch_only';
    readonly scratchRoot: 'fixed_os_temp_lstat_non_symlink_root_owned_sticky';
    readonly supervisorActivation: 'source_literal_disabled_until_persistent_service_authorized';
  };
  readonly sources: readonly LiveIsolatedTransportSourceEntryV1[];
}

export function computeLiveIsolatedTransportSourceDigestV1(
  sourceBytes: Uint8Array,
): `sha256:${string}` {
  if (sourceBytes.byteLength === 0) throw new Error('live_isolated_transport_source_empty');
  return sha256DomainSeparated('kite.qualification.live-isolated-transport.source.v1', sourceBytes);
}

export function computeLiveIsolatedTransportBindingDigestV1(
  material: LiveIsolatedTransportBindingMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-isolated-transport.binding.v1',
    canonicalJsonBytes(material),
  );
}

// These values are intentionally checked by a test-only byte re-derivation
// hook below. They retain only digests, never source text, fixtures, routes,
// credentials, endpoints, prompts, or provider output.
const transportSourceEntriesV1: readonly LiveIsolatedTransportSourceEntryV1[] = Object.freeze([
  {
    path: 'scripts/evals/qualification/live-model-transport-v1.ts',
    sourceDigest: 'sha256:0c194d38a4e1dab4e4519a2ea16ba11f3c1968e54b839cf2bc89c0f2c7f0eae3',
  },
  {
    path: 'scripts/evals/qualification/live-isolated-transport-v1.ts',
    sourceDigest: 'sha256:60e21c8351e7dcb01accfaad979322014a7d20cfd044aef28316108cb954b1ef',
  },
  {
    path: 'scripts/evals/qualification/live-isolated-transport-protocol-v1.ts',
    sourceDigest: 'sha256:e5718015459c90a4b07ecc6e83102edaca066447768159f9ce965bdbf94bd7cf',
  },
  {
    path: 'scripts/evals/qualification/live-isolated-transport-child-v1.ts',
    sourceDigest: 'sha256:f6e949cb36dd8cee8a4e24cafeca8077a2f2fac15992e013efc22f31e1cff9ad',
  },
  {
    path: 'scripts/evals/qualification/live-scratch-supervisor-health-v1.ts',
    sourceDigest: 'sha256:ed7b7c4b8abe1b1966095f5861812136d143b15c3cad5b70a423e38019c72dd7',
  },
]);

const transportBindingMaterialV1: LiveIsolatedTransportBindingMaterialV1 = Object.freeze({
  schema: 'LiveIsolatedTransportBindingV1',
  version: 1,
  launch: Object.freeze({
    executable: 'process.execPath',
    argv: ['--no-env-file', 'live-isolated-transport-child-v1.ts'] as const,
    detached: true,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    windowsProcessTree: 'fail_closed',
    authority: 'fixed_non_exported_launcher_only',
  }),
  protocol: Object.freeze({
    schema: 'LiveIsolatedTransportProtocolV1',
    version: 1,
    maxFrameBytes: 98_304,
    credentialDelivery: 'ready_then_private_stdin_lease',
    rawProviderContentAcrossIpc: 'forbidden',
    callerEnvironment: 'not_accepted',
    childEnvironment: 'fixed_path_locale_timezone_and_scratch_only',
    scratchRoot: 'fixed_os_temp_lstat_non_symlink_root_owned_sticky',
    supervisorActivation: 'source_literal_disabled_until_persistent_service_authorized',
  }),
  sources: transportSourceEntriesV1,
});

export const LIVE_ISOLATED_TRANSPORT_BINDING_V1 = Object.freeze({
  ...transportBindingMaterialV1,
  bindingDigest: computeLiveIsolatedTransportBindingDigestV1(transportBindingMaterialV1),
});

const UNRESOLVED_DIGEST_V1 = `sha256:${'0'.repeat(64)}`;

/** Static fail-closed self-check used by both specialized L3 source registries. */
export function liveIsolatedTransportBindingIsClosedV1(): boolean {
  const binding = LIVE_ISOLATED_TRANSPORT_BINDING_V1;
  return (
    binding.schema === 'LiveIsolatedTransportBindingV1' &&
    binding.version === 1 &&
    binding.launch.executable === 'process.execPath' &&
    binding.launch.argv.length === 2 &&
    binding.launch.argv[0] === '--no-env-file' &&
    binding.launch.argv[1] === 'live-isolated-transport-child-v1.ts' &&
    binding.launch.detached === true &&
    binding.launch.stdin === 'pipe' &&
    binding.launch.stdout === 'pipe' &&
    binding.launch.stderr === 'ignore' &&
    binding.launch.windowsProcessTree === 'fail_closed' &&
    binding.launch.authority === 'fixed_non_exported_launcher_only' &&
    binding.protocol.schema === 'LiveIsolatedTransportProtocolV1' &&
    binding.protocol.version === 1 &&
    binding.protocol.maxFrameBytes === 98_304 &&
    binding.protocol.credentialDelivery === 'ready_then_private_stdin_lease' &&
    binding.protocol.rawProviderContentAcrossIpc === 'forbidden' &&
    binding.protocol.callerEnvironment === 'not_accepted' &&
    binding.protocol.childEnvironment === 'fixed_path_locale_timezone_and_scratch_only' &&
    binding.protocol.scratchRoot === 'fixed_os_temp_lstat_non_symlink_root_owned_sticky' &&
    binding.protocol.supervisorActivation ===
      'source_literal_disabled_until_persistent_service_authorized' &&
    binding.sources.length === LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1.length &&
    binding.sources.every(
      (entry, index) =>
        entry.path === LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1[index] &&
        entry.sourceDigest !== UNRESOLVED_DIGEST_V1,
    ) &&
    binding.bindingDigest ===
      computeLiveIsolatedTransportBindingDigestV1(transportBindingMaterialV1)
  );
}

/**
 * Test-only source-byte re-derivation. It accepts an exact fixed path set;
 * callers cannot add a replacement entrypoint or omit the production child.
 */
export function assertLiveIsolatedTransportSourceDriftV1(input: {
  readonly sources: readonly { readonly path: string; readonly sourceBytes: Uint8Array }[];
}): void {
  const binding = LIVE_ISOLATED_TRANSPORT_BINDING_V1;
  if (
    input.sources.length !== LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1.length ||
    input.sources.some(
      (entry, index) => entry.path !== LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1[index],
    )
  ) {
    throw new Error('live_isolated_transport_source_set_drift');
  }
  const rederived = input.sources.map((entry, index) => ({
    path: LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1[index]!,
    sourceDigest: computeLiveIsolatedTransportSourceDigestV1(entry.sourceBytes),
  }));
  const sameSources = rederived.every(
    (entry, index) =>
      entry.path === binding.sources[index]?.path &&
      entry.sourceDigest === binding.sources[index]?.sourceDigest,
  );
  const material: LiveIsolatedTransportBindingMaterialV1 = {
    ...transportBindingMaterialV1,
    sources: rederived,
  };
  if (
    !sameSources ||
    computeLiveIsolatedTransportBindingDigestV1(material) !== binding.bindingDigest
  ) {
    throw new Error('live_isolated_transport_source_drift');
  }
}
