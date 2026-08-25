// T2 - Backend esqueleto: health, bodyLimit 50MB, rawBody preservado, sem rotas duplicadas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { api, API } from './helpers.mjs';

test('T2: GET /health responde 200 com corpo de status', async () => {
  const r = await api('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.ok(r.body.meta_base_url, 'expoe META_BASE_URL em uso');
  assert.ok(typeof r.body.uptime_s === 'number');
});

test('T2: POST com corpo de ~2 MB NAO retorna 413', async () => {
  const big = { lista: 'x'.repeat(2 * 1024 * 1024) };
  const raw = Buffer.from(JSON.stringify(big));
  assert.ok(raw.length > 2 * 1024 * 1024);
  const r = await api('/_debug/echo-hmac', { raw, headers: { 'Content-Type': 'application/json' }, method: 'POST' });
  assert.notEqual(r.status, 413, 'nao pode dar 413');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, raw.length, 'backend recebeu o corpo inteiro');
});

test('T2: rawBody fica disponivel cru no handler (HMAC bate byte a byte)', async () => {
  // JSON com espacos/ordem "estranha": se o backend re-serializasse, o hash mudaria.
  const raw = Buffer.from('{ "b": 2,   "a": [1, 2, 3], "u": "ação ✓" }\n');
  const secret = 'segredo-' + crypto.randomBytes(4).toString('hex');
  const expectedSha = crypto.createHash('sha256').update(raw).digest('hex');
  const expectedHmac = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const r = await api('/_debug/echo-hmac', { method: 'POST', raw, headers: { 'Content-Type': 'application/json', 'x-debug-secret': secret } });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, raw.length);
  assert.equal(r.body.sha256, expectedSha);
  assert.equal(r.body.hmac, expectedHmac);
  assert.equal(r.body.parsed_type, 'object', 'e o JSON tambem foi parseado');
});

test('T2: JSON invalido retorna 400 (nao derruba o processo)', async () => {
  const r = await api('/_debug/echo-hmac', { method: 'POST', raw: Buffer.from('{ isso nao e json'), headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  const h = await api('/health');
  assert.equal(h.status, 200, 'processo continua vivo');
});

test('T2: CORS habilitado', async () => {
  const res = await fetch(`${API}/health`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:9999', 'Access-Control-Request-Method': 'GET' } });
  assert.ok([200, 204].includes(res.status));
  assert.ok(res.headers.get('access-control-allow-origin'), 'access-control-allow-origin presente');
});

test('T2: nao existem rotas duplicadas em server/src/index.js (anti-bug #4)', () => {
  const src = fs.readFileSync('server/src/index.js', 'utf8');
  // convencao: `app.<metodo>('<rota>'` (raiz) e `api.<metodo>('<rota>'` (prefixo /api-oficial)
  const re = /\b(app|api)\.(get|post|put|patch|delete|head|options)\(\s*(['"`])([^'"`]+)\3/g;
  const seen = new Map();
  const dups = [];
  let m;
  while ((m = re.exec(src))) {
    const prefix = m[1] === 'api' ? '/api-oficial' : '';
    const key = `${m[2].toUpperCase()} ${prefix}${m[4]}`;
    if (seen.has(key)) dups.push(key);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  assert.ok(seen.size >= 3, 'achou rotas no arquivo');
  assert.deepEqual(dups, [], `rotas duplicadas: ${dups.join(', ')}`);
  // e o processo esta no ar (Fastify derruba o processo em rota duplicada)
  return api('/health').then((r) => assert.equal(r.status, 200));
});
