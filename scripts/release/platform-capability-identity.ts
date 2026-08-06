/**
 * Source-owned canonical repository identity for platform-capability
 * diagnostics. This data-only module intentionally has no runtime,
 * evaluator, or release-control dependencies so independent diagnostic
 * contracts can bind the same identity without importing a probe runner.
 */
export const PLATFORM_CAPABILITY_CANONICAL_REPOSITORY_V1 = 'ferqx/kite-code' as const;
export const PLATFORM_CAPABILITY_CANONICAL_REPOSITORY_ID_V1 = '1218896626' as const;
