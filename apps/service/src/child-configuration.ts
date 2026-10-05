import { AgentError, type RunConfiguration, type RuntimeOptions } from '@kite-ai/agent';
import type { Json } from '@kite-ai/agent/extensions';

export interface SkillSelection {
  readonly requested: readonly string[] | null;
  readonly resolvedIds: readonly string[];
}
function skillMarker(value: Json | undefined): SkillSelection {
  const strings = (items: Json | undefined) =>
    Array.isArray(items) &&
    items.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 128);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'requested,resolvedIds' ||
    (value.requested !== null &&
      (!strings(value.requested) || (value.requested as Json[]).length > 256)) ||
    !strings(value.resolvedIds) ||
    new Set(value.resolvedIds as string[]).size !== (value.resolvedIds as string[]).length
  )
    throw new AgentError('child_skill_selection_unavailable');
  return Object.freeze({
    requested: value.requested === null ? null : Object.freeze([...(value.requested as string[])]),
    resolvedIds: Object.freeze([...(value.resolvedIds as string[])]),
  });
}
/** Only the Runtime-supplied original parent Run supplies this host marker. */
export function readSkillSelection(configuration: Json | undefined): SkillSelection {
  const snapshot =
    configuration && typeof configuration === 'object' && !Array.isArray(configuration)
      ? configuration.snapshot
      : undefined;
  return skillMarker(
    snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? snapshot.skillSelection
      : undefined,
  );
}

/** Trusted host declarations only. Files cannot register roles or grant capabilities. */
export interface ChildRole {
  readonly id: string;
  readonly version: string;
  readonly modelId?: string;
  readonly toolIds?: readonly string[];
}
type ChildInput = Parameters<NonNullable<RuntimeOptions['resolveChildRunConfiguration']>>[0];
export interface ChildSelection {
  readonly role: ChildRole;
  readonly modelId: string;
}

export function createChildConfiguration(options: {
  roles?: readonly ChildRole[];
  resolve(input: ChildInput, selection: ChildSelection): Promise<RunConfiguration>;
}): Pick<RuntimeOptions, 'childConfigurations' | 'resolveChildRunConfiguration'> {
  const roles = new Map<string, ChildRole>();
  if ((options.roles?.length ?? 0) > 128) throw new AgentError('invalid_child_configuration');
  for (const input of options.roles ?? []) {
    if (
      !input ||
      Object.keys(input).some((key) => !['id', 'version', 'modelId', 'toolIds'].includes(key)) ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(input.id) ||
      roles.has(input.id) ||
      typeof input.version !== 'string' ||
      !input.version ||
      input.version.length > 128 ||
      (input.modelId !== undefined &&
        (typeof input.modelId !== 'string' || !input.modelId || input.modelId.length > 256)) ||
      (input.toolIds !== undefined &&
        (!Array.isArray(input.toolIds) ||
          input.toolIds.length > 512 ||
          input.toolIds.some((id) => typeof id !== 'string' || !id || id.length > 256) ||
          new Set(input.toolIds).size !== input.toolIds.length))
    )
      throw new AgentError('invalid_child_configuration');
    roles.set(
      input.id,
      Object.freeze({
        ...input,
        ...(input.toolIds ? { toolIds: Object.freeze([...input.toolIds]) } : {}),
      }),
    );
  }
  if (!roles.size) return {};
  return {
    childConfigurations: [...roles.values()].map((role) => ({
      id: role.id,
      version: role.version,
      modelId: role.modelId ?? 'child.unresolved',
      model: {
        stream() {
          throw new AgentError('child_configuration_unresolved');
        },
      },
      toolIds: [],
      inputSchema: {
        type: 'object',
        required: ['content'],
        additionalProperties: false,
        properties: { content: { type: 'string' } },
      },
      snapshot: { roleId: role.id, roleVersion: role.version, unresolved: true },
    })),
    async resolveChildRunConfiguration(input) {
      input.signal.throwIfAborted();
      const role = roles.get(input.configurationId);
      if (!role) throw new AgentError('child_configuration_unavailable');
      const original = input.parentRun?.configuration;
      const parentModelId =
        original && typeof original === 'object' && !Array.isArray(original)
          ? original.modelId
          : undefined;
      const modelId = role.modelId ?? parentModelId;
      if (typeof modelId !== 'string' || !modelId) throw new AgentError('child_model_unavailable');
      const configuration = await options.resolve(input, { role, modelId });
      try {
        input.signal.throwIfAborted();
        if (!configuration.model) throw new AgentError('child_model_unavailable');
        if (configuration.modelId !== modelId) throw new AgentError('child_model_binding_mismatch');
        return {
          ...configuration,
          snapshot: {
            ...(configuration.snapshot &&
            typeof configuration.snapshot === 'object' &&
            !Array.isArray(configuration.snapshot) &&
            configuration.snapshot.skillSelection !== undefined
              ? {
                  skillSelection: skillMarker(
                    configuration.snapshot.skillSelection,
                  ) as unknown as Json,
                }
              : {}),
            roleId: role.id,
            roleVersion: role.version,
            roleModelId: role.modelId ?? null,
            roleToolIds: role.toolIds ? [...role.toolIds] : null,
            configuration: configuration.snapshot,
          },
        };
      } catch (error) {
        await configuration.dispose?.();
        throw error;
      }
    },
  };
}
