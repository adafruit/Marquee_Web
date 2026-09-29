/**
 * cfg-marquee.json's display.rotation — public/js/device/cfg.js.
 *
 * The board reads it with ArduinoJson's `| 0` default, which turns a string into 0: write
 * "rotation": "90" and every panel quietly draws at 0°. The Rotation select's value IS a
 * string, so this pins down that the file carries a JSON number, in degrees.
 *
 * cfg.js reads the form through document.getElementById and its imports touch
 * localStorage, so both are stubbed with just enough to load it under plain node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const fields = {};
globalThis.document = {
  getElementById: (id) => fields[id] || null,
  addEventListener() {},
};
const store = { 'marquee.flow': JSON.stringify({ selectedPanel: 'magtag-2025' }) };
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const { buildMarqueeConfig } = await import('../public/js/device/cfg.js');

const configWithRotation = (value) => {
  fields.rotSel = { value };
  return JSON.parse(JSON.stringify(buildMarqueeConfig()));
};

for (const deg of ['0', '90', '180', '270']) {
  test(`rotation ${deg}° is written as the number ${deg}, not a string`, () => {
    const { rotation } = configWithRotation(deg).display;
    assert.equal(typeof rotation, 'number');
    assert.equal(rotation, Number(deg));
  });
}

test('the serialized file has no quotes around rotation', () => {
  fields.rotSel = { value: '90' };
  assert.match(JSON.stringify(buildMarqueeConfig()), /"rotation":90[,}]/);
});

test('a missing Rotation field writes 0', () => {
  delete fields.rotSel;
  assert.equal(buildMarqueeConfig().display.rotation, 0);
});
