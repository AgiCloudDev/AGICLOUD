import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Catalogo degli agenti che sappiamo avviare in modalita' ACP.
// Un agente nuovo = una voce qui, nient'altro (purche' parli ACP su stdio).

export interface AgentSpec {
  id: string;
  label: string;
  command: string;
  args: string[];
  /** true = l'agente parla ACP da solo; false = serve un adattatore (pacchetto npm) */
  native: boolean;
  /** Avviso da mostrare nella UI (requisiti, costi) */
  note?: string;
  /** Metodo di login ACP da chiamare sempre prima di aprire la sessione */
  authMethod?: string;
  /** Variabili d'ambiente da togliere sempre: cambierebbero il login dell'agente */
  envBlock?: string[];
  /** Riconosce in una riga di stderr un errore che l'agente non riporta via ACP (il turno resterebbe appeso) */
  stderrError?: (line: string) => string | undefined;
  /** Modelli da aggiungere al selettore se l'agente non li elenca ancora (es. appena usciti) */
  extraModels?: { value: string; name: string; description?: string }[];
}

// OpenCode: se il fornitore del modello risponde con un errore (es. quota gratuita finita)
// lo scrive solo nel log e non chiude il turno ACP. Con --print-logs il log arriva su stderr.
export function opencodeStderrError(line: string): string | undefined {
  if (!line.includes('level=ERROR') || !line.includes('message="stream error"')) return undefined;
  const m = line.match(/error\.error="((?:[^"\\]|\\.)*)"/);
  const detail = (m?.[1] ?? 'errore del fornitore del modello').replace(/^AI_APICallError:\s*/, '');
  const model = line.match(/modelID=(\S+)/)?.[1];
  return model ? `OpenCode (${model}): ${detail}` : `OpenCode: ${detail}`;
}

/**
 * OpenCode: OPENCODE_BIN se impostato, poi quello dell'installer ufficiale (~/.opencode/bin, si aggiorna da solo),
 * altrimenti dal PATH. Due versioni diverse condividono lo stesso database: la piu' vecchia, dopo che la nuova
 * lo ha aggiornato, non parte piu' ("no such column"). Si ricalcola a ogni uso.
 */
export function opencodeBin(): string {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const local = join(homedir(), '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  return existsSync(local) ? local : 'opencode';
}

export const AGENTS: Record<string, AgentSpec> = {
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    get command() {
      return opencodeBin();
    },
    args: ['acp', '--print-logs'],
    native: true,
    stderrError: opencodeStderrError,
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    // Adattatore ufficiale ACP sopra il Claude Agent SDK (usa il login di `claude`)
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.102.0'],
    native: false,
    // L'elenco che arriva dall'account puo' restare indietro: i modelli nuovi si scelgono comunque per id
    extraModels: [{ value: 'claude-fable-5-2', name: 'Fable 5.2', description: 'Claude Fable 5.2' }],
    // Con una chiave API nell'ambiente Claude Code fatturerebbe sull'API invece dell'abbonamento
    // Variabili di una sessione Claude Code "madre": il Claude della chat deve partire come uno normale
    envBlock: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH'],
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    command: 'cursor-agent',
    args: ['acp'],
    native: true,
    // Cursor vuole authenticate prima di session/new (usa il login gia' fatto con `cursor-agent login`)
    authMethod: 'cursor_login',
    note: 'Usa il tuo account Cursor (anche il piano gratuito)',
  },
  agy: {
    id: 'agy',
    label: 'agy (Antigravity)',
    // Adattatore nostro (agy-agent.ts): agy non parla ACP
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./agy-agent.ts', import.meta.url))],
    native: false,
    note: 'Usa il tuo account Google. I comandi di shell richiedono Permessi: Consenti tutto (agy non puo\' chiedere conferma)',
  },
};

// Codex: per chi ha un abbonamento ChatGPT (o una chiave API, a consumo). Usa il login di `codex login`.
AGENTS.codex = {
  id: 'codex',
  label: 'Codex',
  command: 'npx',
  args: ['-y', '@agentclientprotocol/codex-acp@2.2.2'],
  native: false,
  note: 'Usa il tuo account ChatGPT (con una chiave API si paga a consumo)',
};

// Agente finto (demo-agent.ts): opzioni, comandi, permessi, ripresa. Per prove e test UI.
if (process.env.AGICLOUD_DEMO_AGENT === '1') {
  AGENTS.demo = {
    id: 'demo',
    label: 'Demo (agente finto)',
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./demo-agent.ts', import.meta.url))],
    native: true,
    note: 'Agente di prova: non usa modelli. Scrivi "crea un file" per provare i permessi, /piano per un piano',
  };
}

export function getAgent(id: string): AgentSpec {
  const spec = AGENTS[id];
  if (!spec) throw new Error(`Agente sconosciuto: ${id} (disponibili: ${Object.keys(AGENTS).join(', ')})`);
  return spec;
}
