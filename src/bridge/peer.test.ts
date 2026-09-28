import assert from 'node:assert/strict';
import { BridgeError, createHostPeer } from './peer.js';

const result = {
  protocolVersion: 1,
  sessionKey: 'sk-test',
  installId: 'iid',
  sdk: { name: '@mentiora-ai/react-native-sdk', version: '0.0.1' },
  visible: true,
};
const makePeer = () => {
  const sent: string[] = [];
  const warnings: string[] = [];
  const counts: number[] = [];
  const peer = createHostPeer({
    send: (raw) => sent.push(raw),
    warn: (m) => warnings.push(m),
    handlers: {
      initialize: async () => result,
      refreshIdentity: async () => ({ identityToken: 'jwt' }),
      openUrl: async () => {},
      onReady: () => {},
      onClose: () => {},
      onIdentityError: () => {},
      onBackHandling: () => {},
      onUnreadCountChanged: (count) => counts.push(count),
    },
  });
  return { peer, sent, warnings, counts };
};
const lastSent = (sent: string[]) => JSON.parse(sent[sent.length - 1] as string);

test('initialize is accepted once without a session key and assigns one', async () => {
  const { peer, sent } = makePeer();
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  assert.equal(lastSent(sent).result.sessionKey, 'sk-test');
  assert.equal(peer.sessionKey(), 'sk-test');
});

test('a second initialize on the same load is refused with -32600', async () => {
  const { peer, sent } = makePeer();
  const msg =
    '{"jsonrpc":"2.0","id":"r4","method":"mentiora/initialize","params":{"protocolVersion":1}}';
  await peer.receive(msg);
  await peer.receive(msg);
  assert.equal(lastSent(sent).error.code, -32600);
});

test('the second-initialize error carries the pinned message and no data', async () => {
  const { peer, sent } = makePeer();
  const msg =
    '{"jsonrpc":"2.0","id":"r4","method":"mentiora/initialize","params":{"protocolVersion":1}}';
  await peer.receive(msg);
  await peer.receive(msg);
  const out = lastSent(sent);
  assert.deepEqual(out.error, {
    code: -32600,
    message: 'initialize already completed for this page load',
  });
  assert.equal(out.params.sessionKey, 'sk-test');
});

test('resetLoad clears the latch so the next load may initialize again', async () => {
  const { peer, sent } = makePeer();
  const msg =
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}';
  await peer.receive(msg);
  peer.resetLoad();
  await peer.receive(msg);
  assert.ok(lastSent(sent).result, 'expected a result, not an error');
});

test('a request with a wrong session key is refused with -32001', async () => {
  const { peer, sent } = makePeer();
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r3","method":"mentiora/openUrl","params":{"url":"https://e.com"}}',
  );
  const out = lastSent(sent);
  assert.equal(out.error.code, -32001);
  assert.equal(out.id, 'r3');
});

test('the -32001 error carries the pinned message, data and stamped session key', async () => {
  const { peer, sent } = makePeer();
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r3","method":"mentiora/openUrl","params":{"url":"https://e.com"}}',
  );
  const out = lastSent(sent);
  assert.deepEqual(out.error, {
    code: -32001,
    message: 'Unauthorized',
    data: { reason: 'missing_session_key' },
  });
  assert.equal(out.params.sessionKey, 'sk-test');
});

test('an id-less message with a bad session key is dropped, not answered', async () => {
  const { peer, sent, warnings } = makePeer();
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  const before = sent.length;
  await peer.receive('{"jsonrpc":"2.0","method":"mentiora/ready","params":{}}');
  assert.equal(sent.length, before, 'nothing may be sent for an id-less rejection');
  assert.equal(warnings.length, 1);
});

test('an unsupported protocolVersion still gets our own version, never -32005', async () => {
  const { peer, sent } = makePeer();
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":99}}',
  );
  const out = lastSent(sent);
  assert.equal(out.error, undefined);
  assert.equal(out.result.protocolVersion, 1);
});

test('an unknown method gets -32601 and a bad params shape gets -32602', async () => {
  const { peer, sent } = makePeer();
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  await peer.receive(
    '{"jsonrpc":"2.0","id":"x","method":"mentiora/nope","params":{"sessionKey":"sk-test"}}',
  );
  assert.equal(lastSent(sent).error.code, -32601);
  await peer.receive(
    '{"jsonrpc":"2.0","id":"y","method":"mentiora/openUrl","params":{"sessionKey":"sk-test"}}',
  );
  assert.equal(lastSent(sent).error.code, -32602);
});

test('the -32601 error carries the pinned message', async () => {
  const { peer, sent } = makePeer();
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  await peer.receive(
    '{"jsonrpc":"2.0","id":"x","method":"mentiora/nope","params":{"sessionKey":"sk-test"}}',
  );
  assert.deepEqual(lastSent(sent).error, { code: -32601, message: 'Method not found' });
});

test('a handler that throws produces -32603', async () => {
  const sent: string[] = [];
  const peer = createHostPeer({
    send: (r) => sent.push(r),
    handlers: {
      initialize: async () => result,
      refreshIdentity: async () => {
        throw new Error('boom');
      },
      openUrl: async () => {},
      onReady: () => {},
      onClose: () => {},
      onIdentityError: () => {},
      onBackHandling: () => {},
      onUnreadCountChanged: () => {},
    },
  });
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r2","method":"mentiora/refreshIdentity","params":{"sessionKey":"sk-test"}}',
  );
  assert.equal(lastSent(sent).error.code, -32603);
});

test('every outbound message carries the session key, error responses included', async () => {
  const { peer, sent } = makePeer();
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  await peer.receive(
    '{"jsonrpc":"2.0","id":"x","method":"mentiora/nope","params":{"sessionKey":"sk-test"}}',
  );
  assert.equal(lastSent(sent).params.sessionKey, 'sk-test');
  peer.sendBack();
  assert.equal(lastSent(sent).params.sessionKey, 'sk-test');
});

test('initialize with bad params gets -32602 and does NOT spend the latch', async () => {
  const { peer, sent } = makePeer();
  await peer.receive('{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{}}');
  assert.equal(lastSent(sent).error.code, -32602);
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r2","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  assert.ok(lastSent(sent).result, 'the latch must still have been available');
});

test('an id-less initialize notification never spends the latch', async () => {
  const { peer, sent } = makePeer();
  await peer.receive(
    '{"jsonrpc":"2.0","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  assert.ok(lastSent(sent).result);
});

test('two initializes racing before either handler resolves: the second gets -32600', async () => {
  const sent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const peer = createHostPeer({
    send: (r) => sent.push(r),
    handlers: {
      initialize: async () => {
        await gate;
        return result;
      },
      refreshIdentity: async () => ({ identityToken: 'j' }),
      openUrl: async () => {},
      onReady: () => {},
      onClose: () => {},
      onIdentityError: () => {},
      onBackHandling: () => {},
      onUnreadCountChanged: () => {},
    },
  });
  const msg =
    '{"jsonrpc":"2.0","id":"a","method":"mentiora/initialize","params":{"protocolVersion":1}}';
  const first = peer.receive(msg);
  const second = peer.receive(msg.replace('"a"', '"b"'));
  release();
  await Promise.all([first, second]);
  const codes = sent.map((r) => JSON.parse(r).error?.code).filter(Boolean);
  assert.deepEqual(codes, [-32600], 'exactly one must be refused');
});

test('work from a superseded load generation neither sends nor mutates', async () => {
  const sent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const peer = createHostPeer({
    send: (r) => sent.push(r),
    handlers: {
      initialize: async () => {
        await gate;
        return result;
      },
      refreshIdentity: async () => ({ identityToken: 'j' }),
      openUrl: async () => {},
      onReady: () => {},
      onClose: () => {},
      onIdentityError: () => {},
      onBackHandling: () => {},
      onUnreadCountChanged: () => {},
    },
  });
  const inFlight = peer.receive(
    '{"jsonrpc":"2.0","id":"a","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  peer.resetLoad(); // the page reloaded while we awaited bytes
  release();
  await inFlight;
  assert.equal(sent.length, 0, 'the old load must not answer into the new page');
  assert.equal(peer.sessionKey(), null, 'nor overwrite the new session');
});

const peerThatThrows = (e: unknown) => {
  const sent: string[] = [];
  const peer = createHostPeer({
    send: (raw) => sent.push(raw),
    handlers: {
      initialize: async () => result,
      refreshIdentity: async () => {
        throw e;
      },
      openUrl: async () => {
        throw e;
      },
      onReady: () => {},
      onClose: () => {},
      onIdentityError: () => {},
      onBackHandling: () => {},
      onUnreadCountChanged: () => {},
    },
  });
  return { peer, sent };
};

const initialized = async (peer: ReturnType<typeof peerThatThrows>['peer']) => {
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
};

test('a BridgeError from openUrl answers with its own code, not -32603', async () => {
  const { peer, sent } = peerThatThrows(new BridgeError(-32003, 'URL denied'));
  await initialized(peer);
  await peer.receive(
    '{"jsonrpc":"2.0","id":"u1","method":"mentiora/openUrl","params":{"sessionKey":"sk-test","url":"javascript:alert(1)"}}',
  );
  assert.deepEqual(lastSent(sent).error, { code: -32003, message: 'URL denied' });
});

test('a BridgeError from refreshIdentity answers with its own code', async () => {
  const { peer, sent } = peerThatThrows(new BridgeError(-32002, 'Identity unavailable'));
  await initialized(peer);
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r2","method":"mentiora/refreshIdentity","params":{"sessionKey":"sk-test"}}',
  );
  assert.deepEqual(lastSent(sent).error, { code: -32002, message: 'Identity unavailable' });
});

test('any other throw is still -32603 with the generic message', async () => {
  const { peer, sent } = peerThatThrows(new Error('boom: /Users/someone/secret.ts'));
  await initialized(peer);
  await peer.receive(
    '{"jsonrpc":"2.0","id":"u1","method":"mentiora/openUrl","params":{"sessionKey":"sk-test","url":"https://e.com"}}',
  );
  assert.deepEqual(lastSent(sent).error, { code: -32603, message: 'Internal error' });
});

test('a page-sent response with a wrong session key is rejected with -32001', async () => {
  const { peer, sent } = makePeer();
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  await peer.receive(
    '{"jsonrpc":"2.0","id":"h2","error":{"code":-32601,"message":"Method not found"},"params":{"sessionKey":"sk-forged"}}',
  );
  const out = lastSent(sent);
  assert.equal(out.id, 'h2');
  assert.deepEqual(out.error, {
    code: -32001,
    message: 'Unauthorized',
    data: { reason: 'missing_session_key' },
  });
});

test('a page-sent response with the RIGHT session key is accepted in silence', async () => {
  // The other half: a peer answering -32001 to every response also passes the test above.
  const { peer, sent } = makePeer();
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  const before = sent.length;
  await peer.receive(
    '{"jsonrpc":"2.0","id":"h2","error":{"code":-32601,"message":"Method not found"},"params":{"sessionKey":"sk-test"}}',
  );
  assert.equal(sent.length, before, 'a matching response is routed nowhere and answered nothing');
});

test('sendHide sends nothing before a handshake, then a keyed notification', async () => {
  const { peer, sent } = makePeer();
  peer.sendHide();
  assert.equal(sent.length, 0, 'a keyless page would answer -32001');
  await peer.receive(
    '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}',
  );
  peer.sendHide();
  assert.deepEqual(lastSent(sent), {
    jsonrpc: '2.0',
    method: 'mentiora/hide',
    params: { sessionKey: 'sk-test' },
  });
});

const INIT =
  '{"jsonrpc":"2.0","id":"r1","method":"mentiora/initialize","params":{"protocolVersion":1}}';

test('unreadCountChanged reaches its handler; a malformed count is dropped', async () => {
  const { peer, counts, warnings } = makePeer();
  await peer.receive(INIT);
  await peer.receive(
    '{"jsonrpc":"2.0","method":"mentiora/unreadCountChanged","params":{"sessionKey":"sk-test","count":3}}',
  );
  await peer.receive(
    '{"jsonrpc":"2.0","method":"mentiora/unreadCountChanged","params":{"sessionKey":"sk-test","count":-1}}',
  );
  assert.deepEqual(counts, [3]);
  assert.equal(warnings.length, 1);
});

test('sendOpen sends nothing before a handshake, then a keyed notification', async () => {
  const { peer, sent } = makePeer();
  peer.sendOpen('thr_abc');
  assert.equal(sent.length, 0);
  await peer.receive(INIT);
  peer.sendOpen('thr_abc');
  assert.deepEqual(lastSent(sent), {
    jsonrpc: '2.0',
    method: 'mentiora/open',
    params: { sessionKey: 'sk-test', threadId: 'thr_abc' },
  });
});

test('an initialize handler BridgeError answers with its own code, so the page can tell sign-in from a version mismatch', async () => {
  const sent: string[] = [];
  const peer = createHostPeer({
    send: (raw) => sent.push(raw),
    handlers: {
      initialize: async () => {
        throw new BridgeError(-32002, 'Identity unavailable');
      },
      refreshIdentity: async () => ({ identityToken: 'jwt' }),
      openUrl: async () => {},
      onReady: () => {},
      onClose: () => {},
      onIdentityError: () => {},
      onBackHandling: () => {},
      onUnreadCountChanged: () => {},
    },
  });
  await peer.receive(INIT);
  assert.deepEqual(lastSent(sent).error, { code: -32002, message: 'Identity unavailable' });
  assert.equal(peer.sessionKey(), null);
});
