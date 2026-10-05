import { createHash } from 'node:crypto';
import { type AfterTurnPolicy, AgentError } from '@kite-ai/agent';
import type { PermissionControlRead } from '@kite-ai/agent/storage';
import type { ChildRole } from './child-configuration';

export type DefaultAfterTurnInput = Parameters<AfterTurnPolicy['authorize']>[0];
export interface DefaultAfterTurnCurrent {
  readonly workspaceTrust: boolean;
  readonly revision: string;
  readonly controlReads?: readonly PermissionControlRead[];
}

/** Reporting eligibility only. Ordinary Task, carrier and report dispatch retain their permissions. */
export function createDefaultAfterTurnPolicy(options: {
  readonly roles: readonly ChildRole[];
  readonly readCurrent: (input: DefaultAfterTurnInput) => Promise<DefaultAfterTurnCurrent>;
}): AfterTurnPolicy {
  const roles = new Map<string, string>();
  for (const role of options.roles) {
    if (
      !/^[A-Za-z0-9_.-]{1,128}$/.test(role.id) ||
      typeof role.version !== 'string' ||
      !role.version ||
      role.version.length > 128 ||
      roles.has(role.id)
    )
      throw new AgentError('invalid_child_configuration');
    roles.set(role.id, role.version);
  }
  const readCurrent = options.readCurrent;
  const denied = Object.freeze({ allowed: false, revision: 'default-after-turn-denied-1' });
  return Object.freeze({
    async authorize(input: DefaultAfterTurnInput) {
      input.signal.throwIfAborted();
      const { command, run, session, execution, configuration, phase } = input;
      // Runtime wraps the actual Service role marker in its immutable model/tool snapshot.
      const assembled = configuration.snapshot;
      const snapshot =
        assembled && typeof assembled === 'object' && !Array.isArray(assembled)
          ? assembled.snapshot
          : undefined;
      if (
        !['request', 'apply'].includes(phase) ||
        !['run.start', 'input.follow_up', 'child.start'].includes(command.kind) ||
        execution.kind !== 'tool' ||
        !['task', 'followup_task'].includes(execution.definitionId) ||
        execution.definitionVersion !== '1' ||
        command.sessionId !== session.id ||
        run.sessionId !== session.id ||
        execution.sessionId !== session.id ||
        execution.runId !== run.id ||
        run.originCommandId !== command.id ||
        execution.originCommandId !== command.id ||
        execution.originStoreId !== run.originStoreId ||
        command.originStoreId !== run.originStoreId ||
        execution.rootWorkCommandId !== run.rootWorkCommandId ||
        command.rootWorkCommandId !== run.rootWorkCommandId ||
        execution.rootWorkSeq !== run.rootWorkSeq ||
        command.rootWorkSeq !== run.rootWorkSeq ||
        command.cancelRequestedAt !== null ||
        execution.cancelRequestedAt !== null ||
        session.deletedAt !== null ||
        (phase === 'request' &&
          (!run.isActive ||
            run.status !== 'running' ||
            !['dispatching', 'running'].includes(execution.status))) ||
        (phase === 'apply' &&
          (!(run.isActive ? run.status === 'running' : run.status === 'completed') ||
            execution.status !== 'succeeded')) ||
        roles.get(configuration.id) !== configuration.version ||
        !snapshot ||
        typeof snapshot !== 'object' ||
        Array.isArray(snapshot) ||
        snapshot.roleId !== configuration.id ||
        snapshot.roleVersion !== configuration.version ||
        (execution.definitionId === 'task' &&
          (!execution.input ||
            typeof execution.input !== 'object' ||
            Array.isArray(execution.input) ||
            execution.input.role !== configuration.id))
      )
        return denied;
      const current = await readCurrent(input);
      input.signal.throwIfAborted();
      if (current.workspaceTrust !== true) return denied;
      if (
        typeof current.revision !== 'string' ||
        !current.revision ||
        current.revision.length > 4096
      )
        throw new AgentError('after_turn_authorization_invalid');
      const reads = current.controlReads?.map((read) => ({ ...read }));
      const keys = new Set<string>();
      for (const read of reads ?? []) {
        const key = `${read.kind}/${read.scope}`;
        if (
          !['permission.mode', 'workspace.trust'].includes(read.kind) ||
          typeof read.scope !== 'string' ||
          !read.scope ||
          typeof read.revision !== 'string' ||
          !read.revision ||
          keys.has(key)
        )
          throw new AgentError('after_turn_authorization_invalid');
        keys.add(key);
      }
      reads?.sort((a, b) => `${a.kind}/${a.scope}`.localeCompare(`${b.kind}/${b.scope}`));
      const revision = createHash('sha256')
        .update(
          JSON.stringify({
            policy: 'default-task-after-turn-1',
            storeId: run.originStoreId,
            sessionId: session.id,
            rootSessionId: session.rootSessionId,
            subjectId: command.subjectId,
            commandId: command.id,
            runId: run.id,
            rootWorkCommandId: run.rootWorkCommandId,
            rootWorkSeq: run.rootWorkSeq,
            executionId: execution.id,
            definitionId: execution.definitionId,
            definitionVersion: execution.definitionVersion,
            roleId: configuration.id,
            roleVersion: configuration.version,
            currentRevision: current.revision,
            workspaceTrust: current.workspaceTrust,
            controlReads: reads ?? null,
          }),
        )
        .digest('hex');
      return Object.freeze({
        allowed: true,
        revision,
        ...(reads ? { controlReads: Object.freeze(reads.map((read) => Object.freeze(read))) } : {}),
      });
    },
  });
}
