import { z } from 'zod';
import { opaqueIdSchema } from './evidence';

/** Presence of public output only, sealed with its original material reference. No body bytes. */
export const trajectoryOutputPresenceSchema = z.strictObject({
  hasText: z.boolean(),
  toolCallCount: z.number().int().nonnegative().safe(),
  complete: z.boolean(),
  evidenceId: opaqueIdSchema,
  contentVersion: opaqueIdSchema,
});
export type TrajectoryOutputPresence = z.infer<typeof trajectoryOutputPresenceSchema>;

/** First-party owner-sealed index values, including explicitly bounded public text snippets.
 * Never an authorization, private prompt/reasoning, or a complete material body. */
export const trajectoryDisplaySchema = z.strictObject({
  kind: z.enum([
    'model',
    'file',
    'shell',
    'task',
    'web',
    'browser',
    'plan',
    'skill',
    'worktree',
    'question',
    'message',
  ]),
  title: z.string().min(1).max(160).optional(),
  summary: z.string().min(1).max(320).optional(),
  modelName: z.string().min(1).max(160).optional(),
  outputPresence: trajectoryOutputPresenceSchema.optional(),
  operation: z
    .enum([
      'request',
      'read',
      'write',
      'edit',
      'execute',
      'launch',
      'wait',
      'stop',
      'spawn',
      'follow_up',
      'message',
      'events',
      'list',
      'interrupt',
      'fetch',
      'open',
      'snapshot',
      'click',
      'fill',
      'scroll',
      'press',
      'hover',
      'select',
      'back',
      'forward',
      'reload',
      'close',
      'capture',
      'image',
      'view',
      'request_human',
      'update',
      'review',
      'load',
      'resource',
      'create',
      'remove',
      'ask',
    ])
    .optional(),
  targetExecutionId: opaqueIdSchema.optional(),
  targetExecutionOriginStoreId: opaqueIdSchema.optional(),
  targetSessionId: opaqueIdSchema.optional(),
  targetRunId: opaqueIdSchema.optional(),
  observedStatus: z
    .enum([
      'planned',
      'dispatching',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'outcome_unknown',
    ])
    .optional(),
  accepted: z.boolean().optional(),
  terminal: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  exitCode: z.number().int().safe().optional(),
  requestContext: z
    .strictObject({
      systemMessages: z.number().int().nonnegative().safe(),
      historyMessages: z.number().int().nonnegative().safe(),
      tools: z.number().int().nonnegative().safe(),
    })
    .optional(),
});
export type TrajectoryDisplay = z.infer<typeof trajectoryDisplaySchema>;
export const trajectoryMessageDisplaySchema = trajectoryDisplaySchema.pick({ title: true }).extend({
  kind: z.literal('message'),
  summary: z.string().min(1).max(160).optional(),
  outputPresence: trajectoryOutputPresenceSchema.optional(),
});
