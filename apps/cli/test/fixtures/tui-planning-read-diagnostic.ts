import { appendFileSync } from 'node:fs';

/** Observes only the response already returned to the owned Planning Host. */
export async function recordPlanningHostRead(path: string, response: Response, output: string) {
  if (!/^\/v1\/sessions\/[^/]+\/(view|messages)$/.test(path)) return;
  try {
    const value = await response.clone().json();
    const summary = (item: Record<string, unknown>) => ({
      id: item.id,
      sessionId: item.sessionId,
      runId: item.runId,
      role: item.role,
      kind: item.kind,
      status: item.status,
      sourceIds: item.sourceIds,
      ...(typeof item.content === 'string'
        ? {
            contentBytes: new TextEncoder().encode(item.content).byteLength,
            hasCompletion: item.content.includes('ORIGINAL_PLAN_ACTUALLY_COMPLETED'),
          }
        : {}),
      outputBody: item.outputBody,
    });
    const body = Array.isArray(value)
      ? { messages: value.slice(-64).map(summary) }
      : {
          storeId: value.storeId,
          sessionId: value.session?.id,
          runs: value.runs?.slice(-8).map(summary),
          executions: value.executions?.slice(-16).map(summary),
          messages: value.messages?.slice(-64).map(summary),
        };
    appendFileSync(output, JSON.stringify({ path, status: response.status, body }) + '\n');
  } catch (error) {
    appendFileSync(output, JSON.stringify({ path, readDiagnosticError: String(error) }) + '\n');
  }
}
