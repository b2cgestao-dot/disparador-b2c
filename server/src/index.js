// ============================================================================
// Disparador WhatsApp (API Oficial) - backend inteiro em um arquivo.
// Fastify 5 + Supabase (service key) + Meta Graph API (via META_BASE_URL).
// Secoes: [0] config  [1] utilitarios  [2] auth  [3] meta client  [4] health
//         [5] contas  [6] webhook  [7] inbox  [8] templates  [9] disparo
//         [10] fluxos  [11] static  [12] start
// ============================================================================
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ----------------------------------------------------------------- [0] config
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
// URL publica do Supabase (o que o navegador enxerga). Em producao = SUPABASE_URL.
const SUPABASE_PUBLIC_URL = (process.env.SUPABASE_PUBLIC_URL || SUPABASE_URL).replace(/\/$/, '');
// [PLUG-KEY] META_BASE_URL: mock em dev/teste (http://mock-meta:4000), Graph real em producao
// (https://graph.facebook.com). NUNCA cravar graph.facebook.com no codigo.
const META_BASE_URL = (process.env.META_BASE_URL || 'https://graph.facebook.com').replace(/\/$/, '');
const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const DEBUG_ROUTES = process.env.DEBUG_ROUTES === '1' || NODE_ENV !== 'production';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = process.env.WEB_DIR || path.resolve(__dirname, '../../web');

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[api] SUPABASE_URL e SUPABASE_SERVICE_KEY sao obrigatorios (ver .env.example)');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 50 * 1024 * 1024, // 50 MB (anti-bug #1: disparo grande dava 413)
  trustProxy: true,
  // O front chama API_URL='/api' + rota. Em producao o Caddy encaminha /api/*
  // pra ca; aqui tiramos o prefixo pra rota interna (/api/api-oficial/x -> /api-oficial/x).
  rewriteUrl(req) { return req.url.startsWith('/api/') ? req.url.slice(4) : req.url; },
});
await app.register(cors, { origin: true });

// Parser JSON que PRESERVA o rawBody (anti-bug #2: validacao X-Hub-Signature-256)
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  req.rawBody = body;
  if (!body || body.length === 0) return done(null, {});
  try { done(null, JSON.parse(body.toString('utf8'))); }
  catch (e) { e.statusCode = 400; done(e, undefined); }
});
app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
  req.rawBody = body;
  done(null, body);
});

// ------------------------------------------------------------ [1] utilitarios
const onlyDigits = (s) => String(s ?? '').replace(/\D/g, '');
const nowIso = () => new Date().toISOString();
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
const SECRET_FIELDS = ['access_token', 'app_secret'];
function publicAccount(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of SECRET_FIELDS) { out[`has_${f}`] = !!out[f]; delete out[f]; }
  return out;
}
function httpError(reply, status, error, extra = {}) {
  return reply.code(status).send({ error, ...extra });
}
function dbFail(reply, error, ctx) {
  app.log.error({ err: error, ctx }, 'erro supabase');
  return httpError(reply, 500, 'DB_ERROR', { detail: error.message || String(error), ctx });
}

// -------------------------------------------------------------------- [2] auth
const userCache = new Map(); // token -> { user, exp }
async function requireAuth(req, reply) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  if (!token) return httpError(reply, 401, 'NAO_AUTENTICADO');
  const cached = userCache.get(token);
  if (cached && cached.exp > Date.now()) { req.user = cached.user; return; }
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return httpError(reply, 401, 'TOKEN_INVALIDO');
  userCache.set(token, { user: data.user, exp: Date.now() + 60_000 });
  if (userCache.size > 500) userCache.delete(userCache.keys().next().value);
  req.user = data.user;
}

// ------------------------------------------------------------- [3] meta client
class MetaError extends Error {
  constructor(message, { status, meta }) { super(message); this.name = 'MetaError'; this.status = status; this.meta = meta; }
  get code() { return this.meta?.code ?? null; }
}
// Chama a Graph API da Meta. path sem versao (ex.: `${pnid}/messages`).
async function metaFetch(account, p, { method = 'GET', body, query, headers = {}, token } = {}) {
  const url = new URL(`${META_BASE_URL}/${META_API_VERSION}/${String(p).replace(/^\//, '')}`);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const isBuf = Buffer.isBuffer(body);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token || account?.access_token || ''}`,
      ...(body !== undefined && !isBuf ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : (isBuf ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new MetaError(json?.error?.message || `Meta HTTP ${res.status}`, { status: res.status, meta: json?.error || json });
  }
  return json;
}
function metaErrorPayload(e) {
  if (e instanceof MetaError) return { error: 'META_ERROR', code: e.code, message: e.message, meta: e.meta };
  return { error: 'META_UNREACHABLE', message: String(e?.message || e) };
}

// ----------------------------------------------------------------- [4] health
const startedAt = Date.now();
app.get('/health', async () => ({
  status: 'ok', service: 'disparador-api', env: NODE_ENV, uptime_s: Math.round((Date.now() - startedAt) / 1000),
  meta_base_url: META_BASE_URL, meta_api_version: META_API_VERSION, time: nowIso(),
}));

if (DEBUG_ROUTES) {
  // Somente dev/teste: prova que o rawBody chega cru ao handler (teste da T2).
  app.post('/_debug/echo-hmac', async (req) => {
    const raw = req.rawBody || Buffer.alloc(0);
    const secret = String(req.headers['x-debug-secret'] || 'debug');
    return {
      length: raw.length,
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      hmac: crypto.createHmac('sha256', secret).update(raw).digest('hex'),
      parsed_type: Buffer.isBuffer(req.body) ? 'buffer' : typeof req.body,
    };
  });
}

// ------------------------------------------------------------ [11] static web
// Em producao o Caddy serve o web/index.html; localmente o backend serve pra facilitar.
function serveIndex(req, reply) {
  const file = path.join(WEB_DIR, 'index.html');
  if (!fs.existsSync(file)) return httpError(reply, 404, 'INDEX_NAO_ENCONTRADO', { web_dir: WEB_DIR });
  reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  return reply.type('text/html; charset=utf-8').send(fs.readFileSync(file));
}
app.get('/', serveIndex);
app.get('/index.html', serveIndex);

// -------------------------------------------------------------------- [12] start
app.setErrorHandler((err, req, reply) => {
  if (err.validation) return httpError(reply, 400, 'VALIDACAO', { detail: err.message });
  if (err.statusCode === 413) return httpError(reply, 413, 'CORPO_GRANDE_DEMAIS');
  if (err.statusCode && err.statusCode < 500) return httpError(reply, err.statusCode, err.code || 'ERRO', { detail: err.message });
  req.log.error({ err }, 'erro nao tratado');
  return httpError(reply, 500, 'ERRO_INTERNO', { detail: err.message });
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`[api] ouvindo em :${PORT} | META_BASE_URL=${META_BASE_URL} | SUPABASE_URL=${SUPABASE_URL}`);
});
