// Chat vocale (Opzione A): trascrizione con OpenRouter (Gemini 3.5 Flash Lite -> 2.5 Flash Lite)
// e sintesi vocale gratuita con Microsoft Edge TTS (edge_tts in Python).

import { spawn } from 'node:child_process';
import type { Hono } from 'hono';
import { HttpError } from './errors.js';
import type { Settings } from './settings.js';

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const KEY_NAME = 'OPENROUTER_API_KEY';
const STT_MODELS = ['google/gemini-3.5-flash-lite', 'google/gemini-2.5-flash-lite'] as const;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_SPEAK_CHARS = 4000;
const TIMEOUT_MS = 30_000;

export const EDGE_VOICES: Record<string, readonly string[]> = {
  it: ['it-IT-DiegoNeural', 'it-IT-ElsaNeural'],
  en: ['en-US-AndrewNeural', 'en-US-AvaNeural'],
  de: ['de-DE-ConradNeural', 'de-DE-KatjaNeural'],
  cs: ['cs-CZ-AntoninNeural', 'cs-CZ-VlastaNeural'],
  ru: ['ru-RU-DmitryNeural', 'ru-RU-SvetlanaNeural'],
};

const ALL_VOICES = new Set(Object.values(EDGE_VOICES).flat());

const LANG_NAMES: Record<string, string> = {
  it: 'Italian',
  en: 'English',
  de: 'German',
  cs: 'Czech',
  ru: 'Russian',
};

const SUPPORTED_AUDIO_FORMATS = new Set(['webm', 'ogg', 'mp4', 'm4a', 'mp3', 'wav', 'aac', 'flac']);

export function resolveEdgeVoice(lang?: string, voice?: string): string {
  const v = typeof voice === 'string' ? voice.trim() : '';
  if (v && ALL_VOICES.has(v)) return v;
  const l = typeof lang === 'string' ? lang.trim().toLowerCase().slice(0, 2) : '';
  return EDGE_VOICES[l]?.[0] ?? EDGE_VOICES.it![0]!;
}

export function normalizeRate(rate?: string): string {
  if (typeof rate !== 'string') return '+0%';
  const m = /^([+-])(\d{1,2})%$/.exec(rate.trim());
  if (!m) return '+0%';
  const n = Math.min(50, Math.max(0, Number(m[2])));
  return `${m[1]}${n}%`;
}

export function audioFormatFromMime(mime?: string, filename?: string): string {
  const m = (mime ?? '').toLowerCase().split(';')[0]!.trim();
  if (m === 'audio/webm' || m === 'video/webm') return 'webm';
  if (m === 'audio/ogg' || m === 'application/ogg') return 'ogg';
  if (m === 'audio/mp4' || m === 'video/mp4') return 'mp4';
  if (m === 'audio/x-m4a' || m === 'audio/m4a') return 'm4a';
  if (m === 'audio/mpeg' || m === 'audio/mp3') return 'mp3';
  if (m === 'audio/wav' || m === 'audio/x-wav' || m === 'audio/wave') return 'wav';
  if (m === 'audio/aac' || m === 'audio/x-aac') return 'aac';
  if (m === 'audio/flac' || m === 'audio/x-flac') return 'flac';

  const ext = (filename ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (SUPPORTED_AUDIO_FORMATS.has(ext)) return ext;
  return 'webm';
}

export function cleanTextForSpeech(md: string): string {
  if (!md) return '';
  let s = md
    // Rimuove blocchi di codice recintati (```...```)
    .replace(/```[\s\S]*?```/g, ' ')
    // Rimuove immagini ![alt](url)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    // Converte link [label](url) -> label
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Rimuove backtick inline mantenendo il testo
    .replace(/`([^`]*)`/g, '$1')
    // Rimuove URL nudi
    .replace(/https?:\/\/\S+/gi, ' ')
    // Rimuove intestazioni, citazioni, liste e separatori markdown
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    // Rimuove barre delle tabelle
    .replace(/\|/g, ' ')
    // Rimuove enfasi markdown (*, _, ~)
    .replace(/[*_~]+/g, '')
    // Collassa spazi e a capo
    .replace(/\s+/g, ' ')
    .trim();

  if (s.length > MAX_SPEAK_CHARS) {
    s = s.slice(0, MAX_SPEAK_CHARS).replace(/\s+\S*$/, '').trim();
  }
  return s;
}

function stripSurroundingQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('«') && t.endsWith('»')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

async function transcribeWithOpenRouter(
  key: string,
  base64: string,
  format: string,
  lang?: string,
): Promise<{ text: string; model: string; cost: number }> {
  const langKey = typeof lang === 'string' ? lang.trim().toLowerCase().slice(0, 2) : '';
  const langName = LANG_NAMES[langKey];
  const langHint = langName ? ` The speaker is likely speaking ${langName}, though keep any technical terms or English words as spoken.` : '';
  const prompt =
    `Transcribe the spoken audio verbatim with natural punctuation.${langHint} ` +
    'Return ONLY the transcription text, with no quotes, labels, or commentary. ' +
    'If there is no speech or only silence/noise, return an empty string.';

  let lastError = '';
  for (const model of STT_MODELS) {
    try {
      const res = await fetch(OPENROUTER_API, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'X-Title': 'AgiCloud Voice',
        },
        // Non impostare reasoning: { enabled: false } perche' su gemini-3.5-flash-lite OpenRouter restituisce 400
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 2048,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'input_audio', input_audio: { data: base64, format } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => null)) as any;
      if (!res.ok || !data || data.error) {
        const msg = data?.error?.message ?? `HTTP ${res.status}`;
        if (res.status === 401 || res.status === 402) {
          throw new HttpError(409, `OpenRouter: ${msg}`);
        }
        lastError = `${model}: ${msg}`;
        continue;
      }
      const raw = String(data.choices?.[0]?.message?.content ?? '');
      return {
        text: stripSurroundingQuotes(raw),
        model,
        cost: Number(data.usage?.cost ?? 0),
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (lastError) {
    throw new HttpError(502, `Trascrizione non riuscita: ${lastError}`);
  }
  throw new HttpError(502, 'Nessun modello ha risposto: riprova tra poco');
}

const PY_EDGE_TTS = `
import asyncio, json, sys, edge_tts
payload = json.loads(sys.stdin.read())
async def main():
    comm = edge_tts.Communicate(payload["text"], payload["voice"], rate=payload["rate"])
    async for chunk in comm.stream():
        if chunk.get("type") == "audio":
            sys.stdout.buffer.write(chunk["data"])
    sys.stdout.buffer.flush()
asyncio.run(main())
`.trim();

function synthesizeEdgeTts(text: string, voice: string, rate: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', PY_EDGE_TTS], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let errText = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new HttpError(502, 'Sintesi vocale non riuscita: timeout'));
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      errText = (errText + chunk.toString()).slice(-1000);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new HttpError(502, `Sintesi vocale non riuscita: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code !== 0 || buf.length === 0) {
        const detail = errText.trim().split('\n').pop() || `exit ${code ?? 'unknown'}`;
        reject(new HttpError(502, `Sintesi vocale non riuscita: ${detail}`));
        return;
      }
      resolve(buf);
    });

    child.stdin.end(JSON.stringify({ text, voice, rate }));
  });
}

export function registerVoice(app: Hono<any>, settings: Settings): void {
  app.post('/api/voice/transcribe', async (c) => {
    const form = await c.req.parseBody();
    const audio = form.audio;
    const lang = typeof form.lang === 'string' ? form.lang : undefined;
    if (!(audio instanceof File) || audio.size === 0) {
      throw new HttpError(400, 'Audio mancante o vuoto');
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      throw new HttpError(400, 'Audio troppo grande (max 15 MB)');
    }
    const key = settings.vaultValue(KEY_NAME);
    if (!key) {
      throw new HttpError(409, `Manca ${KEY_NAME} nel portachiavi (Impostazioni → Chiavi)`);
    }
    const bytes = Buffer.from(await audio.arrayBuffer());
    const format = audioFormatFromMime(audio.type, audio.name);
    const result = await transcribeWithOpenRouter(key, bytes.toString('base64'), format, lang);
    return c.json(result);
  });

  app.post('/api/voice/speak', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const text = cleanTextForSpeech(String(body.text ?? ''));
    if (!text) return c.body(null, 204);
    const voice = resolveEdgeVoice(typeof body.lang === 'string' ? body.lang : undefined, typeof body.voice === 'string' ? body.voice : undefined);
    const rate = normalizeRate(typeof body.rate === 'string' ? body.rate : undefined);
    const mp3 = await synthesizeEdgeTts(text, voice, rate);
    return new Response(new Uint8Array(mp3), {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    });
  });
}
