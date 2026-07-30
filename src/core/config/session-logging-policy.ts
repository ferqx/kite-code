import { z } from 'zod';

export const SESSION_LOGGING_POLICY_VERSION = 1 as const;

export const sessionLoggingPolicyV1Schema = z
  .object({
    version: z.literal(SESSION_LOGGING_POLICY_VERSION),
    mode: z.enum(['off', 'metadata', 'content']),
    retentionDays: z.number().int().positive(),
    maxTotalBytes: z.number().int().positive(),
    maxSessionBytes: z.number().int().positive(),
    includeReasoning: z.literal(false),
    includeFileContent: z.literal(false),
    includeToolContent: z.literal(false),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.maxSessionBytes > policy.maxTotalBytes) {
      context.addIssue({
        code: 'custom',
        path: ['maxSessionBytes'],
        message: 'maxSessionBytes must not exceed maxTotalBytes',
      });
    }
  });

export type SessionLoggingPolicyV1 = z.infer<typeof sessionLoggingPolicyV1Schema>;
export type SessionLoggingMode = SessionLoggingPolicyV1['mode'];

export type SessionLoggingPolicyTightening = Partial<
  Pick<SessionLoggingPolicyV1, 'mode' | 'retentionDays' | 'maxTotalBytes' | 'maxSessionBytes'>
>;

export const DEFAULT_SESSION_LOGGING_POLICY_V1: Readonly<SessionLoggingPolicyV1> = Object.freeze({
  version: SESSION_LOGGING_POLICY_VERSION,
  mode: 'metadata',
  retentionDays: 7,
  maxTotalBytes: 256 * 1024 * 1024,
  maxSessionBytes: 16 * 1024 * 1024,
  includeReasoning: false,
  includeFileContent: false,
  includeToolContent: false,
});

const MODE_RANK: Readonly<Record<SessionLoggingMode, number>> = Object.freeze({
  off: 0,
  metadata: 1,
  content: 2,
});

export function parseSessionLoggingPolicyV1(value: unknown): SessionLoggingPolicyV1 {
  return sessionLoggingPolicyV1Schema.parse(value);
}

/**
 * Apply a user, project, or administrative restriction without allowing it to
 * make the artifact policy more permissive.
 */
export function tightenSessionLoggingPolicyV1(
  base: SessionLoggingPolicyV1,
  tightening: SessionLoggingPolicyTightening,
): SessionLoggingPolicyV1 {
  const parsedBase = parseSessionLoggingPolicyV1(base);
  const mode = tightening.mode ?? parsedBase.mode;
  if (MODE_RANK[mode] > MODE_RANK[parsedBase.mode]) {
    throw new Error(`Session logging mode cannot be widened from ${parsedBase.mode} to ${mode}.`);
  }

  for (const field of ['retentionDays', 'maxTotalBytes', 'maxSessionBytes'] as const) {
    const requested = tightening[field];
    if (requested != null && requested > parsedBase[field]) {
      throw new Error(`${field} can only be lowered from the artifact policy.`);
    }
  }

  return parseSessionLoggingPolicyV1({
    ...parsedBase,
    ...tightening,
    mode,
    includeReasoning: false,
    includeFileContent: false,
    includeToolContent: false,
  });
}

export function resolveSessionLoggingPolicyV1(input: {
  enabled: boolean;
  artifactPolicy?: SessionLoggingPolicyV1;
  user?: SessionLoggingPolicyTightening;
  project?: SessionLoggingPolicyTightening;
}): SessionLoggingPolicyV1 {
  let resolved = parseSessionLoggingPolicyV1(
    input.artifactPolicy ?? DEFAULT_SESSION_LOGGING_POLICY_V1,
  );
  if (!input.enabled) {
    resolved = tightenSessionLoggingPolicyV1(resolved, { mode: 'off' });
  }
  if (input.user) resolved = tightenSessionLoggingPolicyV1(resolved, input.user);
  if (input.project) resolved = tightenSessionLoggingPolicyV1(resolved, input.project);
  return resolved;
}
