import type {
  ExecutionBackendCapabilitiesV1,
  SandboxExecutionBackendV1,
} from '@/protocol/sandbox-execution-provider';

/** Conservative, accepted evidence projection. Discovery never upgrades an unsupported dimension. */
export function sandboxBackendCapabilitiesV1(
  backend: Exclude<SandboxExecutionBackendV1, 'none'>,
): Readonly<ExecutionBackendCapabilitiesV1> {
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
