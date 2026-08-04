import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CONSECUTIVE_TEMPORARY_FAILURES,
  shouldPauseAfterTemporaryFailure,
} from '../src/integrations/liaProjectTaskPolling.ts';

test('brief consecutive polling failures remain silent', () => {
  for (let failures = 1; failures < MAX_CONSECUTIVE_TEMPORARY_FAILURES; failures += 1) {
    assert.equal(shouldPauseAfterTemporaryFailure(failures), false);
  }
});

test('polling pauses only when the consecutive failure threshold is reached', () => {
  assert.equal(shouldPauseAfterTemporaryFailure(MAX_CONSECUTIVE_TEMPORARY_FAILURES), true);
});
