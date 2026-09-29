import type { RuntimeProtocolWorkspaceRemovalDetailCode } from '@kite-ai/runtime-protocol';

/** Only these fixed facts may cross the App Server boundary after a partial removal. */
export class WorkspaceRemovalError extends Error {
  readonly detailCode: RuntimeProtocolWorkspaceRemovalDetailCode;
  readonly deletedSessions: number;

  constructor(
    detailCode: RuntimeProtocolWorkspaceRemovalDetailCode,
    deletedSessions: number,
    options?: ErrorOptions,
  ) {
    super('Workspace removal failed.', options);
    this.name = 'WorkspaceRemovalError';
    this.detailCode = detailCode;
    this.deletedSessions = deletedSessions;
  }
}
