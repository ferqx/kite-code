import { z } from 'zod';
import { WEB_FETCH_CONTRACT } from '@/core/tools/tool-contracts';
import { fetchAndExtract } from '@/core/web/extractor';
import type { WebFetchResult } from '@/core/web/types';
import { projectionDigest, truncateProjectedOutput } from '../projection';
import type { ToolSpec } from '../spec';

export const webFetchInputSchema = z.object({
  url: z.string().min(1).max(8192).describe('Public http/https URL to fetch (max 8192 chars)'),
  max_chars: z
    .number()
    .int()
    .min(1000)
    .max(16000)
    .optional()
    .describe('Max characters of extracted content (default 8000)'),
  timeout_ms: z
    .number()
    .int()
    .min(3000)
    .max(30000)
    .optional()
    .describe(
      'Timeout in milliseconds (default 15000). Increase for large pages like Wikipedia or GitHub.',
    ),
});

type WebFetchInput = z.infer<typeof webFetchInputSchema>;
type WebFetchOutput = WebFetchResult & { aborted?: boolean; timedOut?: boolean };

export const webFetchSpec: ToolSpec<WebFetchInput, WebFetchOutput> = {
  name: 'web_fetch',
  kind: 'computer',
  contract: WEB_FETCH_CONTRACT.sections,
  inputSchema: webFetchInputSchema,
  declaredEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'Fetches public web content without external mutation.',
  }),
  approvalSummary: (input) => `web_fetch ${input.url}`,
  execute: async (input, context) => {
    try {
      return await fetchAndExtract(input.url, {
        signal: context.signal,
        maxChars: input.max_chars,
        timeoutMs: input.timeout_ms,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      const timedOut = aborted && error.message === 'Fetch timeout';
      return {
        ok: false,
        url: input.url,
        truncated: false,
        error: timedOut
          ? 'Fetch timed out.'
          : aborted
            ? 'Web fetch cancelled by user.'
            : error instanceof Error
              ? error.message
              : String(error),
        aborted,
        timedOut,
      };
    }
  },
  projectResult: (output, context) => {
    // invocationInput 由 Registry dispatch 注入且类型化（i1），无需强转。
    const input = context.invocationInput;
    const rawContent = output.ok
      ? [
          `Fetched: ${output.title ?? output.finalUrl ?? input.url}`,
          output.contentType ? `Type: ${output.contentType}` : '',
          output.truncated ? '(content truncated)' : '',
          '',
          output.content ?? '',
        ]
          .filter(Boolean)
          .join('\n')
      : `Failed to fetch ${input.url}: ${output.error ?? 'unknown error'}`;
    const modelContent = truncateProjectedOutput(
      rawContent,
      Math.max(8000, (input.max_chars ?? 8000) + 500),
    );
    return {
      ok: output.ok,
      modelContent,
      resultMeta: {
        ...(output.ok && !output.truncated
          ? { rawResultDigest: projectionDigest(rawContent, '', 0) }
          : {}),
        truncated: modelContent !== rawContent || (output.ok && output.truncated),
      },
      display: { verb: 'Fetch' },
    };
  },
};
