import { ClientError, decodeResponse } from './decode';
import type { SkillCataloguePage } from './generated/api';

export interface SkillCatalogueVerificationOptions {
  readonly storeId?: string;
  readonly workspaceId?: string;
  readonly revision?: string;
  readonly afterId?: string;
  readonly limit?: number;
  readonly workflow?: 'manual';
}

/** Verify the closed public metadata contract and retain a private copy of the input. */
export function verifySkillCataloguePage(
  value: unknown,
  options: SkillCatalogueVerificationOptions = {},
): SkillCataloguePage {
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    throw new ClientError('invalid_response');
  }
  const page = decodeResponse('SkillCataloguePage', copy);
  if (
    (options.storeId !== undefined && page.storeId !== options.storeId) ||
    (options.workspaceId !== undefined && page.workspaceId !== options.workspaceId)
  )
    throw new ClientError('skill_catalogue_identity_mismatch');
  if (options.revision !== undefined && page.revision !== options.revision)
    throw new ClientError('skill_catalogue_changed');
  if (options.limit !== undefined && page.entries.length > options.limit)
    throw new ClientError('invalid_response');
  let previous = options.afterId ?? '';
  for (const entry of page.entries) {
    if (
      entry.id <= previous ||
      (entry.state === 'available' &&
        (!entry.enabled ||
          entry.name === null ||
          !entry.version ||
          entry.reason !== null ||
          entry.missingCapabilities.length)) ||
      (entry.state === 'disabled' && (entry.enabled || entry.reason !== null)) ||
      (entry.state === 'unavailable' && (!entry.enabled || entry.reason === null))
    )
      throw new ClientError('invalid_response');
    const workflow = entry.workflow;
    if (
      (options.workflow === 'manual') !== (workflow !== undefined) ||
      (workflow &&
        ((workflow.state === 'available' &&
          (entry.state !== 'available' ||
            !workflow.skillId ||
            !workflow.name ||
            !workflow.revision ||
            workflow.reason !== null ||
            !workflow.manualAllowed ||
            !workflow.emptyInputValid ||
            workflow.contextMode === null)) ||
          (workflow.state !== 'available' && workflow.reason === null) ||
          (workflow.name !== null && workflow.skillId !== `skill:${workflow.name}`)))
    )
      throw new ClientError('invalid_response');
    previous = entry.id;
  }
  if (
    page.complete !== (page.nextAfterId === null) ||
    (!page.complete && (!page.entries.length || page.nextAfterId !== previous)) ||
    (page.availability === 'available' && page.reason !== null) ||
    (page.availability === 'unavailable' &&
      (page.reason === null || page.entries.length || !page.complete))
  )
    throw new ClientError('invalid_response');
  return page;
}
