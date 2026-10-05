import type { SkillCataloguePage } from '@kite-ai/client';

export class CLIWorkflowActivationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
/** Resolve only the admitted complete public projection; never infer flags from local files. */
export function selectWorkflowActivations(page: SkillCataloguePage, selectors: readonly string[]) {
  function reject(code: string): never {
    throw new CLIWorkflowActivationError(code);
  }
  if (page.availability !== 'available' || !page.complete || page.nextAfterId !== null)
    reject('workflow_catalogue_unavailable');
  const seen = new Set<string>();
  return selectors.flatMap((selector) => {
    const compiled = page.entries.filter(
      (entry) =>
        entry.workflow && (entry.workflow.skillId === selector || entry.workflow.name === selector),
    );
    const matches = compiled.length
      ? compiled
      : page.entries.filter(
          (entry) =>
            entry.workflow && entry.workflow.state !== 'available' && entry.name === selector,
        );
    if (matches.length > 1) reject('workflow_activation_ambiguous');
    const workflow = matches[0]?.workflow;
    if (!workflow) reject('workflow_activation_unavailable');
    if (workflow.state !== 'available')
      reject(workflow.reason ?? 'workflow_activation_unavailable');
    if (!workflow.manualAllowed) reject('workflow_manual_not_allowed');
    if (!workflow.emptyInputValid) reject('workflow_input_required');
    if (!workflow.skillId || !workflow.revision) reject('workflow_activation_unavailable');
    if (seen.has(workflow.skillId)) return [];
    seen.add(workflow.skillId);
    return [{ key: `manual-${seen.size}`, skillId: workflow.skillId, input: {} }];
  });
}
