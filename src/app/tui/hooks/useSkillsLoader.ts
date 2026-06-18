// ── Skills 扫描 ──

import type { Dispatch } from 'react';
import React from 'react';
import { skillDirs } from '@/core/config/paths';
import { scanSkills } from '@/core/skills/loader';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
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
    const manifests = scanSkills(opts);
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
