import test from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserDeadline, finishedResponse } from './browser-deadline.mjs';

// Real Node-clock tests independent of Chromium, page clocks and remote services.
test('unsettled browser operation fails with a bounded stage-specific deadline', async () => {
  await assert.rejects(withBrowserDeadline(new Promise(() => {}), 'mobile: replay expiry', 10),
    { message: 'Browser acceptance deadline: mobile: replay expiry' });
});

test('completion and operation rejection are preserved, not converted into success', async () => {
  const value = { finished: true };
  assert.equal(await withBrowserDeadline(Promise.resolve(value), 'complete', 10), value);
  const error = new Error('fixture failure');
  await assert.rejects(withBrowserDeadline(Promise.reject(error), 'reject', 10), e => e === error);
});

test('late rejection after a deadline is observed without unhandled rejection', async () => {
  let reject;
  const operation = new Promise((_, r) => { reject = r; });
  await assert.rejects(withBrowserDeadline(operation, 'late', 10), /Browser acceptance deadline: late/);
  reject(new Error('late fixture rejection'));
  // The node:test runner fails the test on an unhandled rejection.
  await new Promise(resolve => setImmediate(resolve));
});

test('late success cannot turn a timed-out acceptance into a pass', async () => {
  let resolve;
  const operation = new Promise(r => { resolve = r; });
  const result = withBrowserDeadline(operation, 'late success', 10);
  await assert.rejects(result, /Browser acceptance deadline: late success/);
  resolve('too late');
  await assert.rejects(result, /Browser acceptance deadline: late success/);
});

test('finished response cannot hang forever waiting for request completion', async () => {
  await assert.rejects(finishedResponse({ finished: () => new Promise(() => {}) }, 'mobile: replay expiry', 10),
    { message: 'Browser acceptance deadline: mobile: replay expiry' });
});

test('finished response accepts only a completed successful request', async () => {
  await finishedResponse({ finished: async () => null }, 'complete');
  await assert.rejects(finishedResponse({ finished: async () => new Error('private diagnostic') }, 'narrow: expiry'),
    { message: 'Browser acceptance response failed: narrow: expiry' });
});
