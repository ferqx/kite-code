import type { SkillCataloguePage } from '@kite-ai/client';
import { isFixedTuiCommandName } from './commands';

/** Read all pages at one catalogue revision; never load Skill bodies or create work. */
export interface TuiSkillsPort {
  readonly workflowActivation?: boolean;
  read(sessionId: string, workspaceId: string, signal: AbortSignal): Promise<SkillCataloguePage>;
}
export interface TuiSkillsSnapshot {
  readonly facts?: SkillCataloguePage;
  readonly read: 'reading' | 'verified' | 'unknown';
  readonly error?: 'skill_catalogue_unavailable' | NonNullable<SkillCataloguePage['reason']>;
}

/** Only a unique compiled manual Workflow with a valid empty input can be a command. */
export function manualWorkflow(page: SkillCataloguePage, name: string) {
  if (isFixedTuiCommandName(name)) return undefined;
  const matches = page.entries.filter((entry) => entry.workflow?.name === name);
  if (matches.length !== 1) return undefined;
  const entry = matches[0]!,
    workflow = entry.workflow;
  return entry.enabled &&
    workflow?.state === 'available' &&
    workflow.manualAllowed &&
    workflow.emptyInputValid &&
    workflow.skillId &&
    /^[a-f0-9]{64}$/.test(workflow.revision ?? '') &&
    workflow.extensionId === 'builtin.skill-workflow' &&
    workflow.definitionVersion === '1'
    ? workflow
    : undefined;
}
