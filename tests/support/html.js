'use strict';

/**
 * tests/support/html.js — assert that a string is valid Telegram HTML.
 *
 * Telegram rejects a whole message with `400 can't parse entities` when its
 * markup is unbalanced, so the tests validate every outgoing string the same way
 * the Bot API would. Shared by `messages.test.js` and `router.test.js`.
 */

const assert = require('node:assert/strict');

/** Tags Telegram's HTML parse mode supports. */
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'span',
  'tg-spoiler', 'a', 'code', 'pre', 'blockquote'
]);

/** Fail if `text` has a raw `<`/`>` that is not part of a supported tag. */
function assertNoRawAngle(text, label) {
  assert.ok(!text.includes('<'), `${label}: raw '<' outside a supported tag: ${JSON.stringify(text.slice(0, 120))}`);
  assert.ok(!text.includes('>'), `${label}: raw '>' (use &gt;): ${JSON.stringify(text.slice(0, 120))}`);
}

/** Validate a rendered string the way Telegram's HTML parser would. */
function assertTelegramHtml(text, label) {
  assert.equal(typeof text, 'string', `${label}: not a string`);
  assert.ok(text.length > 0, `${label}: empty`);
  assert.ok(text.length <= 4096, `${label}: over Telegram's 4096-char message limit`);

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;
  const stack = [];
  let last = 0;
  let match;

  while ((match = tagRe.exec(text)) !== null) {
    assertNoRawAngle(text.slice(last, match.index), label);
    const name = match[1].toLowerCase();
    assert.ok(ALLOWED_TAGS.has(name), `${label}: Telegram does not support <${name}>`);
    if (match[0].startsWith('</')) {
      assert.equal(stack.pop(), name, `${label}: unbalanced </${name}>`);
    } else {
      stack.push(name);
    }
    last = match.index + match[0].length;
  }
  assertNoRawAngle(text.slice(last), label);
  assert.deepEqual(stack, [], `${label}: unclosed tag(s) ${stack.join(', ')}`);

  const bare = text.replace(/&(amp|lt|gt|quot|#\d+);/g, '');
  assert.ok(!bare.includes('&'), `${label}: bare '&' must be written '&amp;'`);
  return text;
}

module.exports = { assertTelegramHtml, assertNoRawAngle, ALLOWED_TAGS };
