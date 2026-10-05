import type { ProcessServiceCleanupError } from './process-service';

/** A failed assembly has no HTTP handle. Retain its original owners and process for diagnosis. */
export function retainFailedProcess(error: ProcessServiceCleanupError): Promise<never> {
  process.stderr.write(`${JSON.stringify({ code: error.code, phase: error.phase })}\n`);
  return new Promise<never>(() => {
    // An unresolved Promise does not keep a process alive. This ref'ed timer also holds the owners.
    setInterval(() => {
      void error.cause;
    }, 60_000);
  });
}
