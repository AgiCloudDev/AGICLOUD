import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { HttpError } from './errors.js';
import { audioFormatFromMime, cleanTextForSpeech, normalizeRate, registerVoice, resolveEdgeVoice } from './voice.js';

test('resolveEdgeVoice: usa la voce consentita o quella predefinita della lingua', () => {
  assert.equal(resolveEdgeVoice('it'), 'it-IT-DiegoNeural');
  assert.equal(resolveEdgeVoice('en'), 'en-US-AndrewNeural');
  assert.equal(resolveEdgeVoice('de', 'de-DE-KatjaNeural'), 'de-DE-KatjaNeural');
  assert.equal(resolveEdgeVoice('it', 'voce-non-valida'), 'it-IT-DiegoNeural');
  assert.equal(resolveEdgeVoice('fr'), 'it-IT-DiegoNeural');
});

test('normalizeRate: valida e limita tra -50% e +50%', () => {
  assert.equal(normalizeRate(undefined), '+0%');
  assert.equal(normalizeRate('+20%'), '+20%');
  assert.equal(normalizeRate('-15%'), '-15%');
  assert.equal(normalizeRate('+90%'), '+50%');
  assert.equal(normalizeRate('veloce'), '+0%');
});

test('audioFormatFromMime: mappa mime e estensioni del browser', () => {
  assert.equal(audioFormatFromMime('audio/webm;codecs=opus', 'rec.webm'), 'webm');
  assert.equal(audioFormatFromMime('audio/ogg;codecs=opus', 'rec.ogg'), 'ogg');
  assert.equal(audioFormatFromMime('audio/mp4', 'rec.m4a'), 'mp4');
  assert.equal(audioFormatFromMime('', 'nota.mp3'), 'mp3');
  assert.equal(audioFormatFromMime('application/octet-stream', 'blob'), 'webm');
});

test('cleanTextForSpeech: toglie codice recintato, link e markdown mantenendo il testo', () => {
  const md = [
    '# Titolo',
    '',
    'Ecco **la risposta** con `const x = 1` e un [link utile](https://example.com).',
    '',
    '```ts',
    'console.log("non leggere");',
    '```',
    '',
    '> Nota finale https://example.com/raw',
  ].join('\n');
  const out = cleanTextForSpeech(md);
  assert.equal(out, 'Titolo Ecco la risposta con const x = 1 e un link utile. Nota finale');
  assert.equal(cleanTextForSpeech('```js\nalert(1)\n```'), '');
});

function makeApp(openRouterKey = '') {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  });
  const fakeSettings = { vaultValue: (name: string) => (name === 'OPENROUTER_API_KEY' ? openRouterKey : '') } as any;
  registerVoice(app, fakeSettings);
  return app;
}

test('POST /api/voice/speak: testo vuoto o solo codice -> 204', async () => {
  const app = makeApp();
  const res = await app.request('/api/voice/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '```ts\nconst a = 1;\n```' }),
  });
  assert.equal(res.status, 204);
});

test('POST /api/voice/transcribe: audio mancante -> 400, chiave mancante -> 409', async () => {
  const appNoKey = makeApp('');
  const emptyForm = new FormData();
  const resMissing = await appNoKey.request('/api/voice/transcribe', { method: 'POST', body: emptyForm });
  assert.equal(resMissing.status, 400);

  const form = new FormData();
  form.append('audio', new File([new Uint8Array([1, 2, 3, 4])], 'voice.webm', { type: 'audio/webm' }));
  const resNoKey = await appNoKey.request('/api/voice/transcribe', { method: 'POST', body: form });
  assert.equal(resNoKey.status, 409);
});
