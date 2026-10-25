export const parsingLimit = 5_000_000;
export class WebFetchError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'WebFetchError';
  }
}
