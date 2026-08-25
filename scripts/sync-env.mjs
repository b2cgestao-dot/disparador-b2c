// Gera/atualiza o .env local a partir do `supabase status -o json`.
// Mantem valores ja existentes no .env; so sobrescreve as chaves do Supabase.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, '.env');
const EXAMPLE = path.join(ROOT, '.env.example');

function parse(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

let status;
try {
  status = JSON.parse(execSync('supabase status -o json', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
} catch (e) {
  console.error('[sync-env] supabase status falhou; a stack esta no ar?');
  process.exit(1);
}
const url = status.API_URL || status.api_url;
const anon = status.ANON_KEY || status.anon_key || status.PUBLISHABLE_KEY;
const service = status.SERVICE_ROLE_KEY || status.service_role_key || status.SECRET_KEY;
if (!url || !anon || !service) {
  console.error('[sync-env] nao achei API_URL/ANON_KEY/SERVICE_ROLE_KEY no status:', Object.keys(status));
  process.exit(1);
}

const base = parse(fs.readFileSync(EXAMPLE, 'utf8'));
const current = fs.existsSync(ENV) ? parse(fs.readFileSync(ENV, 'utf8')) : {};
const merged = { ...base, ...current };
merged.SUPABASE_URL = url.replace('localhost', '127.0.0.1');
merged.SUPABASE_ANON_KEY = anon;
merged.SUPABASE_SERVICE_KEY = service;
merged.SUPABASE_URL_DOCKER = merged.SUPABASE_URL.replace(/https?:\/\/(127\.0\.0\.1|localhost)/, 'http://host.docker.internal');
if (status.DB_URL) merged.SUPABASE_DB_URL = status.DB_URL;

const lines = ['# gerado por scripts/sync-env.mjs a partir de `supabase status` (local). Ver .env.example.'];
for (const [k, v] of Object.entries(merged)) lines.push(`${k}=${v}`);
fs.writeFileSync(ENV, lines.join('\n') + '\n');
console.log(`[sync-env] .env atualizado (SUPABASE_URL=${merged.SUPABASE_URL})`);
