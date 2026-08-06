import type { RuntimeEvent } from '@/core/runtime/events';
import { projectTerminalOutcomeV1 } from '@/core/runtime/terminal-outcome';

/**
 * Public CLI runtime-event projection is deliberately isolated from CLI
 * bootstrap/configuration so deterministic diagnostic callers exercise the
 * actual projection without importing project config or release composition.
 */
/** @qualification-surface-v1 {"sourceSurfaceId":"cli:runtime-event-projection","featureId":"CLI-RUNTIME_EVENT_PROJECTION-001","domain":"cli","observableContract":"cli_runtime_event_projection","risk":"p1","riskRationale":"cli_entrypoint","owner":"app-cli","entrypoints":["cli"],"sourceKind":"public_surface","symbol":"projectCliRuntimeEventV1","l1ProjectionBindings":[{"adapterId":"cli-invalid-arguments-projection-v1","assertionId":"l1.projection.cli.invalid-arguments.v1"},{"adapterId":"cli-tool-approval-projection-v1","assertionId":"l1.projection.cli.tool-approval.v1"}]} */
export function projectCliRuntimeEventV1(
  event: RuntimeEvent,
  terminalOutcomeEnabled = true,
):
  | RuntimeEvent
  | (RuntimeEvent & {
      terminalPresentation: ReturnType<typeof projectTerminalOutcomeV1>;
    }) {
  if (
    terminalOutcomeEnabled &&
    (event.type === 'run.completed' || event.type === 'run.error') &&
    event.outcome
  ) {
    return {
      ...event,
      terminalPresentation: projectTerminalOutcomeV1(event.outcome),
    };
  }
  return event;
}
