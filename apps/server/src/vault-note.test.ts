import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vaultNote } from './threads.js';

test('vaultNote: elenca solo i nomi, vuota senza chiavi', () => {
  assert.equal(vaultNote([]), '');
  const note = vaultNote(['OPENROUTER_API_KEY', 'FAL_KEY']);
  assert.match(note, /FAL_KEY, OPENROUTER_API_KEY/);
  assert.match(note, /Impostazioni -> Chiavi/);
});
