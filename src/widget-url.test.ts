import assert from 'node:assert/strict';
import { parseWidgetUrl } from './widget-url.js';

test('splits the install-snippet URL into the origin and the embed key', () => {
  assert.deepEqual(parseWidgetUrl('https://widget.acme.mentiora.ai/h/rn/pk_wgt_a1b2c3d4e5f6'), {
    origin: 'https://widget.acme.mentiora.ai',
    embedKey: 'pk_wgt_a1b2c3d4e5f6',
    url: 'https://widget.acme.mentiora.ai/h/rn/pk_wgt_a1b2c3d4e5f6',
  });
});

test('accepts a local dev server, surrounding whitespace, a trailing slash and an upper-case host', () => {
  assert.deepEqual(parseWidgetUrl(' http://LOCALHOST:8081/h/rn/pk_wgt_a/ \n'), {
    origin: 'http://localhost:8081',
    embedKey: 'pk_wgt_a',
    url: 'http://localhost:8081/h/rn/pk_wgt_a',
  });
});

test('a percent-encoded key is decoded once and re-encoded in the page URL', () => {
  const page = parseWidgetUrl('https://w.x.ai/h/rn/pk%20a');
  assert.equal(page.embedKey, 'pk a');
  assert.equal(page.url, 'https://w.x.ai/h/rn/pk%20a');
});

for (const bad of [
  '',
  'https://widget.acme.mentiora.ai',
  'https://widget.acme.mentiora.ai/pk_wgt_a1b2c3d4e5f6',
  'https://widget.acme.mentiora.ai/h/web/pk_wgt_a1b2c3d4e5f6',
  'https://widget.acme.mentiora.ai/h/rn/',
  'https://widget.acme.mentiora.ai/h/rn/pk_wgt_a1b2c3d4e5f6/extra',
  'https://widget.acme.mentiora.ai/h/rn/pk_wgt_a1b2c3d4e5f6?x=1',
  'https://widget.acme.mentiora.ai/h/rn/pk_wgt_a1b2c3d4e5f6#top',
  'ftp://widget.acme.mentiora.ai/h/rn/pk_wgt_a1b2c3d4e5f6',
  'https://widget.acme.mentiora.ai@evil.com/h/rn/pk_wgt_a1b2c3d4e5f6',
  'https://w.x.ai/h/rn/%E0%A4%A',
]) {
  test(`rejects ${JSON.stringify(bad)} with an error naming the expected shape`, () => {
    assert.throws(() => parseWidgetUrl(bad), /widgetUrl.*\/h\/rn\//);
  });
}

test('rejects a missing value, as a JS caller without types can pass', () => {
  assert.throws(() => parseWidgetUrl(undefined as unknown as string), /widgetUrl/);
});
