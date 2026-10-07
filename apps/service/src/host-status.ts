import type { AgentRuntime } from '@kite-ai/agent';
import { AgentError } from '@kite-ai/agent';
import type { z } from 'zod';
import type { HostStatusSchema } from './http/schema/host-status';
import type { PermissionManagementPort } from './permission-management';
import { inspectShellAssets, type ShellConfigurationOptions } from './shell-configuration';

export type HostStatus = z.infer<typeof HostStatusSchema>;
export interface HostStatusContext {
  runtime?: AgentRuntime;
  permissions?: PermissionManagementPort;
  subjectId: string;
  storeId: string | null;
  workspaceId?: string;
  sessionId?: string;
}
export interface HostStatusSource {
  snapshot(
    context: HostStatusContext,
  ): Promise<Pick<HostStatus, 'execution' | 'release' | 'telemetry'>>;
}
export function unavailableHostStatus(): Pick<HostStatus, 'execution' | 'release' | 'telemetry'> {
  return {
    execution: {
      state: 'unavailable',
      reason: 'diagnostic_source_unavailable',
      sandbox: { backend: 'none', available: false, qualification: 'unqualified' },
      shell: {
        configured: false,
        available: false,
        supervision: 'none',
        qualification: 'unavailable',
        reason: 'diagnostic_source_unavailable',
      },
      permissions: {
        state: 'unavailable',
        scope: 'unbound',
        mode: null,
        defaultMode: null,
        workspaceTrust: 'unavailable',
        reason: 'permission_source_unavailable',
      },
    },
    release: {
      state: 'unavailable',
      active: false,
      production: null,
      qualification: 'unverified',
      reason: 'diagnostic_source_unavailable',
    },
    telemetry: {
      state: 'unavailable',
      enabled: false,
      exporterConfigured: false,
      diskSpool: false,
      reason: 'diagnostic_source_unavailable',
    },
  };
}
/** Trusted host assets describe the selected boundary; JSONC cannot grant it or attest production. */
export function createDefaultHostStatusSource(options: {
  shell?: ShellConfigurationOptions;
  externalPermissionAuthority?: boolean;
}): HostStatusSource {
  const shell = options.shell ? structuredClone(options.shell) : undefined;
  const externalPermissionAuthority = options.externalPermissionAuthority === true;
  return Object.freeze({
    async snapshot(context: HostStatusContext) {
      const facts = unavailableHostStatus();
      facts.execution.state = 'available';
      facts.execution.reason = null;
      facts.release = {
        state: 'available',
        active: false,
        production: null,
        qualification: 'unverified',
        reason: 'release_manifest_not_bound',
      };
      facts.telemetry = {
        state: 'available',
        enabled: false,
        exporterConfigured: false,
        diskSpool: false,
        reason: 'exporter_not_configured',
      };
      facts.execution.shell = {
        configured: !!shell,
        available: false,
        supervision: 'none',
        qualification: 'not_configured',
        reason: 'shell_not_configured',
      };
      if (shell) {
        try {
          await inspectShellAssets(shell);
          facts.execution.shell = {
            configured: true,
            available: true,
            supervision: shell.host ? 'macos_coalition' : 'posix_group',
            qualification: shell.host ? 'darwin_host_boundary' : 'darwin_supervision_only',
            reason: null,
          };
          if (shell.host)
            facts.execution.sandbox = {
              backend: 'macos_seatbelt',
              available: true,
              qualification: 'host_scope',
            };
        } catch (error) {
          const code = error instanceof AgentError ? error.code : 'shell_asset_unavailable';
          facts.execution.shell = {
            configured: true,
            available: false,
            supervision: 'none',
            qualification: 'unavailable',
            reason:
              code === 'shell_platform_unqualified' || code === 'invalid_shell_configuration'
                ? code
                : 'shell_asset_unavailable',
          };
        }
      }
      const permissions = facts.execution.permissions;
      if (!context.runtime || !context.storeId) {
        permissions.reason = 'data_unavailable';
        return facts;
      }
      if (
        !context.permissions ||
        externalPermissionAuthority ||
        !context.permissions.readDefaultMode
      )
        return facts;
      const identity = { expectedStoreId: context.storeId, subjectId: context.subjectId };
      const defaults = await context.permissions.readDefaultMode(identity);
      permissions.state = 'unbound';
      permissions.scope = 'default';
      permissions.mode = defaults.mode;
      permissions.defaultMode = defaults.mode;
      permissions.workspaceTrust = 'unbound';
      permissions.reason = null;
      if (context.sessionId) {
        const selected = await context.permissions.readMode({
          ...identity,
          sessionId: context.sessionId,
        });
        permissions.mode = selected.mode;
        permissions.defaultMode = selected.defaultMode;
        permissions.scope = 'session';
        permissions.state = 'available';
      }
      if (context.workspaceId) {
        const trust = await context.permissions.readTrust({
          ...identity,
          workspaceId: context.workspaceId,
        });
        permissions.workspaceTrust = trust.status;
        permissions.state = 'available';
      }
      return facts;
    },
  });
}
