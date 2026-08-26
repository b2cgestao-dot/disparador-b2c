// T10 - Artefatos de deploy (sem deploy real): existem e passam num lint basico.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dockerEnv } from './helpers.mjs';

const read = (f) => fs.readFileSync(f, 'utf8');
function docker(args, opts = {}) { return execFileSync('docker', args, { env: dockerEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }
function dockerAvailable() { try { docker(['info']); return true; } catch { return false; } }

test('T10: os quatro artefatos existem', () => {
  for (const f of ['server/Dockerfile', 'docker-compose.prod.yml', 'Caddyfile', 'DEPLOY.md']) assert.ok(fs.existsSync(f), f);
});

test('T10: server/Dockerfile usa node 22-alpine, instala deps e sobe o index.js', () => {
  const d = read('server/Dockerfile');
  assert.match(d, /^FROM node:22-alpine/m);
  assert.match(d, /npm ci/);
  assert.match(d, /CMD \["node", "src\/index\.js"\]/);
  assert.match(d, /HEALTHCHECK/);
});

test('T10: docker-compose.prod.yml e valido (docker compose config) com api + caddy, restart e healthcheck', (t) => {
  const y = read('docker-compose.prod.yml');
  assert.match(y, /^\s{2}api:/m); assert.match(y, /^\s{2}caddy:/m);
  assert.match(y, /restart: unless-stopped/); assert.match(y, /healthcheck:/);
  assert.match(y, /env_file: \.env/);
  assert.match(y, /NODE_ENV: production/);
  if (!dockerAvailable()) return t.skip('docker indisponivel: pulando `compose config`');
  const out = docker(['compose', '-f', 'docker-compose.prod.yml', 'config']);
  assert.match(out, /disparador-api/); assert.match(out, /caddy:2-alpine/);
});

test('T10: Caddyfile tem no-cache cobrindo a raiz "/" (anti-bug #8), proxy de /api/* e /whatsapp/*', () => {
  const c = read('Caddyfile');
  assert.match(c, /^\s*header \/ Cache-Control "no-cache/m, 'no-cache na raiz /');
  assert.match(c, /^\s*header \/index\.html Cache-Control "no-cache/m);
  assert.match(c, /handle \/api\/\* \{\s*\n\s*reverse_proxy api:3000/);
  assert.match(c, /handle \/whatsapp\/\* \{\s*\n\s*reverse_proxy api:3000/);
  assert.match(c, /root \* \/srv\/web/); assert.match(c, /file_server/);
});

test('T10: Caddyfile passa no `caddy validate` (via imagem caddy:2-alpine)', (t) => {
  if (!dockerAvailable()) return t.skip('docker indisponivel');
  let out;
  try {
    out = docker(['run', '--rm', '-v', `${process.cwd()}/Caddyfile:/etc/caddy/Caddyfile:ro`, 'caddy:2-alpine', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], { timeout: 180000 });
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (/pull|manifest|network|TLS handshake|no such host|timeout/i.test(msg)) return t.skip('nao consegui baixar caddy:2-alpine: ' + msg.slice(0, 120));
    assert.fail('caddy validate falhou: ' + msg);
  }
  assert.match(out + '', /Valid configuration/);
});

test('T10: DEPLOY.md e um runbook com scp + docker compose up -d --build e o checklist de go-live', () => {
  const d = read('DEPLOY.md');
  assert.match(d, /scp /); assert.match(d, /docker compose -f docker-compose\.prod\.yml up -d --build/);
  assert.match(d, /schema\.sql/); assert.match(d, /whatsapp\/webhook/); assert.match(d, /Inscrever app/);
  assert.match(d, /BLOCKED|NO AR/);
});

test('T10: estado da tarefa registrado em TASKS.md (BLOCKED aguardando VPS ou DONE apos o deploy) e em CREDENTIALS-TODO.md', () => {
  assert.match(read('TASKS.md'), /## \[(!|x)\] T10 - Artefatos de deploy \((BLOCKED|DONE)/);
  assert.match(read('CREDENTIALS-TODO.md'), /VPS/); assert.match(read('CREDENTIALS-TODO.md'), /DEPLOY\.md/);
});
