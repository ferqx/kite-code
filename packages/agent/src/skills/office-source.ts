import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SkillError, type SkillSummary } from './index';
import upstream from './office-manifest.json';

type OfficeSkill = keyof typeof upstream.skills;
type File = (typeof upstream.skills)[OfficeSkill]['files'][number];
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

/** The exact source and built asset layouts. A workspace path cannot supply a builtin. */
export function bundledOfficeSkillDirectory(): string | undefined {
  const roots =
    import.meta.file === 'office-source.ts'
      ? [join(import.meta.dir, '..', '..', 'assets', 'office')]
      : [join(import.meta.dir, 'office'), join(import.meta.dir, 'skills', 'office')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stat = lstatSync(root);
    if (stat.isDirectory() && !stat.isSymbolicLink()) return realpathSync(root);
  }
  return undefined;
}

function createOfficeSkillSource(key: OfficeSkill) {
  const { name, directory, description, files } = upstream.skills[key];
  const textFiles = files.filter((file) => !('binary' in file && file.binary));
  const byPath = new Map(textFiles.map((file) => [file.path, file]));
  const appendix =
    key === 'pdf'
      ? `\n\n## Kite runtime\n\nThe bundled copies of this skill and its support files are read-only. Resolve this skill's relative paths from the \`${directory}\` directory under \`KITE_OFFICE_SKILLS_DIR\`. In PowerShell this is \`$env:KITE_OFFICE_SKILLS_DIR\`. Use the Shell and file operations already authorized for your run. Work from the attached source copy. When the user requests a revised file, write the completed new file to the current Shell's \`KITE_OUTPUT_DIR\`. Use dependencies available to that Shell.\n`
      : '';
  const revision = key === 'pdf' ? upstream.pdfRevision : upstream.officeCliRevision;
  const id = `builtin:office.${key}`;
  const version = hash(JSON.stringify([revision, key, files, appendix]));
  const summary: SkillSummary = {
    id,
    version,
    name,
    description,
    location: `${id}/SKILL.md`,
    requiredCapabilities: [],
  };
  const resourceId = (path: string) => hash(`${id}:${version}:${path}`);
  let discovered = false;
  let closed = false;

  function check(selected: string, expected?: string) {
    if (closed) throw new SkillError('knowledge_source_closed');
    if (!discovered || selected !== id) throw new SkillError('skill_not_discovered');
    if (expected !== undefined && expected !== version)
      throw new SkillError('skill_version_changed');
  }

  async function read(file: File) {
    const root = bundledOfficeSkillDirectory();
    if (!root) throw new SkillError('skill_unavailable');
    const bytes = await readFile(join(root, directory, file.path)).catch(() => {
      throw new SkillError('skill_unavailable');
    });
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new SkillError('skill_version_changed');
    return bytes.toString('utf8');
  }

  const document = async () => ({
    ...structuredClone(summary),
    body: (await read(byPath.get('SKILL.md')!)) + appendix,
  });
  return {
    async list() {
      if (closed) throw new SkillError('knowledge_source_closed');
      discovered = true;
      return { entries: [structuredClone(summary)], errors: [] };
    },
    async load(input: { id: string; version?: string; availableCapabilities?: readonly string[] }) {
      check(input.id, input.version);
      return {
        ...(await document()),
        resources: textFiles
          .filter((file) => file.path !== 'SKILL.md')
          .map(({ path }) => ({ id: resourceId(path), path })),
      };
    },
    async readDocument(input: { id: string; version: string; maxTextBytes: number }) {
      check(input.id, input.version);
      if (!Number.isSafeInteger(input.maxTextBytes) || input.maxTextBytes < 1)
        throw new SkillError('invalid_skill_configuration');
      const value = await document();
      if (Buffer.byteLength(value.body) > input.maxTextBytes)
        throw new SkillError('skill_text_limit');
      return value;
    },
    async readResource(input: {
      skillId: string;
      version: string;
      path: string;
      availableCapabilities?: readonly string[];
    }) {
      check(input.skillId, input.version);
      const file = byPath.get(input.path);
      if (!file || file.path === 'SKILL.md') throw new SkillError('skill_resource_not_declared');
      return { id: resourceId(file.path), version: file.sha256, body: await read(file) };
    },
    async dispose() {
      closed = true;
    },
  };
}

export function createPackagedOfficeSkillSources() {
  return (Object.keys(upstream.skills) as OfficeSkill[]).map((name) => ({
    id: `office.${name}`,
    source: createOfficeSkillSource(name),
  }));
}
