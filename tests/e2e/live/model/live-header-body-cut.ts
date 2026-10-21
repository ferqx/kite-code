export interface HeaderCutEvidence {
  fired: boolean;
  status: number | null;
  headersAt: number | null;
  cancelledAt: number | null;
  sdkFirstPullAt: number | null;
  upstreamCancelConfirmed: boolean;
  sdkDeliveredBytes: number;
  sdkEOF: boolean;
  injectedCode: 'ECONNRESET' | null;
  cancelFailure: string | null;
  cleanupCloseConfirmed: boolean | null;
}
/** Explicit transport-fault control, never a natural Provider-error observation.
 * Preserve real HTTP headers. Cancel the actual original response before any SDK
 * body read, then fail the SDK's first pull. No synthetic Model/finish/usage/SSE.
 */
export function createHeaderBodyCut(now = () => performance.now(), remainingMs = () => 5000) {
  const evidence: HeaderCutEvidence = {
    fired: false,
    status: null,
    headersAt: null,
    cancelledAt: null,
    sdkFirstPullAt: null,
    upstreamCancelConfirmed: false,
    sdkDeliveredBytes: 0,
    sdkEOF: false,
    injectedCode: null,
    cancelFailure: null,
    cleanupCloseConfirmed: null,
  };
  let retainedBody: ReadableStream<Uint8Array> | undefined;
  let originalCancel: Promise<void> | undefined;
  async function waitForOriginalCancel() {
    if (!originalCancel) throw Error('C07_original_cancel_not_started');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        originalCancel,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error('C07_original_cancel_confirmation_timeout')),
            Math.max(0, Math.min(5000, remainingMs())),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    evidence,
    async closeRetained() {
      if (!retainedBody) return true;
      try {
        // A second cancel() on a closed stream resolves without confirming the
        // first underlying cancel. Only that original promise is authoritative.
        await waitForOriginalCancel();
        evidence.cleanupCloseConfirmed = true;
        retainedBody = undefined;
        return true;
      } catch {
        evidence.cleanupCloseConfirmed = false;
        return false;
      }
    },
    async apply(response: Response): Promise<Response> {
      if (
        evidence.fired ||
        response.status !== 200 ||
        !response.body ||
        !response.headers.get('content-type')?.includes('text/event-stream')
      )
        return response;
      if (response.bodyUsed || response.body.locked)
        throw Error('header_cut_original_body_already_consumed');
      evidence.fired = true;
      evidence.status = response.status;
      evidence.headersAt = now();
      retainedBody = response.body;
      try {
        originalCancel = Promise.resolve().then(() =>
          response.body!.cancel('explicit C07 after real headers before SDK body'),
        );
        await waitForOriginalCancel();
      } catch (error) {
        evidence.cancelFailure = error instanceof Error ? error.name : 'unknown';
        // Unconfirmed cleanup must not look like a known safe connection-reset retry.
        throw Error('C07_original_response_close_unconfirmed');
      }
      retainedBody = undefined;
      evidence.upstreamCancelConfirmed = true;
      evidence.cancelledAt = now();
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            evidence.sdkFirstPullAt = now();
            evidence.injectedCode = 'ECONNRESET';
            controller.error(
              Object.assign(new TypeError('explicit_C07_injected_body_connection_reset'), {
                code: 'ECONNRESET',
              }),
            );
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}
