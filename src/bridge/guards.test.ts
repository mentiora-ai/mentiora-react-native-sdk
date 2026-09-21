import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNotification, isRequest, isResponse, parseInbound } from './guards.js';

test('parseInbound rejects non-JSON and non-2.0 envelopes', () => {
  assert.equal(parseInbound('not json'), null);
  assert.equal(parseInbound('{"jsonrpc":"1.0","method":"x","params":{}}'), null);
  assert.equal(parseInbound('[]'), null);
});

test('a request needs a non-empty string id, a method and params', () => {
  const ok = parseInbound('{"jsonrpc":"2.0","id":"r1","method":"mentiora/openUrl","params":{}}');
  assert.ok(ok && isRequest(ok));
  // numeric ids are forbidden by the contract
  assert.equal(parseInbound('{"jsonrpc":"2.0","id":1,"method":"m","params":{}}'), null);
  assert.equal(parseInbound('{"jsonrpc":"2.0","id":"","method":"m","params":{}}'), null);
});

test('a notification has a method and no id', () => {
  const n = parseInbound('{"jsonrpc":"2.0","method":"mentiora/ready","params":{}}');
  assert.ok(n && isNotification(n));
});

test('a response has an id and result or error, never a method', () => {
  const r = parseInbound('{"jsonrpc":"2.0","id":"h2","error":{"code":-32601,"message":"x"}}');
  assert.ok(r && isResponse(r));
});

test('missing params on a request reads as {} rather than dropping the message', () => {
  const r = parseInbound('{"jsonrpc":"2.0","id":"r1","method":"m"}');
  assert.ok(r && isRequest(r));
  assert.deepEqual(r.params, {});
});
