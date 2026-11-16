import { builtinComputerUseSkillId, createBuiltinComputerUseSkillSource } from './builtin';
import { createPackagedOfficeSkillSources } from './office-source';
/** Packaged immutable knowledge. This registry grants no runtime or filesystem authority. */
export function createBuiltinSkillSources() {
  return [
    { id: builtinComputerUseSkillId, source: createBuiltinComputerUseSkillSource() },
    ...createPackagedOfficeSkillSources(),
  ];
}
