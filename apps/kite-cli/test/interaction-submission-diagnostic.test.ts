import { describe, expect, test } from 'bun:test';
import { RuntimeClientError } from '@kite-ai/runtime-client';
import { classifyInteractionSubmissionFailure } from '../src/tui/interaction-submission-diagnostic';

describe('interaction submission diagnostics', () => {
  test('classifies safe recovery categories without exposing raw errors', () => {
    expect(
      classifyInteractionSubmissionFailure(
        new RuntimeClientError('connection_closed', 'private transport detail'),
      ),
    ).toBe('connection');
    expect(
      classifyInteractionSubmissionFailure(
        new Error('The Runtime interaction is no longer pending.'),
      ),
    ).toBe('expired');
    expect(
      classifyInteractionSubmissionFailure(
        new Error('The latest Runtime interaction projection is stale.'),
      ),
    ).toBe('state_changed');
    expect(classifyInteractionSubmissionFailure(new Error('private detail'))).toBe('unknown');
  });
});
