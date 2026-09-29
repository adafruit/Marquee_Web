/**
 * Shared feeds — feedRef and parseSharedFeed in public/js/core/api.js.
 *
 * A feed someone else shared lives under THEIR username, and this app carries that as
 * "owner/key" in the ordinary feedKey slot. These pin the two ends of that: what a
 * pasted URL turns into, and how a stored key splits back into the request path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedRef, parseSharedFeed } from '../public/js/core/api.js';

const WANT = 'abachman/secondary.shared-message-buffer';

test('every spelling IO shows on a feed page parses to owner/key', () => {
  for (const input of [
    'https://io.adafruit.com/abachman/feeds/secondary.shared-message-buffer',
    'https://io.adafruit.com/api/v2/abachman/feeds/secondary.shared-message-buffer',
    'https://io.adafruit.com/api/v2/abachman/feeds/secondary.shared-message-buffer/data',
    'https://io.adafruit.com/api/v2/abachman/feeds/secondary.shared-message-buffer/data/last',
    'io.adafruit.com/abachman/feeds/secondary.shared-message-buffer',
    'abachman/feeds/secondary.shared-message-buffer',
    'abachman/secondary.shared-message-buffer',
    '  abachman/feeds/secondary.shared-message-buffer/  ',
    'https://io.adafruit.com/abachman/feeds/secondary.shared-message-buffer?foo=1',
  ]) assert.equal(parseSharedFeed(input), WANT, input);
});

test('input without an owner, or with junk in it, is refused', () => {
  for (const input of ['', '   ', 'secondary.shared-message-buffer', 'abachman/feeds',
    'abachman/feeds/', 'https://io.adafruit.com/', 'a b/c', 'owner/fe<ed'])
    assert.equal(parseSharedFeed(input), null, input);
});

test('feedRef splits a shared key and defaults a bare one to the connected user', () => {
  assert.deepEqual(feedRef(WANT, 'me'), { owner: 'abachman', key: 'secondary.shared-message-buffer' });
  assert.deepEqual(feedRef('marquee-magtag.bitmap', 'me'), { owner: 'me', key: 'marquee-magtag.bitmap' });
  assert.deepEqual(feedRef('', 'me'), { owner: 'me', key: '' });
});
