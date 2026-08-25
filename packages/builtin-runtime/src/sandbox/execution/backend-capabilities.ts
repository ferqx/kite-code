import type { ExecutionBackendCapabilities, SandboxExecutionBackend } from '@kite-ai/runtime-spi';

/** Conservative, accepted evidence projection. Discovery never upgrades an unsupported dimension. */
export function sandboxBackendCapabilities(
  backend: Exclude<SandboxExecutionBackend, 'none'>,
): Readonly<ExecutionBackendCapabilities> {
  if (backend === 'windows_restricted_token') {
    return deepFreeze({
      backend,
      filesystem: {
        read_only: 'unsupported',
        workspace_write: 'unsupported',
        full_access: 'unsupported',
      },
      network: { off: 'unsupported', allowlist: 'unsupported' },
      syscallFilter: 'unsupported',
      processTreeLimit: 'unsupported',
      childProcessInheritance: 'enforced',
      verifiedInProcessReadOnly: 'unsupported',
    });
  }
  return deepFreeze({
    backend,
    filesystem: {
      read_only: 'enforced',
      workspace_write: 'enforced',
      full_access: 'unsupported',
    },
    network: { off: 'enforced', allowlist: 'unsupported' },
    // Seccomp discovery is not accepted release evidence and cannot upgrade this field.
    syscallFilter: 'unsupported',
    processTreeLimit: 'unsupported',
    childProcessInheritance: 'enforced',
    verifiedInProcessReadOnly: 'unsupported',
  });
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
  }
  return value;
}
