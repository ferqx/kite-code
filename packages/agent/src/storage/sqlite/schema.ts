import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
// Query helpers for the hot read paths. The reviewed SQL migration owns constraints.
export const storageMeta = sqliteTable('storage_meta', {
  singleton: integer('singleton').primaryKey(),
  storeId: text('store_id').notNull(),
  formatMajor: integer('format_major').notNull(),
  replayFloor: integer('replay_floor').notNull(),
  lastChangeCursor: integer('last_change_cursor').notNull(),
});
export const commands = sqliteTable('command', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  status: text('status').notNull(),
  receiptJson: text('receipt_json'),
  requestJson: text('request_json').notNull(),
});
export const executions = sqliteTable('execution', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  state: text('state').notNull(),
  resultJson: text('result_json'),
  outputTruncated: integer('output_truncated').notNull(),
  outputBudgetExhausted: integer('output_budget_exhausted').notNull(),
});
export const workspaces = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  rootUri: text('root_uri').notNull(),
  name: text('name').notNull(),
});
export const blobs = sqliteTable('blob', {
  hash: text('hash').primaryKey(),
  size: integer('size').notNull(),
});
export const blobReferences = sqliteTable('blob_ref', {
  id: text('id').primaryKey(),
  hash: text('blob_hash').notNull(),
  sessionId: text('session_id').notNull(),
  subjectId: text('subject_id').notNull(),
  originStoreId: text('origin_store_id').notNull(),
  scopeKind: text('owner_kind').notNull(),
  scopeId: text('owner_id').notNull(),
  mediaType: text('media_type').notNull(),
});
export const interactions = sqliteTable('interaction', {
  informationPermissionJson: text('information_permission_json'),
  id: text('id').primaryKey(),
  originStoreId: text('origin_store_id').notNull(),
  sessionId: text('session_id').notNull(),
  presentationSessionId: text('presentation_session_id').notNull(),
});

export const contextSnapshots = sqliteTable('context_snapshot', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  kind: text('kind').notNull(),
  requestJson: text('request_json').notNull(),
});

export const runs = sqliteTable('run', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  deadlineAt: integer('deadline_at'),
  waitingResultsJson: text('waiting_results_json').notNull(),
});
