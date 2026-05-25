import type { MockResponse } from "../mock-model";

export interface ResponseGroup {
  group: string;
  responses: MockResponse[];
}

export class ResponsePlan {
  private groups: ResponseGroup[];

  constructor(groups: ResponseGroup[]) {
    this.groups = groups;
  }

  /** Flatten all groups into a single ordered array for createTui */
  flatten(): MockResponse[] {
    const out: MockResponse[] = [];
    for (const g of this.groups) {
      out.push(...g.responses);
    }
    return out;
  }

  /** Verify all planned responses were consumed */
  verify(callCount: number): void {
    const total = this.groups.reduce((sum, g) => sum + g.responses.length, 0);
    if (callCount !== total) {
      const consumed: string[] = [];
      let remaining = callCount;
      for (const g of this.groups) {
        if (remaining <= 0) break;
        const fromGroup = Math.min(remaining, g.responses.length);
        consumed.push(`${g.group}: ${fromGroup}/${g.responses.length}`);
        remaining -= fromGroup;
      }
      throw new Error(
        `Response plan mismatch: consumed ${callCount}, planned ${total}.\n` +
          `Consumed: ${consumed.join(", ") || "none"}`,
      );
    }
  }
}

/** Shorthand: single text response */
export function text(content: string, delay = 50): MockResponse {
  return { message: { content } as any, delay };
}

/** Shorthand: model error response */
export function modelError(message: string, delay = 50): MockResponse {
  return { message: { content: "" } as any, error: message, delay };
}

/** Shorthand: tool call response */
let _toolSeq = 0;
export function toolCall(
  name: string,
  args: Record<string, unknown>,
  content = "let me check",
  delay = 30,
): MockResponse {
  const id = `tc-${name}-${++_toolSeq}`;
  return {
    message: {
      content,
      tool_calls: [{ id, name, args }],
    } as any,
    delay,
  };
}
