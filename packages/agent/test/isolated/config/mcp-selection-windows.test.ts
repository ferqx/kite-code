import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMcpSelection, updateMcpSelection } from '../../../src/config/mcp-selection';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../../src/platform/windows-path-security';

// Actual OS paths/ACLs only. Windows has no backend-availability skip.
test.skipIf(process.platform !== 'win32')(
  'MCP selection keeps private user capture/CAS and ordinary inherited-ACL project capture/CAS distinct',
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mcp-selection-native-')));
    try {
      const native = defaultWindowsPathSecurity()!;
      const profile = join(root, 'profile');
      privateDirectory(profile);
      const userPath = join(profile, 'config.jsonc'),
        workspacePath = join(root, 'kite-agent.jsonc');
      native.writePrivateFile(userPath, Buffer.from('{"unknown":1}'));
      writeFileSync(workspacePath, '// project untrusted\r\n{"unknown":2}\r\n');
      const options = {
        userPath,
        workspacePath,
        sourceIdentity: 'actual-owned-profile-workspace',
        explicit: () => ({}),
        registry: () => ({
          revision: 'trusted-registry',
          servers: [
            {
              id: 'owned',
              configDigest: 'a'.repeat(64),
              transport: 'stdio' as const,
              source: { kind: 'programmatic' as const, id: 'host:owned', revision: '1' },
              admitted: true,
            },
          ],
        }),
      };
      const first = readMcpSelection(options);
      expect(first.workspace?.value.unknown).toBe(2);
      const user = updateMcpSelection({
        ...options,
        scope: 'user',
        serverId: 'owned',
        enabled: true,
        expectedReadSet: first.readSet,
      });
      expect(user.value.unknown).toBe(1);
      expect(() => native.verifyFile(userPath)).not.toThrow();
      const current = readMcpSelection(options);
      const project = updateMcpSelection({
        ...options,
        scope: 'workspace',
        serverId: 'owned',
        enabled: false,
        expectedReadSet: current.readSet,
      });
      expect(project.value.unknown).toBe(2);
      expect(readFileSync(workspacePath, 'utf8')).toContain('// project untrusted');
      expect(() => native.verifyDirectory(root)).toThrow();
      expect(() =>
        updateMcpSelection({
          ...options,
          scope: 'workspace',
          serverId: 'owned',
          enabled: true,
          expectedReadSet: current.readSet,
        }),
      ).toThrow('configuration_read_set_conflict');
      const before = readFileSync(userPath);
      const widened = spawnSync('icacls.exe', [userPath, '/grant', '*S-1-1-0:(F)'], {
        encoding: 'utf8',
      });
      expect(widened.status).toBe(0);
      expect(() => readMcpSelection(options)).toThrow();
      expect(() =>
        updateMcpSelection({
          ...options,
          scope: 'user',
          serverId: 'owned',
          enabled: false,
          expectedReadSet: first.readSet,
        }),
      ).toThrow();
      expect(readFileSync(userPath)).toEqual(before);
      expect(() => native.verifyFile(userPath)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
