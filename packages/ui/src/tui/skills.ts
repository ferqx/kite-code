import type { SkillCataloguePage } from '@kite-ai/client';

/** Read all pages at one catalogue revision; never load Skill bodies or create work. */
export interface TuiSkillsPort {
  read(sessionId: string, workspaceId: string, signal: AbortSignal): Promise<SkillCataloguePage>;
}
export interface TuiSkillsSnapshot {
  readonly facts?: SkillCataloguePage;
  readonly read: 'reading' | 'verified' | 'unknown';
  readonly error?: 'skill_catalogue_unavailable' | NonNullable<SkillCataloguePage['reason']>;
}
