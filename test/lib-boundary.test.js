/**
 * The boundary around public/js/lib/.
 *
 * lib/ is the code other hosts share: the server renderer (renderer/, the Lambda Adafruit
 * IO invokes) runs it as-is. So it may only import other lib/ modules (and, later,
 * `konva` by bare name, which each host resolves itself), and it may not reach for the
 * page: no document, window or localStorage. Editor state and DOM wiring stay in
 * canvas/, core/, device/ and screens/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('../public/js/lib/', import.meta.url));
const BARE_ALLOWED = new Set(['konva']);
const PAGE_GLOBALS = /\b(document|window|localStorage|sessionStorage|navigator)\b/;

// comments and string literals are prose, not code
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
  .replace(/`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''");

const libFiles = fs.readdirSync(LIB).filter((f) => f.endsWith('.js'));

test('lib/ has modules to check', () => {
  assert.ok(libFiles.length > 0);
});

for (const file of libFiles) {
  const src = fs.readFileSync(path.join(LIB, file), 'utf8');

  test(`lib/${file} imports only lib/ modules`, () => {
    const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1] || m[2]);

    for (const spec of specs) {
      if (BARE_ALLOWED.has(spec)) continue;
      assert.ok(spec.startsWith('./'), `${file} imports "${spec}"`);
      assert.ok(fs.existsSync(path.join(LIB, spec)), `${file} imports missing "${spec}"`);
    }
  });

  test(`lib/${file} does not touch the page`, () => {
    const hit = codeOnly(src).match(PAGE_GLOBALS);
    assert.equal(hit, null, `${file} uses "${hit?.[0]}"`);
  });
}
