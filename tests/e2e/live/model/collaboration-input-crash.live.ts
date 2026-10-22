/** Historical C04 input-classifier probes. The production classifier was removed. */
export const C04_DECISION_CASE =
  'C04-real-SIGKILL-committed-input-decision-before-queued-business' as const;
export const C04_MODEL_CASE = 'C04-real-SIGKILL-successful-input-Model-before-decision' as const;
export async function runC04ModelCrash(
  _output: string,
  _window: 'model' | 'decision' = 'model',
): Promise<never> {
  throw Error(
    'input_processing_removed: C04 classifier recovery is retired; use ordinary Run recovery tests',
  );
}
if (import.meta.main) throw Error('input_processing_removed: C04 classifier recovery is retired');
