/** Explicit access rejection without provider response details. */
export class ModelAccessError extends Error {
  readonly code: 'model_authentication_failed' | 'model_permission_denied';

  constructor(status: 401 | 403) {
    const code = status === 401 ? 'model_authentication_failed' : 'model_permission_denied';
    super(code);
    this.name = 'ModelAccessError';
    this.code = code;
  }
}
