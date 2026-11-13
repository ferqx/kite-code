import { builtinComputerUseSkillId, createBuiltinComputerUseSkillSource } from './builtin';
import { builtinOfficeSkillId, createBuiltinOfficeSkillSource } from './office';
/** Packaged immutable knowledge. This registry grants no runtime or filesystem authority. */
export function createBuiltinSkillSources() {
  return [
    { id: builtinComputerUseSkillId, source: createBuiltinComputerUseSkillSource() },
    { id: builtinOfficeSkillId, source: createBuiltinOfficeSkillSource() },
  ];
}
