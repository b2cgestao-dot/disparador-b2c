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

// ----------------------------------------------------------------- [5] contas
const ACCOUNT_FIELDS = ['label', 'phone_number_id', 'waba_id', 'app_id', 'access_token', 'app_secret', 'verify_token', 'display_phone', 'active'];
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

async function getAccount(id) {
  if (!isUuid(id)) return null;
  const { data, error } = await sb.from('whatsapp_api_accounts').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}
async function getAccountByPnid(pnid) {
  const { data, error } = await sb.from('whatsapp_api_accounts').select('*').eq('phone_number_id', String(pnid)).maybeSingle();
  if (error) throw error;
  return data;
}
async function updateAccount(id, patch) {
  const { data, error } = await sb.from('whatsapp_api_accounts').update(patch).eq('id', id).select('*').maybeSingle();
  if (error) throw error;
  return data;
}
// Executa uma chamada a Meta em nome de uma conta; erros viram 502 com detalhe.
async function withMeta(reply, fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof MetaError) return reply.code(502).send(metaErrorPayload(e));
    app.log.error({ err: e }, 'meta unreachable');
    return reply.code(502).send(metaErrorPayload(e));
  }
}

app.register(async function apiOficial(api) {
  api.addHook('preHandler', requireAuth);

  // ---- CRUD de contas ----
  api.get('/accounts', async (req, reply) => {
    const { data, error } = await sb.from('whatsapp_api_accounts').select('*').order('created_at', { ascending: true });
    if (error) return dbFail(reply, error, 'list accounts');
    return data.map(publicAccount);
  });

  api.post('/accounts', async (req, reply) => {
    const row = pick(req.body || {}, ACCOUNT_FIELDS);
    for (const k of Object.keys(row)) if (typeof row[k] === 'string') row[k] = row[k].trim();
    if (!row.label || !row.phone_number_id) return httpError(reply, 400, 'CAMPOS_OBRIGATORIOS', { campos: ['label', 'phone_number_id'] });
    if (row.active === undefined) row.active = true;
    const { data, error } = await sb.from('whatsapp_api_accounts').insert(row).select('*').single();
    if (error) {
      if (error.code === '23505') return httpError(reply, 409, 'PHONE_NUMBER_ID_JA_CADASTRADO');
      return dbFail(reply, error, 'create account');
    }
    return reply.code(201).send(publicAccount(data));
  });

  api.get('/accounts/:id', async (req, reply) => {
    const acc = await getAccount(req.params.id);
    if (!acc) return httpError(reply, 404, 'CONTA_NAO_ENCONTRADA');
    return publicAccount(acc);
  });

  api.patch('/accounts/:id', async (req, reply) => {
    const acc = await getAccount(req.params.id);
    if (!acc) return httpError(reply, 404, 'CONTA_NAO_ENCONTRADA');
    const patch = pick(req.body || {}, ACCOUNT_FIELDS);
    for (const k of Object.keys(patch)) if (typeof patch[k] === 'string') patch[k] = patch[k].trim();
    // segredo vazio no PATCH = manter o atual
    for (const f of SECRET_FIELDS) if (patch[f] === '' || patch[f] === null) delete patch[f];
    if (patch.label === '') delete patch.label;
    if (patch.phone_number_id === '') delete patch.phone_number_id;
    if (!Object.keys(patch).length) return httpError(reply, 400, 'NADA_PARA_ATUALIZAR');
    try {
      const data = await updateAccount(acc.id, patch);
      return publicAccount(data);
    } catch (error) {
      if (error.code === '23505') return httpError(reply, 409, 'PHONE_NUMBER_ID_JA_CADASTRADO');
      return dbFail(reply, error, 'update account');
    }
  });

  api.delete('/accounts/:id', async (req, reply) => {
    const acc = await getAccount(req.params.id);
    if (!acc) return httpError(reply, 404, 'CONTA_NAO_ENCONTRADA');
    const { error } = await sb.from('whatsapp_api_accounts').delete().eq('id', acc.id);
    if (error) return dbFail(reply, error, 'delete account');
    return { ok: true, id: acc.id };
  });

  // ---- Testar: GET {META_BASE_URL}/{phone_number_id} ----
  api.post('/accounts/:id/test', async (req, reply) => {
    const acc = await getAccount(req.params.id);
    if (!acc) return httpError(reply, 404, 'CONTA_NAO_ENCONTRADA');
    try {
      const info = await metaFetch(acc, acc.phone_number_id, { query: { fields: 'id,verified_name,display_phone_number,quality_rating,code_verification_status,name_status' } });
      await updateAccount(acc.id, {
        verified_name: info.verified_name || null,
        display_phone: info.display_phone_number || acc.display_phone,
        quality_rating: info.quality_rating || null,
        last_test_at: nowIso(), last_test_ok: true,
      });
      return { ok: true, ...info };
    } catch (e) {
      await updateAccount(acc.id, { last_test_at: nowIso(), last_test_ok: false }).catch(() => {});
      return reply.code(502).send({ ok: false, ...metaErrorPayload(e) });
    }
  });

  // ---- Registrar: POST {pnid}/register com PIN (anti-bug #10) ----
  api.post('/accounts/:id/register', async (req, reply) => {
    const acc = await getAccount(req.params.id);
    if (!acc) return httpError(reply, 404, 'CONTA_NAO_ENCONTRADA');
    const pin = onlyDigits(req.body?.pin);
    if (pin.length !== 6) return httpError(reply, 400, 'PIN_INVALIDO', { detail: 'PIN deve ter 6 digitos' });
    return withMeta(reply, async () => {
      const result = await metaFetch(acc, `${acc.phone_number_id}/register`, { method: 'POST', body: { messaging_product: 'whatsapp', pin } });
      await updateAccount(acc.id, { registered: true });
      return { ok: true, result };
    });
  });

  // ---- Inscrever app: POST {waba}/subscribed_apps (anti-bug #11) ----
  api.post('/accounts/:id/subscribe', async (req, reply) => {
    const acc = await getAccount(req.params.id);
    if (!acc) return httpError(reply, 404, 'CONTA_NAO_ENCONTRADA');
    if (!acc.waba_id) return httpError(reply, 400, 'WABA_ID_OBRIGATORIO');
    return withMeta(reply, async () => {
      const result = await metaFetch(acc, `${acc.waba_id}/subscribed_apps`, { method: 'POST', body: {} });
      const list = await metaFetch(acc, `${acc.waba_id}/subscribed_apps`);
      const apps = list?.data || [];
      await updateAccount(acc.id, { subscribed: apps.length > 0 });
      return { ok: true, result, apps };
    });
  });
  api.get('/accounts/:id/subscribed-apps', async (req, reply) => {
    const acc = await getAccount(req.params.id);
    if (!acc) return httpError(reply, 404, 'CONTA_NAO_ENCONTRADA');
    if (!acc.waba_id) return httpError(reply, 400, 'WABA_ID_OBRIGATORIO');
    return withMeta(reply, async () => ({ apps: (await metaFetch(acc, `${acc.waba_id}/subscribed_apps`))?.data || [] }));
  });

  // >>> [api-oficial] proximas rotas (inbox, templates, disparo, fluxos) entram aqui
}, { prefix: '/api-oficial' });

// ---------------------------------------------------------------- [6] webhook
const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'];
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf', 'text/plain': 'txt' };
const extFromMime = (mime) => MIME_EXT[String(mime || '').split(';')[0].trim()] || 'bin';
const publicMediaUrl = (p) => `${SUPABASE_PUBLIC_URL}/storage/v1/object/public/wa-media/${p.split('/').map(encodeURIComponent).join('/')}`;
const STATUS_RANK = { received: 0, queued: 0, accepted: 1, sent: 2, delivered: 3, read: 4, failed: 9 };
let waOnInbound = null; // gancho preenchido pelos fluxos (T9): (account, contact, conversation, message) => Promise

// Anti-bug #3: assinatura sobre o corpo CRU, comparacao em tempo constante.
function verifySignature(rawBody, header, appSecret) {
  if (!header || !appSecret) return false;
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const got = Buffer.from(String(header).trim());
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

function inboundBody(msg) {
  switch (msg.type) {
    case 'text': return msg.text?.body || '';
    case 'button': return msg.button?.text || msg.button?.payload || '';
    case 'interactive': return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    case 'reaction': return msg.reaction?.emoji || '';
    case 'location': return [msg.location?.name, msg.location?.address, `${msg.location?.latitude},${msg.location?.longitude}`].filter(Boolean).join(' - ');
    case 'contacts': return (msg.contacts || []).map((c) => c.name?.formatted_name).filter(Boolean).join(', ');
    default: return msg[msg.type]?.caption || msg[msg.type]?.filename || '';
  }
}

// Baixa a midia da Meta (GET /{media_id} -> url -> bytes) e sobe no bucket wa-media.
async function downloadMediaToStorage(account, mediaId, mimeHint, wamid) {
  const meta = await metaFetch(account, mediaId);
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${account.access_token}` } });
  if (!res.ok) throw new Error(`download da midia falhou: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = meta.mime_type || mimeHint || 'application/octet-stream';
  const safe = String(wamid || `m-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const p = `${account.id}/${safe}.${extFromMime(contentType)}`;
  const { error } = await sb.storage.from('wa-media').upload(p, buf, { contentType, upsert: true });
  if (error) throw new Error('upload no storage falhou: ' + error.message);
  return { path: p, url: publicMediaUrl(p), mime: contentType, size: buf.length };
}

async function upsertContact(account, phone, name) {
  const { data: existing, error: e0 } = await sb.from('wa_contacts').select('*').eq('account_id', account.id).eq('phone', phone).maybeSingle();
  if (e0) throw e0;
  const patch = { last_inbound_at: nowIso() };
  if (name && !existing?.name) patch.name = name;
  if (existing) {
    const { data, error } = await sb.from('wa_contacts').update(patch).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await sb.from('wa_contacts').insert({ account_id: account.id, phone, name: name || null, ...patch }).select('*').single();
  if (error) { if (error.code === '23505') return upsertContact(account, phone, name); throw error; }
  return data;
}

// Chegou mensagem: abre/reabre a conversa, incrementa nao-lidas e renova a janela de 24h (anti-bug #12).
async function touchConversationInbound(account, contact, preview) {
  const { data: existing, error: e0 } = await sb.from('wa_conversations').select('*').eq('account_id', account.id).eq('contact_id', contact.id).maybeSingle();
  if (e0) throw e0;
  const patch = {
    status: 'open', closed_at: null, closed_by: null,
    unread_count: (existing?.unread_count || 0) + 1,
    last_message_at: nowIso(), last_message_preview: String(preview || '').slice(0, 200), last_direction: 'in',
    window_expires_at: hoursFromNow(24),
  };
  if (existing) {
    const { data, error } = await sb.from('wa_conversations').update(patch).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await sb.from('wa_conversations').insert({ account_id: account.id, contact_id: contact.id, ...patch }).select('*').single();
  if (error) { if (error.code === '23505') return touchConversationInbound(account, contact, preview); throw error; }
  return data;
}

async function processInboundMessage(account, value, msg) {
  if (msg.id) {
    const { data: dup } = await sb.from('wa_messages').select('id').eq('wamid', msg.id).maybeSingle();
    if (dup) return { skipped: 'duplicado', id: dup.id };
  }
  const from = onlyDigits(msg.from);
  if (!from) return { skipped: 'sem remetente' };
  const profileName = (value.contacts || []).find((c) => onlyDigits(c.wa_id) === from)?.profile?.name;
  const contact = await upsertContact(account, from, profileName);
  const type = msg.type || 'unsupported';
  const row = { account_id: account.id, contact_id: contact.id, direction: 'in', type, body: inboundBody(msg), wamid: msg.id || null, status: 'received', payload: msg };
  if (MEDIA_TYPES.includes(type) && msg[type]?.id) {
    row.media_mime = msg[type].mime_type || null;
    row.media_filename = msg[type].filename || null;
    try {
      const m = await downloadMediaToStorage(account, msg[type].id, msg[type].mime_type, msg.id);
      row.media_url = m.url; row.media_path = m.path; row.media_mime = m.mime;
    } catch (e) {
      app.log.warn({ err: e, media: msg[type].id }, 'falha ao baixar midia');
      row.error = { media: String(e.message) };
    }
  }
  const preview = row.body || `[${type}]`;
  const conv = await touchConversationInbound(account, contact, preview);
  row.conversation_id = conv.id;
  const { data: saved, error } = await sb.from('wa_messages').insert(row).select('*').single();
  if (error) { if (error.code === '23505') return { skipped: 'duplicado' }; throw error; }
  if (waOnInbound) waOnInbound(account, contact, conv, saved).catch((e) => app.log.error({ err: e }, 'erro no fluxo'));
  return { message_id: saved.id, conversation_id: conv.id };
}

async function processStatus(account, st) {
  const wamid = st.id; const status = st.status;
  if (!wamid || !status) return;
  const { data: cur } = await sb.from('wa_messages').select('id, status').eq('wamid', wamid).maybeSingle();
  if (cur && (STATUS_RANK[status] ?? 0) < (STATUS_RANK[cur.status] ?? 0) && cur.status !== 'failed') return; // nao rebaixa read -> delivered
  const patch = { status };
  if (status === 'failed' && st.errors) patch.error = st.errors;
  if (cur) await sb.from('wa_messages').update(patch).eq('id', cur.id);
  const sendPatch = { delivery_status: status };
  if (status === 'failed') {
    sendPatch.status = 'failed';
    sendPatch.error_code = st.errors?.[0]?.code ?? null;
    sendPatch.error_message = st.errors?.[0]?.title || st.errors?.[0]?.message || null;
    sendPatch.error = st.errors || null;
  }
  await sb.from('whatsapp_api_sends').update(sendPatch).eq('wamid', wamid);
}

async function logWebhookEvent(accountId, pnid, eventType, valid, payload) {
  const { error } = await sb.from('wa_webhook_events').insert({ account_id: accountId, phone_number_id: pnid, event_type: eventType, signature_valid: valid, payload });
  if (error) app.log.error({ err: error }, 'falha ao gravar wa_webhook_events');
}

// Verificacao do webhook (Meta manda hub.mode/hub.verify_token/hub.challenge)
app.get('/whatsapp/webhook', async (req, reply) => {
  const mode = req.query['hub.mode']; const token = req.query['hub.verify_token']; const challenge = req.query['hub.challenge'];
  if (mode !== 'subscribe' || !token) return reply.code(403).type('text/plain').send('forbidden');
  const { data } = await sb.from('whatsapp_api_accounts').select('id').eq('verify_token', String(token)).limit(1);
  if (!data?.length) return reply.code(403).type('text/plain').send('forbidden');
  return reply.type('text/plain').send(String(challenge ?? ''));
});

// Eventos da Meta (mensagens e status). Acha a conta pelo phone_number_id e valida a assinatura.
app.post('/whatsapp/webhook', async (req, reply) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const raw = req.rawBody || Buffer.alloc(0);
  const changes = (body.entry || []).flatMap((e) => e.changes || []);
  const pnid = changes.map((c) => c.value?.metadata?.phone_number_id).find(Boolean) || null;
  const eventType = changes.some((c) => c.value?.messages?.length) ? 'messages' : changes.some((c) => c.value?.statuses?.length) ? 'statuses' : 'unknown';
  const account = pnid ? await getAccountByPnid(pnid) : null;
  if (!account) {
    await logWebhookEvent(null, pnid, eventType, null, body);
    return httpError(reply, 404, 'CONTA_NAO_ENCONTRADA', { phone_number_id: pnid });
  }
  const valid = verifySignature(raw, req.headers['x-hub-signature-256'], account.app_secret);
  await logWebhookEvent(account.id, pnid, eventType, valid, body);
  if (!valid) return httpError(reply, 401, 'ASSINATURA_INVALIDA');

  let messages = 0, statuses = 0; const errors = [];
  for (const ch of changes) {
    const v = ch.value || {};
    const chPnid = v.metadata?.phone_number_id;
    const acc = (!chPnid || chPnid === pnid) ? account : ((await getAccountByPnid(chPnid)) || account);
    for (const m of v.messages || []) {
      try { await processInboundMessage(acc, v, m); messages++; }
      catch (e) { errors.push(String(e.message)); app.log.error({ err: e, wamid: m.id }, 'erro processando inbound'); }
    }
    for (const st of v.statuses || []) {
      try { await processStatus(acc, st); statuses++; }
      catch (e) { errors.push(String(e.message)); app.log.error({ err: e, wamid: st.id }, 'erro processando status'); }
    }
  }
  return { ok: true, messages, statuses, errors };
});

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
