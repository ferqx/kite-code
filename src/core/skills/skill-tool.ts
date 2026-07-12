import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { getSkillContent } from './loader';
import type { SkillManifest, SkillScanOptions } from './types';

export function createSkillTool(manifests: SkillManifest[], options: SkillScanOptions) {
  return tool({
    description:
      'Invoke a skill to get specialized instructions when its description matches your task. ' +
      'Available skills are listed in the system prompt. ' +
      'Invoking a skill loads detailed instructions you MUST follow.',
    inputSchema: zodSchema(
      z.object({
        skill: z.string().describe('Name of the skill to invoke'),
      }),
    ),
    execute: async ({ skill }: { skill: string }) => {
      const result = getSkillContent(manifests, skill, options);
      if (!result) {
        return JSON.stringify({ ok: false, error: `Skill not found: ${skill}` });
      }
      return JSON.stringify({ ok: true, name: result.name, content: result.content });
    },
  });
}
