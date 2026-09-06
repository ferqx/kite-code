import { describe, expect, test } from 'bun:test';
import {
  digestCapabilityBindingValue,
  PLANNING_CAPABILITY_REVISION_,
  PLANNING_OPERATION_ID_,
  SHELL_EXECUTE_INPUT_SCHEMA_,
  SHELL_SEMANTICS_REGISTRY_,
  SHELL_SEMANTICS_REGISTRY_SCHEMA_,
  SHELL_SEMANTICS_REVISION_,
  shellSemanticInspector,
} from '@kite-ai/builtin-runtime';

describe('versioned Shell semantics registry', () => {
  test('is immutable, closed, and resolves only declared programs', () => {
    expect(SHELL_SEMANTICS_REGISTRY_).toMatchObject({
      schema: SHELL_SEMANTICS_REGISTRY_SCHEMA_,
      revision: 1,
    });
    expect(Object.isFrozen(SHELL_SEMANTICS_REGISTRY_)).toBe(true);
    expect(Object.isFrozen(SHELL_SEMANTICS_REGISTRY_.programs)).toBe(true);
    expect(Object.isFrozen(SHELL_SEMANTICS_REGISTRY_.git)).toBe(true);
    expect(shellSemanticInspector('git')).toBe('git');
    expect(shellSemanticInspector('ls')).toBe('always_read_only');
    expect(shellSemanticInspector('custom-project-script')).toBeUndefined();
  });

  test('binds the registry revision into the shell capability identity', () => {
    expect(SHELL_SEMANTICS_REVISION_).toBe(digestCapabilityBindingValue(SHELL_SEMANTICS_REGISTRY_));
    expect(PLANNING_CAPABILITY_REVISION_).toBe(
      digestCapabilityBindingValue({
        schema: 'kite.planning-operation-capability.current',
        operationId: PLANNING_OPERATION_ID_,
        inputSchema: SHELL_EXECUTE_INPUT_SCHEMA_,
        effects: {
          filesystem: 'unknown',
          network: 'unknown',
          externalState: 'unknown',
        },
        shellSemanticsRevision: SHELL_SEMANTICS_REVISION_,
      }),
    );
  });
});
