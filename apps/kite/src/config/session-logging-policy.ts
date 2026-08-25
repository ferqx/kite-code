import { z } from 'zod';

export const SESSION_LOGGING_POLICY_VERSION = 1 as const;

export const sessionLoggingPolicySchema = z
  .object({
    version: z.literal(SESSION_LOGGING_POLICY_VERSION),
    mode: z.enum(['off', 'metadata', 'content']),
    retentionDays: z.number().int().positive(),
    maxTotalBytes: z.number().int().min(1024),
    maxSessionBytes: z.number().int().min(1024),
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

export type SessionLoggingPolicy = z.infer<typeof sessionLoggingPolicySchema>;
export type SessionLoggingMode = SessionLoggingPolicy['mode'];

export type SessionLoggingPolicyTightening = Partial<
  Pick<SessionLoggingPolicy, 'mode' | 'retentionDays' | 'maxTotalBytes' | 'maxSessionBytes'>
>;

export const DEFAULT_SESSION_LOGGING_POLICY_: Readonly<SessionLoggingPolicy> = Object.freeze({
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

export function parseSessionLoggingPolicy(value: unknown): SessionLoggingPolicy {
  return sessionLoggingPolicySchema.parse(value);
}

/**
 * Apply a user, project, or administrative restriction without allowing it to
 * make the artifact policy more permissive.
 */
export function tightenSessionLoggingPolicy(
  base: SessionLoggingPolicy,
  tightening: SessionLoggingPolicyTightening,
): SessionLoggingPolicy {
  const parsedBase = parseSessionLoggingPolicy(base);
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

  return parseSessionLoggingPolicy({
    ...parsedBase,
    ...tightening,
    mode,
    includeReasoning: false,
    includeFileContent: false,
    includeToolContent: false,
  });
}

export function resolveSessionLoggingPolicy(input: {
  enabled: boolean;
  artifactPolicy?: SessionLoggingPolicy;
  user?: SessionLoggingPolicyTightening;
  project?: SessionLoggingPolicyTightening;
}): SessionLoggingPolicy {
  if (input.project?.mode === 'content') {
    throw new Error('Project config cannot enable content session logging.');
  }
  let resolved = parseSessionLoggingPolicy(input.artifactPolicy ?? DEFAULT_SESSION_LOGGING_POLICY_);
  if (!input.enabled) {
    resolved = tightenSessionLoggingPolicy(resolved, { mode: 'off' });
  } else if (resolved.mode === 'content' && input.user?.mode !== 'content') {
    // An artifact may permit content logging, but it never opts the user in.
    resolved = tightenSessionLoggingPolicy(resolved, { mode: 'metadata' });
  }
  if (input.user) resolved = tightenSessionLoggingPolicy(resolved, input.user);
  if (input.project) resolved = tightenSessionLoggingPolicy(resolved, input.project);
  return resolved;
}
