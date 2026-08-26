import { createHash } from 'node:crypto';
import { type SkillManifest, scanCompiledSkillManifests } from '@kite-ai/builtin-runtime/skills';
import {
  type KiteWorkspaceIdentity,
  SKILL_CATALOG_RESPONSE_SCHEMA_,
  type SkillCatalogRequest,
  type SkillCatalogSnapshot,
  skillCatalogRequestCodec,
  skillCatalogResponseCodec,
} from '@kite-ai/kite-app-contract';
import { skillDirs } from '#kite-cli/config/paths';
import { assertSameWorkspace, type SkillCatalogHandlerPort } from '../ports';

export interface SkillCatalogOwnerOptions {
  /** The already-admitted canonical Workspace owned by this catalog instance. */
  readonly workspace: KiteWorkspaceIdentity;
}

export interface SkillCatalogOwner extends SkillCatalogHandlerPort {
  /** Actual compiled-manifest metadata retained for Runtime Workspace composition. */
  getActualManifests(): readonly SkillManifest[];
}

function manifestMaterial(manifests: readonly SkillManifest[]): string {
  return JSON.stringify(
    manifests.map((manifest) => ({
      name: manifest.name,
      description: manifest.description,
      source: manifest.source,
      origin: manifest.origin,
    })),
  );
}

function revision(manifests: readonly SkillManifest[]): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update('kite.app.skill-catalog.v1\0')
    .update(manifestMaterial(manifests))
    .digest('hex')}`;
}

function freezeManifests(manifests: readonly SkillManifest[]): readonly SkillManifest[] {
  return Object.freeze(
    manifests.map((manifest) =>
      Object.freeze({
        name: manifest.name,
        description: manifest.description,
        source: manifest.source,
        origin: manifest.origin,
      }),
    ),
  );
}

function project(
  workspace: KiteWorkspaceIdentity,
  manifests: readonly SkillManifest[],
): SkillCatalogSnapshot {
  const snapshot: SkillCatalogSnapshot = {
    schema: SKILL_CATALOG_RESPONSE_SCHEMA_,
    workspace,
    revision: revision(manifests),
    skills: Object.freeze(
      manifests.map((manifest) => ({
        name: manifest.name,
        description: manifest.description,
        source: manifest.source,
        origin: manifest.origin,
        status: 'available' as const,
      })),
    ),
  };
  return skillCatalogResponseCodec.decode(skillCatalogResponseCodec.encode(snapshot));
}

/**
 * Workspace-scoped Skill owner. Scanner output is retained only as compiled-manifest metadata;
 * file paths, instruction bodies, and compiled Workflow Contracts never cross this boundary.
 */
export function createSkillCatalogOwner(input: SkillCatalogOwnerOptions): SkillCatalogOwner {
  let actualManifests: readonly SkillManifest[] | undefined;

  const refresh = (): readonly SkillManifest[] => {
    const scanned = scanCompiledSkillManifests(skillDirs(input.workspace.canonicalPath));
    actualManifests = freezeManifests(scanned);
    return actualManifests;
  };

  return Object.freeze({
    async snapshot(request: SkillCatalogRequest): Promise<SkillCatalogSnapshot> {
      const checked = skillCatalogRequestCodec.decode(skillCatalogRequestCodec.encode(request));
      assertSameWorkspace(input.workspace, checked.workspace, 'Skill catalog request');
      return project(input.workspace, refresh());
    },
    getActualManifests(): readonly SkillManifest[] {
      return actualManifests ?? refresh();
    },
  });
}
