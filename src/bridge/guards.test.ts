import assert from 'node:assert/strict';
import { isUnreadCountParams, parseInbound } from './guards.js';

test('parseInbound rejects non-JSON and non-2.0 envelopes', () => {
  assert.equal(parseInbound('not json'), null);
  assert.equal(parseInbound('{"jsonrpc":"1.0","method":"x","params":{}}'), null);
  assert.equal(parseInbound('[]'), null);
});

test('a request needs a non-empty string id, a method and params', () => {
  assert.deepEqual(
    parseInbound('{"jsonrpc":"2.0","id":"r1","method":"mentiora/openUrl","params":{}}'),
    { jsonrpc: '2.0', id: 'r1', method: 'mentiora/openUrl', params: {} },
  );
  assert.equal(parseInbound('{"jsonrpc":"2.0","id":1,"method":"m","params":{}}'), null);
  assert.equal(parseInbound('{"jsonrpc":"2.0","id":"","method":"m","params":{}}'), null);
});

test('a notification has a method and no id', () => {
  assert.deepEqual(parseInbound('{"jsonrpc":"2.0","method":"mentiora/ready","params":{}}'), {
    jsonrpc: '2.0',
    method: 'mentiora/ready',
    params: {},
  });
});

test('a response has an id and result or error, never a method', () => {
  assert.deepEqual(
    parseInbound('{"jsonrpc":"2.0","id":"h2","error":{"code":-32601,"message":"x"}}'),
    { jsonrpc: '2.0', id: 'h2', error: { code: -32601, message: 'x' }, params: {} },
  );
  assert.equal(parseInbound('{"jsonrpc":"2.0","id":"h2","method":"m","result":{}}'), null);
  assert.equal(parseInbound('{"jsonrpc":"2.0","id":"h2","result":{},"error":{}}'), null);
});

test('missing params on a request reads as {} rather than dropping the message', () => {
  assert.deepEqual(parseInbound('{"jsonrpc":"2.0","id":"r1","method":"m"}'), {
    jsonrpc: '2.0',
    id: 'r1',
    method: 'm',
    params: {},
  });
  assert.equal(parseInbound('{"jsonrpc":"2.0","id":"r1","method":"m","params":[]}'), null);
});

test("a response's params.sessionKey survives parseInbound", () => {
  const r = parseInbound(
    '{"jsonrpc":"2.0","id":"h2","result":{},"params":{"sessionKey":"sk-9f2a1b7e3d4c"}}',
  );
  assert.deepEqual(r?.params, { sessionKey: 'sk-9f2a1b7e3d4c' });
});

test('missing params on a response reads as {} rather than dropping the message', () => {
  assert.deepEqual(parseInbound('{"jsonrpc":"2.0","id":"h2","result":{}}'), {
    jsonrpc: '2.0',
    id: 'h2',
    result: {},
    params: {},
  });
});

test('an error response rejects a non-integer code', () => {
  assert.equal(
    parseInbound('{"jsonrpc":"2.0","id":"h2","error":{"code":-32601.5,"message":"x"}}'),
    null,
  );
});

test('unreadCountChanged takes an integer count from 0 to 100, the protocol cap', () => {
  assert.ok(isUnreadCountParams({ count: 0 }));
  assert.ok(isUnreadCountParams({ count: 100 }));
  for (const count of [-1, 101, 1.5, '2', null, undefined, Number.NaN]) {
    assert.ok(!isUnreadCountParams({ count }), `count=${String(count)}`);
  }
  assert.ok(!isUnreadCountParams({}));
});
