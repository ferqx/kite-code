import {
  type KiteWorkspaceIdentity,
  type SkillCatalogRequest,
  type SkillCatalogSnapshot,
  skillCatalogRequestCodec,
  skillCatalogResponseCodec,
} from '@kite-ai/kite-app-contract';
import {
  assertAdmittedWorkspace,
  assertSameWorkspace,
  type SkillCatalogHandlerPort,
} from './ports';

export interface SkillCatalogHandlerDependencies {
  readonly handler: SkillCatalogHandlerPort;
  readonly workspace?: KiteWorkspaceIdentity;
}

export function createSkillCatalogHandler(
  input: SkillCatalogHandlerDependencies,
): SkillCatalogHandlerPort {
  return Object.freeze({
    async snapshot(request: SkillCatalogRequest): Promise<SkillCatalogSnapshot> {
      const checked = skillCatalogRequestCodec.decode(skillCatalogRequestCodec.encode(request));
      assertAdmittedWorkspace(input.workspace, checked.workspace, 'Skill catalog request');
      const response = await input.handler.snapshot(checked);
      const projected = skillCatalogResponseCodec.decode(
        skillCatalogResponseCodec.encode(response),
      );
      assertSameWorkspace(checked.workspace, projected.workspace, 'Skill catalog response');
      return projected;
    },
  });
}
