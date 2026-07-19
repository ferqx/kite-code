import type { ClassifiedFailure } from '@/core/runtime/failures';

export interface CapabilityResult {
  status: 'success' | 'partial' | 'error' | 'cancelled' | 'unknown';
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  error?: ClassifiedFailure;
  providerMeta?: Record<string, unknown>;
}
