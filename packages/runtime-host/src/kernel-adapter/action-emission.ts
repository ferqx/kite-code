import type { KernelEvent as RuntimeEvent } from '@kite-ai/agent-kernel';

/**
 * Stable boundary between a Runtime domain command and its model-facing
 * ToolSpec adapter. Rejections never carry domain events; accepted commands
 * preserve event order for atomic submission by the controller.
 */
export type RuntimeActionEmission =
  | {
      ok: true;
      stdout: string;
      stderr: '';
      runtimeEvents: RuntimeEvent[];
    }
  | {
      ok: false;
      stdout: '';
      stderr: string;
      runtimeEvents?: never;
    };

export function acceptRuntimeAction(
  stdout: string,
  runtimeEvents: RuntimeEvent[] = [],
): RuntimeActionEmission {
  return { ok: true, stdout, stderr: '', runtimeEvents };
}

export function rejectRuntimeAction(stderr: string): RuntimeActionEmission {
  return { ok: false, stdout: '', stderr };
}
