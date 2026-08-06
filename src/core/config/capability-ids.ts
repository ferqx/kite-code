/**
 * Stable capability identifiers shared by configuration projections.
 *
 * This module deliberately contains identifiers only. It does not import
 * release evidence, gates, profiles, or admission evaluators, so diagnostic
 * inventory code can bind the public capability catalog without depending on
 * release-gate vocabulary.
 */
export const RELEASE_CAPABILITY_IDS_V1 = Object.freeze([
  'builtin_read_tools',
  'builtin_write_tools',
  'shell',
  'plan',
  'tool_search',
  'mcp_read',
  'mcp_write',
  'skills_readonly',
  'skills_effectful',
  'verification',
  'manual_compaction',
  'auto_compaction',
  'full_interaction_mode',
  'content_session_logging',
  'remote_telemetry',
] as const);

export type ReleaseCapabilityIdV1 = (typeof RELEASE_CAPABILITY_IDS_V1)[number];
