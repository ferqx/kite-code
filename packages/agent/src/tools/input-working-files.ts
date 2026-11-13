import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { setImmediate as yieldIo } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { WorkingInputFilesPort } from '../input-working-files';
import { AgentError } from '../storage/types';
import { createWorkspaceFileIo, type WorkspaceFileStat } from './files-io';

const identity = (stat: WorkspaceFileStat) => ({
  device: String(stat.dev),
  inode: String(stat.ino),
});
const missing = (error: unknown) => (error as { code?: string })?.code === 'ENOENT';
/** Uses the existing handle-relative native file engine. No link to the private Blob is created. */
export function createWorkingInputFiles(
  options: { protectedPaths?: readonly string[] } = {},
): WorkingInputFilesPort {
  return {
    async materialize(input) {
      input.signal?.throwIfAborted();
      const parts = input.relativePath.split('/');
      if (
        parts.length !== 3 ||
        parts[0] !== '.kite-inputs' ||
        !/^[a-f0-9]{64}$/.test(parts[1]!) ||
        !parts[2] ||
        ['.', '..'].includes(parts[2]) ||
        parts[2].includes('\\')
      )
        throw new AgentError('input_preparation_invalid');
      const root = fileURLToPath(input.rootUri);
      const canonicalRoot = realpathSync.native(root);
      for (const protectedPath of options.protectedPaths ?? []) {
        let canonicalProtected: string;
        try {
          canonicalProtected = realpathSync.native(protectedPath);
        } catch (error) {
          if (!missing(error)) throw error;
          canonicalProtected = resolve(protectedPath);
        }
        const below = relative(canonicalProtected, canonicalRoot);
        if (
          !below ||
          (!isAbsolute(below) &&
            below !== '..' &&
            !below.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
        )
          throw new AgentError('input_preparation_scope_denied');
      }
      const io = createWorkspaceFileIo(root, options.protectedPaths ?? [], true);
      const handles: number[] = [];
      let temp: string | undefined,
        parent = io.root;
      const verify = () => {
        input.signal?.throwIfAborted();
        io.verifyRoot();
      };
      const readExisting = async () => {
        const fd = io.openAt(parent, parts[2]!, 'read', true);
        try {
          const before = io.stat(fd);
          if (!before.isFile() || before.nlink !== 1n)
            throw new AgentError('input_preparation_changed');
          if (input.existing?.state !== 'bound') {
            const hash = createHash('sha256'),
              buffer = new Uint8Array(64 * 1024);
            let length = 0n,
              budget = 0;
            for (;;) {
              verify();
              const count = io.read(fd, buffer);
              if (!count) break;
              length += BigInt(count);
              if (length > BigInt(input.reference.size))
                throw new AgentError('input_file_content_mismatch');
              hash.update(buffer.subarray(0, count));
              budget += count;
              if (budget >= 4 * 1024 * 1024) {
                await yieldIo();
                budget = 0;
              }
            }
            if (
              length !== BigInt(input.reference.size) ||
              hash.digest('hex') !== input.reference.hash
            )
              throw new AgentError('input_file_content_mismatch');
          }
          const after = io.stat(fd);
          if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs ||
            before.size !== after.size
          )
            throw new AgentError('input_preparation_changed');
          verify();
          return identity(after);
        } finally {
          io.closeHandle(fd);
        }
      };
      let originalError: unknown;
      try {
        verify();
        io.verifyOwner(io.root);
        const rootIdentity = identity(io.stat(io.root));
        if (
          input.existing &&
          JSON.stringify(rootIdentity) !== JSON.stringify(input.existing.rootIdentity)
        )
          throw new AgentError('input_preparation_changed');
        for (const part of parts.slice(0, -1)) {
          let next: number;
          try {
            next = io.openAt(parent, part, 'directory', true);
          } catch (error) {
            if (!missing(error) || input.existing) throw error;
            next = io.openAt(parent, part, 'create-directory', true);
          }
          handles.push(next);
          parent = next;
          io.verifyOwner(parent);
        }
        try {
          const fileIdentity = await readExisting();
          return {
            rootIdentity,
            fileIdentity:
              input.existing?.state === 'bound' ? input.existing.fileIdentity : fileIdentity,
          };
        } catch (error) {
          if (!missing(error) || input.existing) throw error;
        }
        temp = `.kite-input-${randomUUID()}`;
        const fd = io.openAt(parent, temp, 'temporary', true);
        handles.push(fd);
        const hash = createHash('sha256');
        let length = 0n,
          budget = 0;
        for await (const chunk of input.content()) {
          verify();
          length += BigInt(chunk.byteLength);
          if (length > BigInt(input.reference.size) || length > 256n * 1024n * 1024n)
            throw new AgentError('input_file_content_mismatch');
          hash.update(chunk);
          io.write(fd, chunk);
          budget += chunk.byteLength;
          if (budget >= 4 * 1024 * 1024) {
            await yieldIo();
            budget = 0;
          }
        }
        if (length !== BigInt(input.reference.size) || hash.digest('hex') !== input.reference.hash)
          throw new AgentError('input_file_content_mismatch');
        io.sync(fd);
        verify();
        io.publishAt(parent, temp, parts[2]!, true);
        if (io.createOnlyLeavesTemporary) io.unlinkAt(parent, temp, true);
        temp = undefined;
        io.sync(parent);
        const fileIdentity = await readExisting();
        if (JSON.stringify(fileIdentity) !== JSON.stringify(identity(io.stat(fd))))
          throw new AgentError('input_preparation_changed');
        return { rootIdentity, fileIdentity };
      } catch (error) {
        originalError = error;
        throw error;
      } finally {
        // Never delete the published working copy, including after an unknown Store ACK.
        const errors: unknown[] = [];
        if (temp)
          try {
            io.unlinkAt(parent, temp, true);
          } catch (error) {
            if (!missing(error)) errors.push(error);
          }
        for (const handle of handles.reverse())
          try {
            io.closeHandle(handle);
          } catch (error) {
            errors.push(error);
          }
        try {
          io.close();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) {
          // Cleanup uncertainty must override success, retaining the original failure as evidence.
          // biome-ignore lint/correctness/noUnsafeFinally: an unclosed native owner must never report known completion
          throw new AggregateError(
            originalError === undefined ? errors : [originalError, ...errors],
            'input_preparation_cleanup_unknown',
          );
        }
      }
    },
  };
}
