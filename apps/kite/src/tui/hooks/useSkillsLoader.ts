// ── Skills 扫描 ──

import { scanCompiledSkillManifests } from '@kite/builtin-runtime/skills';
import type { SkillManifest, SkillScanOptions } from '@kite/runtime-contract';
import type { Dispatch } from 'react';
import React from 'react';
import { skillDirs } from '#app/config/paths';
import type { Action } from '../reducers/actions';

export function useSkillsLoader(
  workspace: string,
  dispatch: Dispatch<Action>,
  skillManifestsRef: React.MutableRefObject<SkillManifest[]>,
  skillOptionsRef: React.MutableRefObject<SkillScanOptions | null>,
  sessionManager: { updateSkillManifests(m: SkillManifest[]): void },
) {
  React.useEffect(() => {
    const opts = skillDirs(workspace);
    skillOptionsRef.current = opts;
    const manifests = scanCompiledSkillManifests(opts);
    skillManifestsRef.current = manifests;
    dispatch({ type: 'SET_SKILL_MANIFESTS', manifests });
    sessionManager.updateSkillManifests(manifests);
  }, [
    workspace,
    dispatch,
    skillOptionsRef,
    skillManifestsRef,
    sessionManager.updateSkillManifests,
  ]);
}
