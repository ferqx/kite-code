import {
  type ReleaseStatusRequest,
  type ReleaseStatusSnapshot,
  releaseStatusRequestCodec,
  releaseStatusResponseCodec,
} from '@kite-ai/kite-app-contract';
import type { ReleaseStatusHandlerPort } from './ports';

export interface ReleaseStatusHandlerDependencies {
  readonly handler: ReleaseStatusHandlerPort;
}

export function createReleaseStatusHandler(
  input: ReleaseStatusHandlerDependencies,
): ReleaseStatusHandlerPort {
  return Object.freeze({
    async snapshot(request: ReleaseStatusRequest): Promise<ReleaseStatusSnapshot> {
      const checked = releaseStatusRequestCodec.decode(releaseStatusRequestCodec.encode(request));
      const response = await input.handler.snapshot(checked);
      return releaseStatusResponseCodec.decode(releaseStatusResponseCodec.encode(response));
    },
  });
}
