import type { KiteAppControlClient, KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import type { SkillManifest } from '@kite-ai/runtime-contract';
import type { Dispatch } from 'react';
import React from 'react';
import type { Action } from '../reducers/actions';

/** TUI-safe Skill projection; scanning and compiled manifests remain in the Workspace owner. */
export function useSkillsLoader(
  appControl: KiteAppControlClient,
  workspace: KiteWorkspaceIdentity,
  dispatch: Dispatch<Action>,
  skillManifestsRef: React.MutableRefObject<SkillManifest[]>,
) {
  React.useEffect(() => {
    let cancelled = false;
    void appControl
      .getSkillCatalog({ schema: 'kite.app.skill-catalog.request.v1', workspace })
      .then((snapshot) => {
        if (cancelled) return;
        const manifests = snapshot.skills
          .filter((skill) => skill.status === 'available')
          .map((skill) => ({
            name: skill.name,
            description: skill.description,
            source: skill.source,
            origin: skill.origin,
          }));
        skillManifestsRef.current = manifests;
        dispatch({ type: 'SET_SKILL_MANIFESTS', manifests });
      })
      .catch(() => {
        if (cancelled) return;
        skillManifestsRef.current = [];
        dispatch({ type: 'SET_SKILL_MANIFESTS', manifests: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [appControl, dispatch, skillManifestsRef, workspace]);
}
