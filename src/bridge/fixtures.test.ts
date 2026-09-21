import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HostHandlers } from './peer.js';
import { createHostPeer } from './peer.js';

// Read with fs, NOT `import ... with { type: 'json' }` (TS2823 under `module: node16`)
// and NOT `new URL(..., import.meta.url)` (TS1470, plus a runtime SyntaxError under the
// CommonJS test emit). The fixtures are not copied into lib-test/, so resolve from root.
const FIXTURES = join(process.cwd(), 'src/bridge/v1/fixtures');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

const KEY = 'sk-9f2a1b7e3d4c'; // the deterministic key every fixture uses

const initializeMessage = () => ({
  jsonrpc: '2.0',
  id: 'boot',
  method: 'mentiora/initialize',
  params: { protocolVersion: 1 },
});

const stubHandlers = (sessionKey: string): HostHandlers => ({
  initialize: async () => ({
    protocolVersion: 1,
    sessionKey,
    installId: '0123456789abcdef0123456789abcdef',
    sdk: { name: '@mentiora/react-native-sdk', version: '0.0.1' },
  }),
  refreshIdentity: async () => ({ identityToken: 'eyJhbGciOiJIUzI1NiJ9.x.y' }),
  openUrl: async () => {},
  onReady: () => {},
  onClose: () => {},
  onIdentityError: () => {},
  onBackHandling: () => {},
});

// The two role:"host" fixtures are assertions. The four role:"page" ones are
// replayed as INPUTS — their page->host steps must route without error.
test('host fixture: an unauthorized message gets the complete -32001 envelope', async () => {
  const fx = fixture('unauthorized-missing-session-key');
  assert.equal(fx.role, 'host');
  const sent: string[] = [];
  const peer = createHostPeer({ send: (r) => sent.push(r), handlers: stubHandlers(KEY) });
  await peer.receive(JSON.stringify(initializeMessage()));
  await peer.receive(JSON.stringify(fx.steps[0].message));
  // Compare the WHOLE envelope. Comparing only id and error.code would pass a peer
  // that never stamps params.sessionKey on an error response, which both host
  // fixtures require.
  assert.deepEqual(JSON.parse(sent[sent.length - 1] as string), fx.steps[1].message);
});

test('host fixture: a second initialize on one load gets the complete -32600 envelope', async () => {
  const fx = fixture('second-initialize');
  assert.equal(fx.role, 'host');
  const sent: string[] = [];
  const peer = createHostPeer({ send: (r) => sent.push(r), handlers: stubHandlers(KEY) });
  await peer.receive(JSON.stringify(fx.steps[0].message));
  await peer.receive(JSON.stringify(fx.steps[0].message));
  assert.deepEqual(JSON.parse(sent[sent.length - 1] as string), fx.steps[1].message);
});

for (const name of ['handshake', 'identity-refresh', 'back-handling', 'unknown-method']) {
  test(`page fixture ${name}: every page->host step routes without error`, async () => {
    const fx = fixture(name);
    assert.equal(fx.role, 'page');
    const sent: string[] = [];
    const peer = createHostPeer({ send: (r) => sent.push(r), handlers: stubHandlers(KEY) });

    // Seed a session unless the fixture opens with its own initialize. Three of
    // these four fixtures start mid-session: their first page->host step already
    // carries params.sessionKey, so a peer with no key assigned would correctly
    // answer -32001 and this loop would fail on the host's own behaviour.
    const firstFromPage = fx.steps.find(
      (st: { direction: string }) => st.direction === 'page->host',
    );
    if (firstFromPage?.message.method !== 'mentiora/initialize') {
      await peer.receive(JSON.stringify(initializeMessage()));
      assert.equal(peer.sessionKey(), KEY, "seed must assign the fixtures' key");
      sent.length = 0; // drop the seed's result so it cannot mask an assertion
    }

    for (const step of fx.steps) {
      if (step.direction !== 'page->host') continue;
      // Slice per step, never `sent[sent.length - 1]`. Two of these four fixtures send
      // the host nothing it must answer — back-handling's steps are notifications and
      // unknown-method's only page->host step is a response to a request this loop never
      // issued — so a last-message check reads `undefined` and asserts nothing at all.
      const before = sent.length;
      await peer.receive(JSON.stringify(step.message));
      const produced = sent.slice(before).map((r) => JSON.parse(r) as { error?: unknown });
      for (const msg of produced) {
        assert.equal(msg.error, undefined, `${name} produced an error: ${JSON.stringify(msg)}`);
      }
      // A request is answered exactly once. A notification and an unmatched response are
      // answered never — silence is the assertion for those two.
      const m = step.message as { method?: string; id?: unknown };
      const expectsReply = m.method !== undefined && m.id !== undefined;
      assert.equal(produced.length, expectsReply ? 1 : 0, `${name}: wrong reply count`);
    }
  });
}
