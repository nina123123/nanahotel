import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPetRiv } from '../tools/build-pet-riv.mjs';

const RIV = new URL('../public/art/nana.riv', import.meta.url);
const text = (bytes) => new TextDecoder('latin1').decode(bytes);

test('public/art/nana.riv is what tools/build-pet-riv.mjs makes from the current drawing', async () => {
  const committed = new Uint8Array(await readFile(RIV));
  const built = buildPetRiv();
  assert.ok(Buffer.from(built).equals(Buffer.from(committed)), 'run: node tools/build-pet-riv.mjs');
});

test('the Rive file: header, the three artboards, and the state machine the app drives', () => {
  const bytes = buildPetRiv();
  assert.equal(text(bytes.slice(0, 4)), 'RIVE');
  assert.equal(bytes[4], 7, 'major version 7');
  const s = text(bytes);
  for (const name of ['Head', 'Body', 'Onsen', 'pet', 'mood', 'poke', 'idle', 'thinking', 'talking', 'happy', 'sleepy', 'oops', 'life', 'soak']) {
    assert.ok(s.includes(name), name);
  }
  assert.ok(bytes.length < 120_000, `${bytes.length} bytes`);
});
