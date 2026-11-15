// Cartelle di progetto: si possono aprire solo dentro le radici consentite (PROJECT_ROOTS).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { HttpError } from './errors.js';

const execFileAsync = promisify(execFile);
const MAX_DIRS = 500;
const GIT_URL_RE = /^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/i;
const GIT_ANY_URL_RE = /^(https?:\/\/|ssh:\/\/|git@|file:\/\/)[^\s]+$/i;
const GITHUB_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIR_NAME_RE = /^[a-zA-Z0-9._-]{1,100}$/;

function insideRoots(p: string): boolean {
  return config.projectRoots.some((root) => p === root || p.startsWith(root + sep));
}

/** Percorso canonico di una cartella consentita, altrimenti errore 400 */
export function resolveProject(path: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new HttpError(400, `Cartella inesistente: ${path}`);
  }
  if (!insideRoots(real)) throw new HttpError(400, `Cartella fuori dalle radici consentite: ${real}`);
  if (!statSync(real).isDirectory()) throw new HttpError(400, `Non e' una cartella: ${real}`);
  return real;
}

export interface DirEntry {
  name: string;
  path: string;
  git: boolean;
}

/** Sottocartelle (senza quelle nascoste e node_modules); senza path: le radici */
export function listDirs(path?: string): { path: string | null; parent: string | null; dirs: DirEntry[] } {
  if (!path) {
    return {
      path: null,
      parent: null,
      dirs: config.projectRoots.map((p) => ({ name: p, path: p, git: existsSync(join(p, '.git')) })),
    };
  }
  const real = resolveProject(path);
  let names: string[] = [];
  try {
    names = readdirSync(real, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_DIRS);
  } catch {
    throw new HttpError(400, `Cartella non leggibile: ${real}`);
  }
  const parent = dirname(real);
  return {
    path: real,
    parent: real !== parent && insideRoots(parent) ? parent : null,
    dirs: names.map((name) => {
      const p = join(real, name);
      return { name, path: p, git: existsSync(join(p, '.git')) };
    }),
  };
}

/** True if the input looks like a Git URL or a GitHub owner/repo shorthand. */
export function isGitSource(input: string): boolean {
  const s = input.trim();
  if (!s || s.startsWith('/')) return false;
  return GIT_URL_RE.test(s) || GITHUB_SLUG_RE.test(s);
}

/** Normalize a Git URL or owner/repo shorthand and derive the target folder name. */
export function parseGitSource(rawUrl: string): { url: string; name: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new HttpError(400, "Inserisci l'indirizzo del repository Git");
  const clean = trimmed.replace(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/(?:tree|blob)\/.*$/i, '$1');
  let url = clean;
  if (GITHUB_SLUG_RE.test(clean)) {
    url = `https://github.com/${clean.replace(/\.git$/i, '')}.git`;
  } else if (!GIT_ANY_URL_RE.test(clean)) {
    throw new HttpError(400, 'Indirizzo Git non valido (es. https://github.com/utente/repo)');
  }
  const tail = url.replace(/\/+$/, '').replace(/\.git$/i, '').split(/[/:]/).pop() ?? '';
  const name = tail.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+/, '');
  if (!name || name.startsWith('-')) {
    throw new HttpError(400, 'Indirizzo Git non valido (es. https://github.com/utente/repo)');
  }
  return { url, name };
}

function targetBase(parentDir?: string): string {
  const raw = parentDir?.trim() || config.projectRoots[0] || config.workspacesRoot;
  return resolveProject(raw);
}

/** Create a project subfolder inside an allowed root. */
export function createProjectDir(rawName: string, parentDir?: string): { path: string; parent: string; name: string } {
  const name = rawName.trim();
  if (!DIR_NAME_RE.test(name) || name === '.' || name === '..') throw new HttpError(400, 'Nome non valido');
  const base = targetBase(parentDir);
  const dest = join(base, name);
  mkdirSync(dest, { recursive: true });
  return { path: realpathSync(dest), parent: base, name };
}

/** Clone a Git repository into an allowed folder, or fast-forward update if already cloned. */
export async function cloneProject(
  rawUrl: string,
  parentDir?: string,
  githubToken?: string,
): Promise<{ path: string; parent: string; name: string; existed: boolean }> {
  const { url, name } = parseGitSource(rawUrl);
  const base = targetBase(parentDir);
  const dest = join(base, name);
  if (existsSync(join(dest, '.git'))) {
    await execFileAsync('git', ['-C', dest, 'pull', '--ff-only'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 60_000,
    }).catch(() => {});
    return { path: realpathSync(dest), parent: base, name, existed: true };
  }
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    throw new HttpError(409, `Esiste gia': ${dest}`);
  }
  const args: string[] = [];
  if (githubToken && url.startsWith('https://github.com/')) {
    const basic = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
    args.push('-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`);
  }
  args.push('clone', '--', url, dest);
  try {
    await execFileAsync('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 120_000,
    });
  } catch {
    throw new HttpError(
      400,
      "Impossibile clonare il repository (controlla l'indirizzo; se e' privato aggiungi GITHUB_TOKEN in Impostazioni → Chiavi)",
    );
  }
  return { path: realpathSync(dest), parent: base, name, existed: false };
}
