import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observedServiceUrls } from '../renderer/src/developmentService.ts';

test('offers only exact loopback URLs observed from the running managed process', () => {
  const output = 'ready at http://127.0.0.1:4173/app\nother http://127.0.0.1:9999/?token=secret\nremote https://example.com/';
  assert.deepEqual(observedServiceUrls(output, true, false), ['http://127.0.0.1:4173/app']);
  assert.deepEqual(observedServiceUrls(output, false, false), []);
  assert.deepEqual(observedServiceUrls(output, true, true), []);
  assert.deepEqual(observedServiceUrls('waiting on port 4173', true, false), []);
});
