import { ClientError, decodeResponse } from './decode';
import type {
  SkillCataloguePage,
  UserSkillCataloguePage,
  UserSkillDocument,
  UserSkillDocumentQuery,
} from './generated/api';

export function verifyUserSkillDocument(
  value: unknown,
  identity: UserSkillDocumentQuery,
): UserSkillDocument {
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    throw new ClientError('invalid_response');
  }
  const document = decodeResponse('UserSkillDocument', copy);
  if (
    Object.entries(identity).some(
      ([key, value]) => document[key as keyof UserSkillDocument] !== value,
    )
  )
    throw new ClientError('skill_catalogue_identity_mismatch');
  if (new TextEncoder().encode(document.body).byteLength > 1048576)
    throw new ClientError('skill_text_limit');
  return document;
}

export interface SkillCatalogueVerificationOptions {
  readonly storeId?: string;
  readonly workspaceId?: string;
  readonly revision?: string;
  readonly afterId?: string;
  readonly limit?: number;
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
  verifyMetadata(page, options);
  return page;
}

export type UserSkillCatalogueVerificationOptions = Omit<
  SkillCatalogueVerificationOptions,
  'workspaceId'
>;

/** The global directory never accepts project identity, paths or Workflow activation metadata. */
export function verifyUserSkillCataloguePage(
  value: unknown,
  options: UserSkillCatalogueVerificationOptions = {},
): UserSkillCataloguePage {
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    throw new ClientError('invalid_response');
  }
  const page = decodeResponse('UserSkillCataloguePage', copy);
  if (options.storeId !== undefined && page.storeId !== options.storeId)
    throw new ClientError('skill_catalogue_identity_mismatch');
  verifyMetadata(page, options);
  return page;
}

function verifyMetadata(
  page: Pick<
    SkillCataloguePage,
    'revision' | 'entries' | 'complete' | 'nextAfterId' | 'availability' | 'reason'
  >,
  options: Omit<SkillCatalogueVerificationOptions, 'workspaceId' | 'storeId'>,
) {
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
}
