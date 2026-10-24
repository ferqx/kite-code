import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { privateDirectory } from '../../maintenance/files';
import { AgentError } from '../../storage/types';
import type { FileBaseline } from '../../tools/files';
import { createWorkspaceFiles } from '../../tools/files';

/** Persisted relative locator; approval still belongs exclusively to Planning records. */
export interface PlanFile {
  path: string;
  hash: string;
  size: number;
}
export interface PlanFiles {
  describe(input: {
    storeId: string;
    sessionId: string;
    planId: string;
    body: string;
    previous: PlanFile | null;
  }): PlanFile;
  publish(input: {
    storeId: string;
    sessionId: string;
    planId: string;
    body: string;
    previous: PlanFile | null;
    recover?: boolean;
    fileBase?: FileBaseline | null;
  }): Promise<PlanFile>;
  verify(file: PlanFile, body: string): Promise<void>;
  path(file: PlanFile): string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Host-selected Profile, with the same no-link native IO and complete baseline as file tools. */
export function createPlanFiles(profilePath: string): PlanFiles {
  const root = resolve(profilePath);
  function path(file: PlanFile) {
    if (
      !/^files\/[a-f0-9]{64}\/[a-f0-9]{64}\/plans\/[a-f0-9]{64}\/plan\.md$/.test(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.hash) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new AgentError('plan_file_invalid');
    return join(root, ...file.path.split('/'));
  }
  function relative(input: {
    storeId: string;
    sessionId: string;
    planId: string;
    previous: PlanFile | null;
  }) {
    if (!input.previous)
      return `files/${hash(input.storeId)}/${hash(input.sessionId)}/plans/${hash(input.planId)}/plan.md`;
    path(input.previous);
    const parts = input.previous.path.split('/');
    if (parts[2] !== hash(input.sessionId) || parts[4] !== hash(input.planId))
      throw new AgentError('plan_file_invalid');
    // A restored record keeps its original Store directory, within this admitted Session.
    return input.previous.path;
  }
  return {
    path,
    describe(input) {
      return {
        path: relative(input),
        hash: hash(input.body),
        size: Buffer.byteLength(input.body),
      };
    },
    async verify(file, body) {
      const target = path(file);
      const files = createWorkspaceFiles({ root: dirname(target), strictReads: true });
      try {
        const actual = await files.read(basename(target));
        if (
          actual.content !== body ||
          actual.baseline.hash !== file.hash ||
          actual.baseline.size !== file.size
        )
          throw new AgentError('plan_file_changed');
      } finally {
        await files.close();
      }
    },
    async publish(input) {
      const next = {
        path: relative(input),
        hash: hash(input.body),
        size: Buffer.byteLength(input.body),
      };
      const target = path(next);
      // Creation runs only inside the already-authorized Planning mutation, never during a query.
      privateDirectory(dirname(target), true);
      const files = createWorkspaceFiles({ root: dirname(target), strictReads: true });
      try {
        let base = null;
        if (input.recover) {
          try {
            const actual = await files.read(basename(target));
            if (
              actual.content === input.body &&
              actual.baseline.hash === next.hash &&
              actual.baseline.size === next.size
            )
              return next;
          } catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
              throw error;
          }
        }
        if (input.fileBase !== undefined) {
          base = input.fileBase;
        } else if (input.previous) {
          const actual = await files.read(basename(target));
          if (
            actual.baseline.hash !== input.previous.hash ||
            actual.baseline.size !== input.previous.size
          )
            throw new AgentError('plan_file_changed');
          base = actual.baseline;
        }
        const written = await files.write({ path: basename(target), content: input.body, base });
        if (written.baseline.hash !== next.hash || written.baseline.size !== next.size)
          throw new AgentError('plan_file_publish_unknown');
        return next;
      } finally {
        await files.close();
      }
    },
  };
}
