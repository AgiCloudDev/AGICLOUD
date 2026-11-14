import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, opencodeStderrError } from './agents.js';
import { withExtraModels } from './agent-session.js';

test('OpenCode: errore del fornitore riconosciuto nel log', () => {
  const line = 'timestamp=2026-11-09T20:21:11.622Z level=ERROR run=db214b3a message="stream error" providerID=opencode modelID=glm-5.3-flash-free agent=build error.error="AI_APICallError: Free usage limit reached. Subscribe to keep going"';
  assert.equal(opencodeStderrError(line), 'OpenCode (glm-5.3-flash-free): Free usage limit reached. Subscribe to keep going');
  assert.equal(opencodeStderrError('timestamp=x level=INFO message=loop'), undefined);
});

test('Claude: i modelli extra si aggiungono una volta sola', () => {
  const opts = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }] }] as any;
  const once = withExtraModels(opts, AGENTS.claude) as any;
  assert.ok(once[0].options.some((o: any) => o.value === 'claude-fable-5-2'));
  assert.equal((withExtraModels(once, AGENTS.claude) as any)[0].options.length, once[0].options.length);
});
