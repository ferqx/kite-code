import type { JobEvent } from '../extensions';
import { executionOutputBudget, executionOutputCost } from '../storage/output-budget';
import { AgentError } from '../storage/types';

type Output = Extract<JobEvent, { type: 'output' }>;
const headBudget = executionOutputBudget / 2;

/** Publish the stable prefix live. Keep the suffix private until its final order
 * is known, so an already published cursor never loses retained content. */
export async function* retainShellOutput(source: AsyncIterable<JobEvent>): AsyncIterable<JobEvent> {
  let headCost = 0;
  let tailCost = 0;
  let buffering = false;
  let ended = false;
  const tail = new Map<Output, { cost: number; bytes: number }>();
  const dropped = new Map<Output['stream'], bigint>();
  const omit = (stream: Output['stream'], bytes: bigint) => {
    dropped.set(stream, (dropped.get(stream) ?? 0n) + bytes);
  };
  const flush = function* (): Iterable<JobEvent> {
    for (const [stream, bytes] of dropped)
      yield { type: 'output_dropped', stream, bytes: String(bytes) };
    yield* tail.keys();
  };
  try {
    for await (const event of source) {
      if (ended) throw new AgentError('job_event_after_terminal');
      if (event.type === 'output') {
        const bytes = Buffer.byteLength(event.content);
        if (!bytes || bytes > 32768) throw new AgentError('invalid_execution_output');
        const cost = executionOutputCost(event.content);
        if (!buffering && headCost + cost <= headBudget) {
          headCost += cost;
          yield event;
          continue;
        }
        buffering = true;
        const chunk = { ...event };
        tail.set(chunk, { cost, bytes });
        tailCost += cost;
        while (headCost + tailCost > executionOutputBudget) {
          const [first, evicted] = tail.entries().next().value!;
          tail.delete(first);
          tailCost -= evicted.cost;
          omit(first.stream, BigInt(evicted.bytes));
        }
      } else if (event.type === 'output_dropped') {
        // Any existing suffix preceded this producer gap. Keep the suffix from
        // after the latest gap so each published omitted range remains contiguous.
        buffering = true;
        for (const [entry, { bytes }] of tail) omit(entry.stream, BigInt(bytes));
        tail.clear();
        tailCost = 0;
        if (!/^[1-9]\d{0,18}$/.test(event.bytes)) throw new AgentError('invalid_execution_output');
        omit(event.stream, BigInt(event.bytes));
      } else if (event.type === 'terminal') {
        ended = true;
        yield* flush();
        yield event;
      } else yield event;
    }
  } catch (error) {
    if (!ended) yield* flush();
    throw error;
  }
  if (!ended) yield* flush();
}
