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
let waOnInbound = null; // gancho dos fluxos (secao [10]): (account, contact, conversation, message) => Promise
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

// ------------------------------------------------------------ [7a] envio (compartilhado)
const windowOpen = (conv) => !!conv?.window_expires_at && new Date(conv.window_expires_at).getTime() > Date.now();
function templatePayload(to, tpl) {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
    template: { name: tpl.name, language: { code: tpl.language || 'pt_BR' }, ...(Array.isArray(tpl.components) && tpl.components.length ? { components: tpl.components } : {}) },
  };
}
function textPayload(to, text) {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: text } };
}
// Envia pela Meta e grava em wa_messages (sucesso ou falha). Retorna { ok, wamid, message, error }.
async function waSendAndRecord({ account, conversation, contact, kind = 'text', text, template, sentBy = null, isFlow = false, flowId = null }) {
  const to = onlyDigits(contact.phone);
  let payload, type, body, templateName = null;
  if (kind === 'template') {
    type = 'template'; templateName = template.name;
    payload = templatePayload(to, template);
    body = template.preview || `[template: ${template.name}]`;
  } else {
    type = 'text'; body = String(text || '');
    payload = textPayload(to, body);
  }
  const row = {
    conversation_id: conversation.id, account_id: account.id, contact_id: contact.id, direction: 'out', type, body,
    template_name: templateName, sent_by: sentBy?.id || null, sent_by_email: sentBy?.email || null,
    is_flow: !!isFlow, flow_id: flowId, payload, status: 'accepted',
  };
  try {
    const res = await metaFetch(account, `${account.phone_number_id}/messages`, { method: 'POST', body: payload });
    row.wamid = res?.messages?.[0]?.id || null;
    const { data: saved, error } = await sb.from('wa_messages').insert(row).select('*').single();
    if (error) throw error;
    await sb.from('wa_conversations').update({ last_message_at: nowIso(), last_message_preview: body.slice(0, 200), last_direction: 'out' }).eq('id', conversation.id);
    await sb.from('wa_contacts').update({ last_outbound_at: nowIso() }).eq('id', contact.id);
    return { ok: true, wamid: row.wamid, message: saved };
  } catch (e) {
    if (e instanceof MetaError) {
      row.status = 'failed'; row.error = { code: e.code, message: e.message, meta: e.meta };
      const { data: saved } = await sb.from('wa_messages').insert(row).select('*').single();
      return { ok: false, error: e, message: saved };
    }
    throw e;
  }
}
// Garante conversa pro contato SEM mexer na janela (usado em envios ativos/disparo).
async function ensureConversation(account, contact) {
  const { data: existing } = await sb.from('wa_conversations').select('*').eq('account_id', account.id).eq('contact_id', contact.id).maybeSingle();
  if (existing) return existing;
  const { data, error } = await sb.from('wa_conversations').insert({ account_id: account.id, contact_id: contact.id, status: 'open', unread_count: 0 }).select('*').single();
  if (error) { if (error.code === '23505') return ensureConversation(account, contact); throw error; }
  return data;
}
async function getConversation(id) {
  if (!isUuid(id)) return null;
  const { data, error } = await sb.from('wa_conversations').select('*, contact:wa_contacts(*)').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// ------------------------------------------------------------ [9a] disparo: utilitarios
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Erros da Meta traduzidos pro PT (motivo + o que fazer). Fonte: codigos da Cloud API.
const WA_ERROR_HELP = {
  0: { motivo: 'Falha de autenticacao (token invalido ou sem permissao).', fix: 'Gere um novo token de sistema com as permissoes whatsapp_business_messaging e whatsapp_business_management e atualize a conta.' },
  1: { motivo: 'Erro interno da Meta.', fix: 'Tente de novo em alguns minutos. Se persistir, verifique o status da plataforma.' },
  2: { motivo: 'Servico da Meta temporariamente indisponivel.', fix: 'Aguarde e reenvie. Reduza a velocidade do disparo.' },
  3: { motivo: 'Sem permissao pra essa operacao.', fix: 'Confira as permissoes do token e se o app tem acesso a WABA.' },
  4: { motivo: 'Limite de chamadas do app atingido.', fix: 'Reduza a velocidade do disparo e tente mais tarde.' },
  10: { motivo: 'Permissao negada pra essa acao.', fix: 'O app precisa da permissao correspondente e a conta precisa estar verificada.' },
  33: { motivo: 'Objeto nao existe ou sem permissao (phone_number_id/waba_id errados?).', fix: 'Confira o Phone Number ID e o WABA ID cadastrados na conta.' },
  100: { motivo: 'Parametro invalido na requisicao.', fix: 'Confira o numero de destino, o nome/idioma do template e as variaveis.' },
  190: { motivo: 'Token de acesso expirado ou invalido.', fix: 'Gere um token de sistema com expiracao "Nunca" e atualize na tela de Contas.' },
  200: { motivo: 'Permissao insuficiente pra enviar mensagens.', fix: 'Adicione whatsapp_business_messaging ao token.' },
  368: { motivo: 'Conta temporariamente bloqueada por violacao de politicas.', fix: 'Verifique as notificacoes no Gerenciador de Negocios e recorra se necessario.' },
  80007: { motivo: 'Limite de taxa da WABA atingido.', fix: 'Reduza a velocidade do disparo e aguarde.' },
  130429: { motivo: 'Limite de envio por segundo atingido (rate limit).', fix: 'Diminua a velocidade do disparo (mensagens por segundo) e reenvie os que falharam.' },
  130472: { motivo: 'Numero do destinatario esta em um experimento da Meta (nao recebe marketing).', fix: 'Nada a fazer; tente mais tarde ou com template utilitario.' },
  131000: { motivo: 'Erro desconhecido ao enviar.', fix: 'Tente reenviar. Se persistir, verifique o status da plataforma.' },
  131005: { motivo: 'Acesso negado (permissao de mensagens).', fix: 'Confira as permissoes do token e a verificacao do negocio.' },
  131008: { motivo: 'Faltou um parametro obrigatorio.', fix: 'Confira o payload: destinatario, tipo e conteudo.' },
  131009: { motivo: 'Valor de parametro invalido.', fix: 'Confira o formato do telefone (DDI+DDD+numero, so digitos) e as variaveis.' },
  131016: { motivo: 'Servico indisponivel.', fix: 'Aguarde e tente de novo.' },
  131021: { motivo: 'Remetente e destinatario sao o mesmo numero.', fix: 'Remova o proprio numero da lista.' },
  131026: { motivo: 'Mensagem nao entregue: numero sem WhatsApp, bloqueou voce ou nao aceitou os termos novos.', fix: 'Confirme que o numero tem WhatsApp ativo. Nao insista em numeros que bloquearam.' },
  131030: { motivo: 'Destinatario nao esta na lista de numeros permitidos (modo de teste).', fix: 'Adicione o numero na lista de teste ou saia do modo de teste (verificacao do negocio + politica de privacidade).' },
  131031: { motivo: 'Conta bloqueada por violacao de politica ou falta de pagamento.', fix: 'Verifique o Gerenciador de Negocios (pagamento/politicas).' },
  131037: { motivo: 'Nome de exibicao do numero pendente de aprovacao.', fix: 'Aguarde a aprovacao do nome no painel da Meta.' },
  131042: { motivo: 'Problema de pagamento na conta.', fix: 'Cadastre/atualize o metodo de pagamento no Gerenciador de Negocios.' },
  131045: { motivo: 'Numero nao registrado ou certificado invalido.', fix: 'Clique em Registrar (PIN) na tela de Contas.' },
  131047: { motivo: 'Fora da janela de 24h: o cliente nao respondeu nas ultimas 24h e a mensagem nao era template.', fix: 'Envie um template aprovado (marketing/utilidade). Texto livre so dentro da janela de 24h.' },
  131048: { motivo: 'Envio bloqueado: limite de spam atingido (qualidade baixa).', fix: 'Pare o disparo, melhore a qualidade (menos reclamacoes/bloqueios) e aguarde.' },
  131049: { motivo: 'A Meta nao entregou pra manter a saude do ecossistema (o destinatario recebe muito marketing).', fix: 'Nada a fazer agora; tente de novo depois. Prefira templates utilitarios.' },
  131050: { motivo: 'O usuario parou de receber mensagens de marketing deste numero.', fix: 'Marque o contato como opt-out. Nao envie mais marketing pra ele.' },
  131051: { motivo: 'Tipo de mensagem nao suportado.', fix: 'Use texto, template, imagem, documento, audio ou video suportados.' },
  131052: { motivo: 'Falha ao baixar a midia do destinatario.', fix: 'Peca pro cliente reenviar o arquivo.' },
  131053: { motivo: 'Falha ao enviar a midia (formato/tamanho).', fix: 'Confira o tipo e tamanho do arquivo (imagem ate 5 MB, documento ate 100 MB).' },
  131056: { motivo: 'Muitas mensagens pro mesmo destinatario em pouco tempo.', fix: 'Espere alguns minutos antes de enviar de novo pra esse numero.' },
  131057: { motivo: 'Conta em modo de manutencao.', fix: 'Aguarde a conclusao da manutencao.' },
  132000: { motivo: 'Numero de variaveis nao bate com o template (faltou ou sobrou parametro).', fix: 'Confira quantas variaveis {{n}} o template tem e envie exatamente essa quantidade de colunas no CSV.' },
  132001: { motivo: 'Template nao existe (nome/idioma errados) ou nao esta aprovado.', fix: 'Sincronize os templates e escolha um template APROVADO no idioma certo.' },
  132005: { motivo: 'Texto traduzido do template muito longo.', fix: 'Reduza o texto das variaveis.' },
  132007: { motivo: 'Conteudo do template viola politicas.', fix: 'Revise o texto do template e crie uma nova versao.' },
  132012: { motivo: 'Formato de parametro invalido pro template.', fix: 'Variaveis nao podem ter quebras de linha, tabs ou mais de 4 espacos seguidos.' },
  132015: { motivo: 'Template pausado por baixa qualidade.', fix: 'Use outro template ou aguarde a reativacao.' },
  132016: { motivo: 'Template desativado por baixa qualidade.', fix: 'Crie um novo template com conteudo diferente.' },
  132068: { motivo: 'Fluxo (Flow) bloqueado.', fix: 'Revise o Flow no painel da Meta.' },
  133000: { motivo: 'Falha ao apagar o registro do numero.', fix: 'Tente de novo mais tarde.' },
  133004: { motivo: 'Servidor temporariamente indisponivel.', fix: 'Aguarde e tente de novo.' },
  133005: { motivo: 'PIN de verificacao em duas etapas incorreto.', fix: 'Confira o PIN de 6 digitos do numero e registre de novo.' },
  133006: { motivo: 'Numero precisa ser verificado de novo.', fix: 'Refaca a verificacao do numero no painel da Meta.' },
  133008: { motivo: 'Muitas tentativas de PIN.', fix: 'Aguarde antes de tentar registrar de novo.' },
  133009: { motivo: 'Tentou o PIN rapido demais.', fix: 'Aguarde alguns minutos.' },
  133010: { motivo: 'Numero nao registrado na Cloud API.', fix: 'Na tela de Contas, clique em Registrar e informe o PIN de 6 digitos.' },
  133015: { motivo: 'Numero registrado recentemente; aguarde.', fix: 'Tente de novo em alguns minutos.' },
  135000: { motivo: 'Erro generico de usuario.', fix: 'Confira o payload; se persistir, contate o suporte da Meta.' },
};
function errorHelp(code) {
  if (code === null || code === undefined) return null;
  const h = WA_ERROR_HELP[Number(code)];
  return h ? { code: Number(code), ...h } : { code: Number(code), motivo: 'Erro nao catalogado.', fix: 'Consulte a documentacao de erros da Cloud API pelo codigo.' };
}

// CSV: respeita aspas (virgula dentro), aspas escapadas (""), CRLF, BOM, separador , ou ;  (anti-bug #6)
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch === '\r') { /* ignora */ }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}
// Telefone: so digitos; < 10 digitos descarta; 10-11 digitos (BR sem DDI) ganha 55.
function normalizePhone(raw) {
  const d = onlyDigits(raw);
  if (d.length < 10 || d.length > 15) return null;
  if (d.length === 10 || d.length === 11) return '55' + d;
  return d;
}
function csvToContacts(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) return [];
  if (rows[0] && /[a-zA-Z]/.test(String(rows[0][0] || ''))) rows.shift(); // 1a linha com letras = cabecalho
  return rows.map((r) => ({ phone: r[0], name: r[1] || '', vars: r.slice(1) }));
}
function normalizeContacts(list) {
  const seen = new Set(); const contacts = []; let invalid = 0, duplicates = 0;
  for (const c of list) {
    const phone = normalizePhone(c.phone);
    if (!phone) { invalid++; continue; }
    if (seen.has(phone)) { duplicates++; continue; }
    seen.add(phone);
    const vars = Array.isArray(c.vars) ? c.vars.map((v) => String(v ?? '')) : (c.name ? [String(c.name)] : []);
    contacts.push({ phone, name: String(c.name || '').trim(), vars });
  }
  return { contacts, invalid, duplicates };
}
// Monta os components do template a partir das variaveis da linha ({{1}} = var 1, ...)
function buildTemplateComponents(cachedComponents, vars) {
  if (!Array.isArray(cachedComponents)) return [];
  const out = [];
  const count = (t) => (String(t || '').match(/\{\{\d+\}\}/g) || []).length;
  const header = cachedComponents.find((c) => c.type === 'HEADER');
  if (header && header.format === 'TEXT' && count(header.text) > 0) {
    out.push({ type: 'header', parameters: [{ type: 'text', text: String(vars[0] ?? '') }] });
  }
  const body = cachedComponents.find((c) => c.type === 'BODY');
  const n = body ? count(body.text) : 0;
  if (n > 0) out.push({ type: 'body', parameters: Array.from({ length: n }, (_, i) => ({ type: 'text', text: String(vars[i] ?? '') })) });
  return out;
}

// ------------------------------------------------------------ [9b] disparo: jobs em memoria (anti-bug #5)
const broadcastJobs = new Map();
function jobPublic(j) {
  const processed = j.sent + j.failed + j.skipped;
  return {
    job_id: j.id, account_id: j.account_id, account_label: j.account.label, list_name: j.list_name, template: j.template,
    total: j.total, sent: j.sent, failed: j.failed, skipped: j.skipped, processed,
    percent: j.total ? Math.round((processed / j.total) * 100) : 100,
    done: j.done, cancelled: j.cancelled, started_at: j.started_at, finished_at: j.finished_at,
    created_by: j.created_by, rate_per_sec: j.rate, errors: j.errors.slice(-50), error: j.error || null,
  };
}
async function upsertBroadcastContact(account, c, listName) {
  const { data: existing } = await sb.from('wa_contacts').select('*').eq('account_id', account.id).eq('phone', c.phone).maybeSingle();
  if (existing) {
    const patch = {};
    if (c.name && !existing.name) patch.name = c.name;
    if (listName && !(existing.tags || []).includes(listName)) patch.tags = [...(existing.tags || []), listName];
    if (!Object.keys(patch).length) return existing;
    const { data } = await sb.from('wa_contacts').update(patch).eq('id', existing.id).select('*').single();
    return data || existing;
  }
  const { data, error } = await sb.from('wa_contacts').insert({ account_id: account.id, phone: c.phone, name: c.name || null, tags: listName ? [listName] : [] }).select('*').single();
  if (error) { if (error.code === '23505') return upsertBroadcastContact(account, c, listName); throw error; }
  return data;
}
async function recordSend(job, c, extra) {
  const { error } = await sb.from('whatsapp_api_sends').insert({
    account_id: job.account_id, job_id: job.id, list_name: job.list_name, phone: c.phone, name: c.name || null,
    template_name: job.template.name, template_language: job.template.language, variables: c.vars,
    sent_by: job.created_by_user?.id || null, sent_by_email: job.created_by || null, ...extra,
  });
  if (error) app.log.error({ err: error }, 'falha ao gravar whatsapp_api_sends');
}
async function runBroadcast(job) {
  const account = job.account;
  const delay = Math.max(20, Math.round(1000 / job.rate));
  for (const c of job.contacts) {
    if (job.cancelled) break;
    const t0 = Date.now();
    try {
      const contact = await upsertBroadcastContact(account, c, job.list_name);
      if (contact.opt_out) { // anti-bug #7
        job.skipped++;
        await recordSend(job, c, { status: 'skipped', skip_reason: 'opt_out' });
        continue;
      }
      const conv = await ensureConversation(account, contact);
      const components = buildTemplateComponents(job.tplComponents, c.vars);
      const r = await waSendAndRecord({
        account, conversation: conv, contact, kind: 'template', sentBy: job.created_by_user,
        template: { name: job.template.name, language: job.template.language, components, preview: `[disparo ${job.list_name}: ${job.template.name}]` },
      });
      if (r.ok) { job.sent++; await recordSend(job, c, { status: 'sent', wamid: r.wamid, delivery_status: 'accepted' }); }
      else {
        job.failed++;
        job.errors.push({ phone: c.phone, code: r.error.code, message: r.error.message });
        await recordSend(job, c, { status: 'failed', error_code: r.error.code, error_message: r.error.message, error: r.error.meta || null });
      }
    } catch (e) {
      job.failed++;
      job.errors.push({ phone: c.phone, code: null, message: String(e.message) });
      await recordSend(job, c, { status: 'failed', error_message: String(e.message) }).catch(() => {});
    }
    const wait = delay - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
  job.done = true; job.finished_at = nowIso();
  app.log.info({ job: job.id, sent: job.sent, failed: job.failed, skipped: job.skipped }, 'disparo concluido');
}

// ---------------------------------------------------------------- [10] fluxos (motor)
const normText = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const FLOW_ACTIONS = ['add_tag', 'remove_tag', 'opt_out', 'opt_in', 'close'];
const NON_REPLY_BUTTONS = ['URL', 'PHONE_NUMBER', 'COPY_CODE', 'FLOW', 'CATALOG', 'MPM', 'OTP', 'VOICE_CALL'];
const MAX_FLOW_DELAY_S = 7 * 24 * 3600;

function validateFlow(b, { partial = false } = {}) {
  const out = {};
  if (b.name !== undefined || !partial) { const name = String(b.name || '').trim(); if (!name) return { error: 'NOME_OBRIGATORIO' }; out.name = name; }
  if (b.trigger_text !== undefined || !partial) { const t = String(b.trigger_text || '').trim(); if (!t) return { error: 'GATILHO_OBRIGATORIO' }; out.trigger_text = t; }
  if (b.account_id !== undefined) { if (b.account_id !== null && !isUuid(b.account_id)) return { error: 'ACCOUNT_ID_INVALIDO' }; out.account_id = b.account_id; }
  if (b.active !== undefined) out.active = !!b.active;
  if (b.match_text !== undefined) out.match_text = !!b.match_text;
  if (b.steps !== undefined || !partial) {
    if (!Array.isArray(b.steps)) return { error: 'STEPS_INVALIDOS' };
    const steps = [];
    for (const [i, st] of b.steps.entries()) {
      if (!st || typeof st !== 'object') return { error: 'STEPS_INVALIDOS', detail: `passo ${i + 1}` };
      const step = {};
      const delay = Number(st.delay_s || 0);
      if (!Number.isFinite(delay) || delay < 0 || delay > MAX_FLOW_DELAY_S) return { error: 'DELAY_INVALIDO', detail: `passo ${i + 1}` };
      step.delay_s = delay;
      if (st.text && String(st.text).trim()) step.text = String(st.text).trim();
      if (st.template?.name) step.template = { name: String(st.template.name).trim(), language: String(st.template.language || 'pt_BR').trim() };
      const actions = Array.isArray(st.actions) ? st.actions : [];
      step.actions = [];
      for (const a of actions) {
        const type = String(a?.type || '').trim();
        if (!FLOW_ACTIONS.includes(type)) return { error: 'ACAO_INVALIDA', detail: `passo ${i + 1}: ${type || '?'}`, permitidas: FLOW_ACTIONS };
        if ((type === 'add_tag' || type === 'remove_tag') && !String(a.tag || '').trim()) return { error: 'ACAO_SEM_TAG', detail: `passo ${i + 1}` };
        step.actions.push(type.endsWith('_tag') ? { type, tag: String(a.tag).trim() } : { type });
      }
      if (!step.text && !step.template && !step.actions.length) return { error: 'PASSO_VAZIO', detail: `passo ${i + 1}: informe texto, template ou acao` };
      steps.push(step);
    }
    out.steps = steps;
  }
  return { value: out };
}
const renderFlowText = (text, contact) => String(text || '')
  .replace(/\{\{\s*(nome|name)\s*\}\}/gi, contact?.name || '')
  .replace(/\{\{\s*(telefone|phone)\s*\}\}/gi, contact?.phone || '');

async function waApplyActions(actions, contact, conversation) {
  if (!actions?.length) return;
  const patch = {}; let tags = [...(contact.tags || [])]; let tagsChanged = false;
  for (const a of actions) {
    if (a.type === 'add_tag' && !tags.includes(a.tag)) { tags.push(a.tag); tagsChanged = true; }
    if (a.type === 'remove_tag' && tags.includes(a.tag)) { tags = tags.filter((t) => t !== a.tag); tagsChanged = true; }
    if (a.type === 'opt_out') patch.opt_out = true;
    if (a.type === 'opt_in') patch.opt_out = false;
    if (a.type === 'close') await sb.from('wa_conversations').update({ status: 'closed', closed_at: nowIso() }).eq('id', conversation.id);
  }
  if (tagsChanged) patch.tags = tags;
  if (Object.keys(patch).length) await sb.from('wa_contacts').update(patch).eq('id', contact.id);
}
async function waSendFlowStep(flow, step, ctx) {
  const conv = await getConversation(ctx.conversation.id);
  if (!conv) return;
  const contact = conv.contact; const account = ctx.account;
  if (step.template?.name) {
    await waSendAndRecord({ account, conversation: conv, contact, kind: 'template', template: step.template, isFlow: true, flowId: flow.id });
  } else if (step.text) {
    const text = renderFlowText(step.text, contact);
    if (!windowOpen(conv)) { // anti-bug #12: fluxo tambem respeita a janela
      await sb.from('wa_messages').insert({ conversation_id: conv.id, account_id: account.id, contact_id: contact.id, direction: 'out', type: 'text', body: text, status: 'failed', is_flow: true, flow_id: flow.id, error: { code: 'JANELA_FECHADA', message: 'Fluxo: fora da janela de 24h. Use um passo de template.' } });
    } else {
      await waSendAndRecord({ account, conversation: conv, contact, kind: 'text', text, isFlow: true, flowId: flow.id });
    }
  }
  await waApplyActions(step.actions, contact, conv);
}
async function waRunFlow(flow, ctx) {
  for (const step of flow.steps || []) {
    const d = Number(step.delay_s) || 0;
    if (d > 0) await sleep(d * 1000);
    try { await waSendFlowStep(flow, step, ctx); }
    catch (e) { app.log.error({ err: e, flow: flow.id }, 'erro no passo do fluxo'); }
  }
}
async function waFindFlows(account, text) {
  const t = normText(text);
  if (!t) return [];
  const { data, error } = await sb.from('wa_flows').select('*').eq('active', true).or(`account_id.eq.${account.id},account_id.is.null`).order('created_at');
  if (error) throw error;
  return (data || []).filter((f) => normText(f.trigger_text) === t).sort((a, b) => (a.account_id ? 0 : 1) - (b.account_id ? 0 : 1));
}
// Botao de URL/ligar/copiar (nao e resposta rapida) nao dispara fluxo
async function isNonReplyButton(account, message) {
  const ctxId = message.payload?.context?.id;
  if (!ctxId) return false;
  const { data: tplMsg } = await sb.from('wa_messages').select('template_name').eq('wamid', ctxId).maybeSingle();
  if (!tplMsg?.template_name) return false;
  const { data: tpls } = await sb.from('wa_templates').select('components').eq('account_id', account.id).eq('name', tplMsg.template_name);
  const text = normText(message.body);
  for (const t of tpls || []) for (const c of t.components || []) if (c.type === 'BUTTONS') {
    for (const b of c.buttons || []) if (normText(b.text) === text && NON_REPLY_BUTTONS.includes(String(b.type || '').toUpperCase())) return true;
  }
  return false;
}
waOnInbound = async (account, contact, conversation, message) => {
  const isButton = message.type === 'button' || (message.type === 'interactive' && !!message.payload?.interactive?.button_reply);
  const isText = message.type === 'text';
  if (!isButton && !isText) return;
  const candidates = [...new Set([message.body, message.payload?.button?.payload, message.payload?.interactive?.button_reply?.id].filter(Boolean))];
  let flows = [];
  for (const c of candidates) { flows = await waFindFlows(account, c); if (flows.length) break; }
  if (isText) flows = flows.filter((f) => f.match_text);
  if (!flows.length) return;
  if (isButton && await isNonReplyButton(account, message)) return;
  for (const flow of flows) {
    app.log.info({ flow: flow.id, name: flow.name, contact: contact.id }, 'fluxo disparado');
    await waRunFlow(flow, { account, contact, conversation, message });
  }
};

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

  // ---- [7] inbox ----
  const CONV_SELECT = '*, contact:wa_contacts(id,phone,name,tags,opt_out,custom,last_inbound_at), account:whatsapp_api_accounts(id,label,phone_number_id,display_phone)';
  const withWindow = (c) => ({ ...c, window_open: windowOpen(c) });

  api.get('/conversations', async (req, reply) => {
    const { status = 'open', assigned = 'all', account_id, search, limit } = req.query;
    let q = sb.from('wa_conversations').select(CONV_SELECT)
      .order('last_message_at', { ascending: false, nullsFirst: false }).limit(Math.min(Number(limit) || 200, 500));
    if (status && status !== 'all') q = q.eq('status', status);
    if (account_id && isUuid(account_id)) q = q.eq('account_id', account_id);
    if (assigned === 'me') q = q.eq('assigned_to', req.user.id);
    else if (assigned === 'unassigned') q = q.is('assigned_to', null);
    const { data, error } = await q;
    if (error) return dbFail(reply, error, 'list conversations');
    let rows = data;
    if (search) {
      const sq = String(search).toLowerCase();
      rows = rows.filter((c) => (c.contact?.phone || '').includes(sq) || (c.contact?.name || '').toLowerCase().includes(sq));
    }
    return rows.map(withWindow);
  });

  api.get('/conversations/:id', async (req, reply) => {
    const conv = await getConversation(req.params.id);
    if (!conv) return httpError(reply, 404, 'CONVERSA_NAO_ENCONTRADA');
    return withWindow(conv);
  });

  api.get('/conversations/:id/messages', async (req, reply) => {
    if (!isUuid(req.params.id)) return httpError(reply, 404, 'CONVERSA_NAO_ENCONTRADA');
    const { data, error } = await sb.from('wa_messages').select('*').eq('conversation_id', req.params.id).order('created_at', { ascending: true }).limit(Math.min(Number(req.query.limit) || 500, 2000));
    if (error) return dbFail(reply, error, 'list messages');
    return data;
  });

  api.get('/conversations/:id/notes', async (req, reply) => {
    if (!isUuid(req.params.id)) return httpError(reply, 404, 'CONVERSA_NAO_ENCONTRADA');
    const { data, error } = await sb.from('wa_internal_notes').select('*').eq('conversation_id', req.params.id).order('created_at', { ascending: true });
    if (error) return dbFail(reply, error, 'list notes');
    return data;
  });

  api.post('/conversations/:id/notes', async (req, reply) => {
    const conv = await getConversation(req.params.id);
    if (!conv) return httpError(reply, 404, 'CONVERSA_NAO_ENCONTRADA');
    const body = String(req.body?.body || '').trim();
    if (!body) return httpError(reply, 400, 'NOTA_VAZIA');
    const { data, error } = await sb.from('wa_internal_notes').insert({ conversation_id: conv.id, author_id: req.user.id, author_email: req.user.email, body }).select('*').single();
    if (error) return dbFail(reply, error, 'create note');
    return reply.code(201).send(data);
  });

  async function patchConversation(req, reply, patch) {
    const conv = await getConversation(req.params.id);
    if (!conv) return httpError(reply, 404, 'CONVERSA_NAO_ENCONTRADA');
    const { data, error } = await sb.from('wa_conversations').update(typeof patch === 'function' ? patch(conv) : patch).eq('id', conv.id).select(CONV_SELECT).single();
    if (error) return dbFail(reply, error, 'update conversation');
    return withWindow(data);
  }
  api.post('/conversations/:id/assign', async (req, reply) => {
    const uid = req.body?.user_id || req.user.id; const email = req.body?.email || (uid === req.user.id ? req.user.email : null);
    return patchConversation(req, reply, { assigned_to: uid, assigned_email: email, assigned_at: nowIso() });
  });
  api.post('/conversations/:id/release', async (req, reply) => patchConversation(req, reply, { assigned_to: null, assigned_email: null, assigned_at: null }));
  api.post('/conversations/:id/read', async (req, reply) => patchConversation(req, reply, { unread_count: 0 }));
  api.post('/conversations/:id/status', async (req, reply) => {
    const status = req.body?.status;
    if (!['open', 'closed'].includes(status)) return httpError(reply, 400, 'STATUS_INVALIDO', { permitidos: ['open', 'closed'] });
    return patchConversation(req, reply, status === 'closed' ? { status, closed_at: nowIso(), closed_by: req.user.id } : { status, closed_at: null, closed_by: null });
  });

  // Enviar: texto livre so DENTRO da janela de 24h (anti-bug #12); template sempre.
  api.post('/conversations/:id/send', async (req, reply) => {
    const conv = await getConversation(req.params.id);
    if (!conv) return httpError(reply, 404, 'CONVERSA_NAO_ENCONTRADA');
    const account = await getAccount(conv.account_id);
    if (!account) return httpError(reply, 404, 'CONTA_NAO_ENCONTRADA');
    const contact = conv.contact;
    const b = req.body || {};
    let result;
    try {
      if (b.template?.name) {
        result = await waSendAndRecord({ account, conversation: conv, contact, kind: 'template', template: b.template, sentBy: req.user });
      } else {
        const text = String(b.text || '').trim();
        if (!text) return httpError(reply, 400, 'TEXTO_OBRIGATORIO');
        if (!windowOpen(conv)) return reply.code(409).send({ error: 'JANELA_FECHADA', window_expires_at: conv.window_expires_at, detail: 'Fora da janela de 24h so e permitido enviar template.' });
        result = await waSendAndRecord({ account, conversation: conv, contact, kind: 'text', text, sentBy: req.user });
      }
    } catch (e) {
      app.log.error({ err: e }, 'send failed');
      return reply.code(502).send(metaErrorPayload(e));
    }
    if (!result.ok) return reply.code(502).send({ ...metaErrorPayload(result.error), message_id: result.message?.id });
    return { ok: true, wamid: result.wamid, message: result.message };
  });

  api.patch('/contacts/:id', async (req, reply) => {
    if (!isUuid(req.params.id)) return httpError(reply, 404, 'CONTATO_NAO_ENCONTRADO');
    const b = req.body || {};
    const patch = {};
    if (typeof b.name === 'string') patch.name = b.name.trim() || null;
    if (Array.isArray(b.tags)) patch.tags = [...new Set(b.tags.map((t) => String(t).trim()).filter(Boolean))];
    if (typeof b.opt_out === 'boolean') patch.opt_out = b.opt_out;
    if (b.custom && typeof b.custom === 'object') patch.custom = b.custom;
    if (!Object.keys(patch).length) return httpError(reply, 400, 'NADA_PARA_ATUALIZAR');
    const { data, error } = await sb.from('wa_contacts').update(patch).eq('id', req.params.id).select('*').maybeSingle();
    if (error) return dbFail(reply, error, 'update contact');
    if (!data) return httpError(reply, 404, 'CONTATO_NAO_ENCONTRADO');
    return data;
  });

  // ---- [8] templates ----
  const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];
  async function accountWithWaba(req, reply) {
    const acc = await getAccount(req.params.id);
    if (!acc) { httpError(reply, 404, 'CONTA_NAO_ENCONTRADA'); return null; }
    if (!acc.waba_id) { httpError(reply, 400, 'WABA_ID_OBRIGATORIO'); return null; }
    return acc;
  }
  async function fetchMetaTemplates(acc) {
    const out = []; let after;
    for (let i = 0; i < 20; i++) {
      const res = await metaFetch(acc, `${acc.waba_id}/message_templates`, { query: { fields: 'id,name,status,category,language,components', limit: 100, after } });
      out.push(...(res.data || []));
      after = res.paging?.cursors?.after;
      if (!res.paging?.next || !after) break;
    }
    return out;
  }
  async function syncTemplates(acc) {
    const list = await fetchMetaTemplates(acc);
    const rows = list.filter((t) => t.name && t.language).map((t) => ({
      account_id: acc.id, meta_id: t.id || null, name: t.name, language: t.language, category: t.category || null,
      status: t.status || null, components: t.components || [], synced_at: nowIso(),
    }));
    if (rows.length) {
      const { error } = await sb.from('wa_templates').upsert(rows, { onConflict: 'account_id,name,language' });
      if (error) throw error;
    }
    const keys = new Set(rows.map((r) => r.name + '|' + r.language));
    const { data: cached } = await sb.from('wa_templates').select('id,name,language').eq('account_id', acc.id);
    const stale = (cached || []).filter((c) => !keys.has(c.name + '|' + c.language)).map((c) => c.id);
    if (stale.length) await sb.from('wa_templates').delete().in('id', stale);
    return rows;
  }
  // Upload resumable da Meta: POST /{app_id}/uploads -> id; POST /{id} (Authorization: OAuth) -> { h }
  async function metaUploadMedia(acc, buf, mime, filename) {
    let appId = acc.app_id;
    if (!appId) {
      const dbg = await metaFetch(acc, 'debug_token', { query: { input_token: acc.access_token } });
      appId = dbg?.data?.app_id;
      if (appId) await updateAccount(acc.id, { app_id: appId }).catch(() => {});
    }
    if (!appId) { const e = new Error('APP_ID_OBRIGATORIO'); e.code = 'APP_ID_OBRIGATORIO'; throw e; }
    const session = await metaFetch(acc, `${appId}/uploads`, { method: 'POST', query: { file_length: buf.length, file_type: mime, file_name: filename || 'media' } });
    if (!session?.id) throw new Error('Meta nao retornou id da sessao de upload');
    const res = await metaFetch(acc, session.id, { method: 'POST', body: buf, headers: { Authorization: `OAuth ${acc.access_token}`, file_offset: '0', 'Content-Type': 'application/octet-stream' } });
    if (!res?.h) throw new Error('Meta nao retornou header_handle');
    return res.h;
  }

  api.get('/accounts/:id/templates', async (req, reply) => {
    const acc = await accountWithWaba(req, reply); if (!acc) return;
    return withMeta(reply, async () => ({ data: await fetchMetaTemplates(acc) }));
  });
  api.post('/accounts/:id/sync-templates', async (req, reply) => {
    const acc = await accountWithWaba(req, reply); if (!acc) return;
    return withMeta(reply, async () => { const rows = await syncTemplates(acc); return { synced: rows.length, templates: rows }; });
  });
  api.get('/accounts/:id/templates-cache', async (req, reply) => {
    const acc = await getAccount(req.params.id);
    if (!acc) return httpError(reply, 404, 'CONTA_NAO_ENCONTRADA');
    const { data, error } = await sb.from('wa_templates').select('*').eq('account_id', acc.id).order('name');
    if (error) return dbFail(reply, error, 'templates cache');
    return data;
  });
  api.post('/accounts/:id/templates', async (req, reply) => {
    const acc = await accountWithWaba(req, reply); if (!acc) return;
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!/^[a-z0-9_]{1,512}$/.test(name)) return httpError(reply, 400, 'NOME_INVALIDO', { detail: 'so letras minusculas, numeros e _' });
    const language = String(b.language || '').trim();
    if (!language) return httpError(reply, 400, 'IDIOMA_OBRIGATORIO');
    const category = String(b.category || '').toUpperCase();
    if (!TEMPLATE_CATEGORIES.includes(category)) return httpError(reply, 400, 'CATEGORIA_INVALIDA', { permitidas: TEMPLATE_CATEGORIES });
    const components = Array.isArray(b.components) ? b.components.map((c) => ({ ...c, type: String(c.type || '').toUpperCase() })) : [];
    if (!components.some((c) => c.type === 'BODY' && String(c.text || '').trim())) return httpError(reply, 400, 'BODY_OBRIGATORIO');

    let headerHandle = null, media = null;
    if (b.header_media?.base64) {
      let buf;
      try { buf = Buffer.from(String(b.header_media.base64).replace(/^data:[^;]+;base64,/, ''), 'base64'); } catch { buf = null; }
      if (!buf?.length) return httpError(reply, 400, 'MIDIA_INVALIDA');
      const mime = String(b.header_media.mime || 'application/octet-stream');
      const format = mime.startsWith('image/') ? 'IMAGE' : mime.startsWith('video/') ? 'VIDEO' : 'DOCUMENT';
      const p = `templates/${acc.id}/${name}-${Date.now()}.${extFromMime(mime)}`;
      const { error: upErr } = await sb.storage.from('wa-media').upload(p, buf, { contentType: mime, upsert: true });
      if (upErr) return httpError(reply, 500, 'STORAGE_ERROR', { detail: upErr.message });
      media = { media_path: p, media_url: publicMediaUrl(p), mime };
      try { headerHandle = await metaUploadMedia(acc, buf, mime, b.header_media.filename); }
      catch (e) {
        if (e.code === 'APP_ID_OBRIGATORIO') return httpError(reply, 400, 'APP_ID_OBRIGATORIO', { detail: 'Informe o App ID na conta pra subir midia de template' });
        return reply.code(502).send(metaErrorPayload(e));
      }
      let header = components.find((c) => c.type === 'HEADER');
      if (!header) { header = { type: 'HEADER' }; components.unshift(header); }
      header.format = format;
      header.example = { header_handle: [headerHandle] };
      delete header.text;
    }
    return withMeta(reply, async () => {
      const created = await metaFetch(acc, `${acc.waba_id}/message_templates`, { method: 'POST', body: { name, language, category, components } });
      const row = { account_id: acc.id, meta_id: created?.id || null, name, language, category: created?.category || category, status: created?.status || 'PENDING', components, synced_at: nowIso() };
      const { error } = await sb.from('wa_templates').upsert(row, { onConflict: 'account_id,name,language' });
      if (error) app.log.error({ err: error }, 'falha ao cachear template');
      return reply.code(201).send({ id: created?.id || null, status: row.status, category: row.category, header_handle: headerHandle, ...(media || {}), template: row });
    });
  });

  // ---- [9] disparo / broadcast ----
  api.post('/broadcast', async (req, reply) => {
    const b = req.body || {};
    if (!isUuid(b.account_id)) return httpError(reply, 400, 'ACCOUNT_ID_OBRIGATORIO');
    const account = await getAccount(b.account_id);
    if (!account) return httpError(reply, 404, 'CONTA_NAO_ENCONTRADA');
    const tplName = String(b.template?.name || '').trim();
    if (!tplName) return httpError(reply, 400, 'TEMPLATE_OBRIGATORIO');
    const tplLang = String(b.template?.language || 'pt_BR').trim();
    const list_name = String(b.list_name || '').trim() || `Disparo ${new Date().toLocaleDateString('pt-BR')}`;
    let raw = [];
    if (typeof b.csv === 'string' && b.csv.trim()) raw = csvToContacts(b.csv);
    else if (Array.isArray(b.contacts)) raw = b.contacts;
    const { contacts, invalid, duplicates } = normalizeContacts(raw);
    if (!contacts.length) return httpError(reply, 400, 'LISTA_VAZIA', { invalid, duplicates, detail: 'Nenhum telefone valido (minimo 10 digitos).' });
    const rate = Math.min(50, Math.max(1, Number(b.rate_per_sec) || 5));
    const { data: tplRow } = await sb.from('wa_templates').select('components').eq('account_id', account.id).eq('name', tplName).eq('language', tplLang).maybeSingle();
    const job = {
      id: `job-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      account, account_id: account.id, list_name, template: { name: tplName, language: tplLang }, tplComponents: tplRow?.components || null,
      contacts, total: contacts.length, sent: 0, failed: 0, skipped: 0, done: false, cancelled: false, errors: [],
      started_at: nowIso(), finished_at: null, rate, created_by: req.user.email, created_by_user: req.user,
    };
    broadcastJobs.set(job.id, job);
    if (broadcastJobs.size > 100) { // poda os mais antigos ja concluidos
      for (const [id, j] of broadcastJobs) { if (j.done) { broadcastJobs.delete(id); if (broadcastJobs.size <= 100) break; } }
    }
    runBroadcast(job).catch((e) => { job.done = true; job.finished_at = nowIso(); job.error = String(e.message); app.log.error({ err: e }, 'runBroadcast'); }); // nao-awaited
    return reply.code(202).send({ job_id: job.id, total: job.total, invalid, duplicates, list_name, template: job.template, rate_per_sec: rate });
  });
  api.get('/broadcast', async () => [...broadcastJobs.values()].map(jobPublic).sort((a, b) => (a.started_at < b.started_at ? 1 : -1)));
  api.get('/broadcast/:jobId', async (req, reply) => {
    const job = broadcastJobs.get(req.params.jobId);
    if (!job) return httpError(reply, 404, 'JOB_NAO_ENCONTRADO');
    return jobPublic(job);
  });
  api.post('/broadcast/:jobId/cancel', async (req, reply) => {
    const job = broadcastJobs.get(req.params.jobId);
    if (!job) return httpError(reply, 404, 'JOB_NAO_ENCONTRADO');
    job.cancelled = true;
    return jobPublic(job);
  });

  // Relatorio de envios com erros traduzidos (anti-bug #4: nao existe /sends, so /sends-report)
  api.get('/sends-report', async (req, reply) => {
    const { job_id, account_id, status, since, limit } = req.query;
    let q = sb.from('whatsapp_api_sends').select('*').order('created_at', { ascending: false }).limit(Math.min(Number(limit) || 500, 5000));
    if (job_id) q = q.eq('job_id', String(job_id));
    if (account_id && isUuid(account_id)) q = q.eq('account_id', account_id);
    if (status) q = q.eq('status', String(status));
    if (since) q = q.gte('created_at', String(since));
    const { data, error } = await q;
    if (error) return dbFail(reply, error, 'sends-report');
    const rows = data.map((r) => ({ ...r, help: r.status === 'failed' ? errorHelp(r.error_code) : null }));
    const summary = { total: rows.length, sent: 0, failed: 0, skipped: 0, delivered: 0, read: 0 };
    for (const r of rows) {
      if (r.status in summary) summary[r.status]++;
      if (r.delivery_status === 'delivered') summary.delivered++;
      if (r.delivery_status === 'read') { summary.delivered++; summary.read++; }
    }
    return { summary, rows };
  });

  // ---- [10] fluxos (CRUD) ----
  const FLOW_SELECT = '*, account:whatsapp_api_accounts(id,label)';
  api.get('/flows', async (req, reply) => {
    const { data, error } = await sb.from('wa_flows').select(FLOW_SELECT).order('created_at');
    if (error) return dbFail(reply, error, 'list flows');
    return data;
  });
  api.get('/flows/:id', async (req, reply) => {
    if (!isUuid(req.params.id)) return httpError(reply, 404, 'FLUXO_NAO_ENCONTRADO');
    const { data, error } = await sb.from('wa_flows').select(FLOW_SELECT).eq('id', req.params.id).maybeSingle();
    if (error) return dbFail(reply, error, 'get flow');
    if (!data) return httpError(reply, 404, 'FLUXO_NAO_ENCONTRADO');
    return data;
  });
  api.post('/flows', async (req, reply) => {
    const v = validateFlow(req.body || {});
    if (v.error) return httpError(reply, 400, v.error, { detail: v.detail, permitidas: v.permitidas });
    const row = { active: true, match_text: false, account_id: null, ...v.value };
    const { data, error } = await sb.from('wa_flows').insert(row).select(FLOW_SELECT).single();
    if (error) return dbFail(reply, error, 'create flow');
    return reply.code(201).send(data);
  });
  api.put('/flows/:id', async (req, reply) => {
    if (!isUuid(req.params.id)) return httpError(reply, 404, 'FLUXO_NAO_ENCONTRADO');
    const v = validateFlow(req.body || {}, { partial: true });
    if (v.error) return httpError(reply, 400, v.error, { detail: v.detail, permitidas: v.permitidas });
    if (!Object.keys(v.value).length) return httpError(reply, 400, 'NADA_PARA_ATUALIZAR');
    const { data, error } = await sb.from('wa_flows').update(v.value).eq('id', req.params.id).select(FLOW_SELECT).maybeSingle();
    if (error) return dbFail(reply, error, 'update flow');
    if (!data) return httpError(reply, 404, 'FLUXO_NAO_ENCONTRADO');
    return data;
  });
  api.delete('/flows/:id', async (req, reply) => {
    if (!isUuid(req.params.id)) return httpError(reply, 404, 'FLUXO_NAO_ENCONTRADO');
    const { data, error } = await sb.from('wa_flows').delete().eq('id', req.params.id).select('id');
    if (error) return dbFail(reply, error, 'delete flow');
    if (!data?.length) return httpError(reply, 404, 'FLUXO_NAO_ENCONTRADO');
    return { ok: true, id: req.params.id };
  });

  // >>> [api-oficial] proximas rotas (inbox, templates, disparo, fluxos) entram aqui
}, { prefix: '/api-oficial' });

// ---------------------------------------------------------------- [6] webhook
const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'];
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf', 'text/plain': 'txt' };
const extFromMime = (mime) => MIME_EXT[String(mime || '').split(';')[0].trim()] || 'bin';
const publicMediaUrl = (p) => `${SUPABASE_PUBLIC_URL}/storage/v1/object/public/wa-media/${p.split('/').map(encodeURIComponent).join('/')}`;
const STATUS_RANK = { received: 0, queued: 0, accepted: 1, sent: 2, delivered: 3, read: 4, failed: 9 };

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
