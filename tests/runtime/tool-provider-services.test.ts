import { describe, expect, test } from 'bun:test';
import type { SkillActivationContext } from '@kite-ai/builtin-runtime/skills';
import { createSkillMechanismPort } from '#app/bootstrap/runtime/tool-provider-services';

describe('App Tool Provider services', () => {
  test('projects only the minimal frozen Skill state view into Builtin Runtime', () => {
    const runtime: SkillActivationContext = {
      state: {
        activeTaskId: 'task-1',
        session: { workspace: '/workspace' },
        skills: { catalogRevision: 'skills-1', frames: {} },
      },
      verificationEnabled: false,
    };

    const mechanism = createSkillMechanismPort(runtime);

    expect(mechanism).toBeDefined();
    expect(Object.keys(mechanism?.state ?? {}).sort()).toEqual([
      'activeTaskId',
      'session',
      'skills',
    ]);
    expect(mechanism?.state.session).toEqual({ workspace: '/workspace' });
    expect(Object.isFrozen(mechanism)).toBe(true);
    expect(Object.isFrozen(mechanism?.state)).toBe(true);
    expect(Object.isFrozen(mechanism?.state.skills.frames)).toBe(true);
  });
});
