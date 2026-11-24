// Gestione audio lato browser per la chat vocale (Opzione A):
// - registrazione dal microfono con eventuale stop automatico al silenzio
// - divisione del testo in streaming in frasi naturali (saltando i blocchi di codice)
// - coda di riproduzione con pre-fetch su /api/voice/speak

import { api } from './api';

export interface VoicePrefs {
  enabled: boolean;
  rate: string;
}

const PREFS_KEY = 'agicloud.voice';

export function loadVoicePrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { enabled: false, rate: '+0%' };
    const parsed = JSON.parse(raw) as Partial<VoicePrefs>;
    return {
      enabled: Boolean(parsed.enabled),
      rate: typeof parsed.rate === 'string' && /^[+-]\d{1,2}%$/.test(parsed.rate) ? parsed.rate : '+0%',
    };
  } catch {
    return { enabled: false, rate: '+0%' };
  }
}

export function saveVoicePrefs(prefs: VoicePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage non disponibile (es. modalita' privata restrittiva)
  }
}

export function canRecordAudio(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
}

export function pickAudioMime(): { mimeType: string; ext: string } {
  if (typeof MediaRecorder === 'undefined') return { mimeType: '', ext: 'webm' };
  const candidates: [string, string][] = [
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/webm', 'webm'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/mp4', 'm4a'],
  ];
  for (const [mimeType, ext] of candidates) {
    if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(mimeType)) {
      return { mimeType, ext };
    }
  }
  return { mimeType: '', ext: 'webm' };
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private timer: number | null = null;
  private raf: number | null = null;
  private audioCtx: AudioContext | null = null;
  private startedAt = 0;
  private stopped = false;
  private cancelled = false;
  private ext = 'webm';
  private mimeType = '';
  private stopPromise: Promise<{ blob: Blob; filename: string } | null> | null = null;
  private resolveStop: ((v: { blob: Blob; filename: string } | null) => void) | null = null;

  async start(opts: {
    autoStopOnSilence?: boolean;
    onTick?: (seconds: number) => void;
    onAutoStop?: () => void;
  }): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const picked = pickAudioMime();
    this.mimeType = picked.mimeType;
    this.ext = picked.ext;
    this.chunks = [];
    this.stopped = false;
    this.cancelled = false;
    this.startedAt = Date.now();

    const recorder = this.mimeType ? new MediaRecorder(this.stream, { mimeType: this.mimeType }) : new MediaRecorder(this.stream);
    this.recorder = recorder;
    this.stopPromise = new Promise((resolve) => {
      this.resolveStop = resolve;
    });

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    recorder.onstop = () => {
      this.cleanupHardware();
      if (this.cancelled) {
        this.resolveStop?.(null);
        return;
      }
      const type = this.mimeType || recorder.mimeType || 'audio/webm';
      const blob = new Blob(this.chunks, { type });
      if (blob.size < 500) {
        this.resolveStop?.(null);
        return;
      }
      this.resolveStop?.({ blob, filename: `voice.${this.ext}` });
    };

    recorder.start(250);
    opts.onTick?.(0);
    this.timer = window.setInterval(() => {
      opts.onTick?.(Math.floor((Date.now() - this.startedAt) / 1000));
    }, 500);

    if (opts.autoStopOnSilence && opts.onAutoStop) {
      this.watchSilence(this.stream, opts.onAutoStop);
    }
  }

  private watchSilence(stream: MediaStream, onAutoStop: () => void): void {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      this.audioCtx = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const data = new Float32Array(analyser.fftSize);

      let heardSpeechAt = 0;
      let speechConfirmed = false;
      let silenceSince = 0;

      const tick = () => {
        if (this.stopped || this.cancelled) return;
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();

        if (rms > 0.02) {
          if (!heardSpeechAt) heardSpeechAt = now;
          if (now - heardSpeechAt >= 250) speechConfirmed = true;
          silenceSince = 0;
        } else if (speechConfirmed) {
          if (!silenceSince) silenceSince = now;
          if (now - silenceSince >= 1800) {
            onAutoStop();
            return;
          }
        }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    } catch {
      // Se AudioContext non e' disponibile, l'utente ferma manualmente
    }
  }

  async stop(): Promise<{ blob: Blob; filename: string } | null> {
    if (this.stopped) return this.stopPromise;
    this.stopped = true;
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    } else {
      this.cleanupHardware();
      return null;
    }
    return this.stopPromise;
  }

  cancel(): void {
    this.cancelled = true;
    this.stopped = true;
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    } else {
      this.cleanupHardware();
      this.resolveStop?.(null);
    }
  }

  private cleanupHardware(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }
}

/**
 * Estrae frasi complete dal testo in streaming evitando blocchi di codice ```...```.
 * Restituisce i blocchi pronti da pronunciare e quanti caratteri dell'input sono stati consumati.
 */
export function splitSpeakableSentences(text: string, flush: boolean): { chunks: string[]; consumed: number } {
  if (!text) return { chunks: [], consumed: 0 };

  // Se c'e' un blocco di codice aperto senza chiusura, aspetta (o taglia li' se non in flush)
  const fenceMatches = [...text.matchAll(/```/g)];
  let safeEnd = text.length;
  if (!flush && fenceMatches.length % 2 === 1) {
    safeEnd = fenceMatches[fenceMatches.length - 1]!.index!;
  }
  const slice = text.slice(0, safeEnd);
  if (!slice) return { chunks: [], consumed: 0 };

  // Maschera i blocchi di codice chiusi preservando esattamente la lunghezza in indici
  const masked = slice.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length));

  const boundaries: number[] = [];
  const re = /(?:[.!?…]+(?=\s|$)|\n{2,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    boundaries.push(m.index + m[0].length);
  }

  const rawSegments: string[] = [];
  let cursor = 0;
  for (const b of boundaries) {
    const seg = masked.slice(cursor, b).trim();
    if (seg) rawSegments.push(seg);
    cursor = b;
  }

  if (flush && cursor < masked.length) {
    const tail = masked.slice(cursor).trim();
    if (tail) rawSegments.push(tail);
    cursor = slice.length;
  }

  // Raggruppa frasi brevi consecutive fino a ~260 caratteri per ridurre le chiamate TTS
  const chunks: string[] = [];
  let buf = '';
  for (const seg of rawSegments) {
    if (!buf) {
      buf = seg;
    } else if (buf.length + 1 + seg.length <= 260) {
      buf += ' ' + seg;
    } else {
      chunks.push(buf);
      buf = seg;
    }
  }
  if (buf) chunks.push(buf);

  return { chunks, consumed: cursor };
}

interface QueueEntry {
  text: string;
  opts: { lang: string; voice?: string; rate?: string };
  messageId: string | null;
  promise: Promise<Blob | null> | null;
}

// WAV silenzioso da 10ms per sbloccare l'audio dentro il gesto utente su iOS Safari / Android Chrome
const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

export class SpeechQueue {
  private audio: HTMLAudioElement;
  private queue: QueueEntry[] = [];
  private active = false;
  private aborter: AbortController | null = null;
  private currentUrl: string | null = null;
  private currentMessageId: string | null = null;
  private onChange: (state: { speaking: boolean; messageId: string | null; error?: string }) => void;

  constructor(onChange: (state: { speaking: boolean; messageId: string | null; error?: string }) => void) {
    this.onChange = onChange;
    this.audio = new Audio();
    this.audio.preload = 'auto';
  }

  unlock(): void {
    try {
      this.audio.src = SILENT_WAV;
      const p = this.audio.play();
      if (p) p.then(() => this.audio.pause()).catch(() => {});
    } catch {
      // Ignora: alcuni browser non richiedono sblocco
    }
  }

  enqueue(text: string, opts: { lang: string; voice?: string; rate?: string }, messageId: string | null = null): void {
    const cleaned = text.trim();
    if (!cleaned) return;
    if (!this.aborter) this.aborter = new AbortController();
    const entry: QueueEntry = {
      text: cleaned,
      opts,
      messageId,
      promise: null,
    };
    // Avvia subito il pre-fetch se la coda e' corta
    if (this.queue.length < 2) {
      entry.promise = api.voice.speak(entry.text, entry.opts, this.aborter.signal);
    }
    this.queue.push(entry);
    if (!this.active) {
      void this.pump();
    }
  }

  private async pump(): Promise<void> {
    this.active = true;
    while (this.queue.length > 0 && this.active) {
      const entry = this.queue.shift()!;
      this.currentMessageId = entry.messageId;
      this.onChange({ speaking: true, messageId: entry.messageId });

      // Pre-fetch del prossimo elemento mentre questo si prepara/riproduce
      const next = this.queue[0];
      if (next && !next.promise && this.aborter) {
        next.promise = api.voice.speak(next.text, next.opts, this.aborter.signal);
      }

      try {
        const signal = this.aborter?.signal;
        const blob = await (entry.promise ?? api.voice.speak(entry.text, entry.opts, signal));
        if (!this.active || signal?.aborted) break;
        if (!blob || blob.size === 0) continue;
        await this.playBlob(blob);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') break;
        if (this.active) {
          this.onChange({
            speaking: false,
            messageId: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        this.active = false;
        this.queue = [];
        return;
      }
    }
    this.active = false;
    this.currentMessageId = null;
    this.onChange({ speaking: false, messageId: null });
  }

  private playBlob(blob: Blob): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.currentUrl) {
        URL.revokeObjectURL(this.currentUrl);
        this.currentUrl = null;
      }
      const url = URL.createObjectURL(blob);
      this.currentUrl = url;
      const a = this.audio;
      const cleanup = () => {
        a.onended = null;
        a.onerror = null;
        if (this.currentUrl === url) {
          URL.revokeObjectURL(url);
          this.currentUrl = null;
        }
      };
      a.onended = () => {
        cleanup();
        resolve();
      };
      a.onerror = () => {
        cleanup();
        reject(new Error('Riproduzione audio non riuscita'));
      };
      a.src = url;
      const p = a.play();
      if (p) {
        p.catch((err) => {
          cleanup();
          reject(err);
        });
      }
    });
  }

  stop(): void {
    this.active = false;
    this.queue = [];
    if (this.aborter) {
      this.aborter.abort();
      this.aborter = null;
    }
    this.audio.onended = null;
    this.audio.onerror = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    if (this.currentMessageId !== null) {
      this.currentMessageId = null;
    }
    this.onChange({ speaking: false, messageId: null });
  }
}
