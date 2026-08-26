// mock-meta: emula o Graph API da Meta (WhatsApp Cloud API) para dev/teste.
// NAO e fiel a tudo; e fiel ao que o backend consome. Estado em memoria.
import Fastify from 'fastify';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 4000);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://api:3000/whatsapp/webhook';

const rand = (n = 8) => crypto.randomBytes(n).toString('hex');
const nowTs = () => String(Math.floor(Date.now() / 1000));

// ------------------------------------------------------------------ estado
const state = {
  registered: new Set(),      // phone_number_id registrados (POST /:pnid/register)
  subscribedApps: new Map(),  // waba_id -> [app]
  templates: new Map(),       // waba_id -> [template]
  messages: [],               // mensagens enviadas via POST /:pnid/messages
  uploads: new Map(),         // upload id -> { file_length, file_type, received, handle }
  media: new Map(),           // media id -> { mime, filename }
  inbound: [],                // inbounds simulados
};

function defaultTemplates() {
  return [
    {
      id: 'tpl-MOCK-hello', name: 'hello_world', language: 'en_US', status: 'APPROVED', category: 'UTILITY',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Hello World' },
        { type: 'BODY', text: 'Welcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification from the Cloud API.' },
        { type: 'FOOTER', text: 'WhatsApp Business Platform sample message' },
      ],
    },
    {
      id: 'tpl-MOCK-promo', name: 'promo_botao', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Oferta para {{1}}' },
        { type: 'BODY', text: 'Ola {{1}}, temos uma condicao especial esta semana. Quer saber mais?' },
        { type: 'FOOTER', text: 'Responda pelos botoes' },
        { type: 'BUTTONS', buttons: [
          { type: 'QUICK_REPLY', text: 'Quero saber mais' },
          { type: 'QUICK_REPLY', text: 'Nao tenho interesse' },
        ] },
      ],
    },
    {
      id: 'tpl-MOCK-link', name: 'aviso_link', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Ola {{1}}, seu pedido esta disponivel. Acesse pelo botao abaixo.' },
        { type: 'BUTTONS', buttons: [
          { type: 'URL', text: 'Abrir site', url: 'https://example.com/pedido' },
          { type: 'PHONE_NUMBER', text: 'Ligar', phone_number: '+5511999990000' },
        ] },
      ],
    },
    {
      id: 'tpl-MOCK-img', name: 'promo_imagem', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING',
      components: [
        { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['HANDLE-MOCK-seed'] } },
        { type: 'BODY', text: 'Ola {{1}}, veja nossa novidade.' },
      ],
    },
  ];
}
function templatesOf(wabaId) {
  if (!state.templates.has(wabaId)) state.templates.set(wabaId, defaultTemplates());
  return state.templates.get(wabaId);
}

// Gatilhos de erro: numero de destino terminando em XXXX -> erro no formato da Meta
const ERROR_TRIGGERS = {
  '0000': { code: 131047, message: 'Re-engagement message', details: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.' },
  '0001': { code: 132000, message: 'Number of parameters does not match the expected number of params', details: 'body: number of localizable_params (1) does not match the expected number of params (2)' },
  '0002': { code: 131026, message: 'Message Undeliverable', details: 'Message Undeliverable.' },
  '0003': { code: 131049, message: 'This message was not delivered to maintain healthy ecosystem engagement.', details: 'Meta chose not to deliver this marketing message.' },
  '0004': { code: 130429, message: 'Rate limit hit', details: 'Cloud API message throughput has been reached.' },
  '0005': { code: 100, message: 'Invalid parameter', details: 'Parameter invalid' },
  '0006': { code: 190, message: 'Error validating access token: Session has expired', details: 'Access token expired' },
  '0007': { code: 133010, message: 'Account not registered', details: 'The phone number is not registered on the Cloud API.' },
  '0008': { code: 131051, message: 'Unsupported message type', details: 'Message type is not currently supported.' },
  '0009': { code: 131030, message: 'Recipient phone number not in allowed list', details: 'Recipient not in allowed list (test mode).' },
  '0010': { code: 132001, message: 'Template does not exist', details: 'template name (xxx) does not exist in pt_BR' },
  '0011': { code: 131056, message: '(Business Account, Consumer Account) pair rate limit hit', details: 'Too many messages sent to the same recipient.' },
};

function metaError(reply, { code, message, details, subcode }, http = 400) {
  return reply.code(http).send({
    error: {
      message: `(#${code}) ${message}`,
      type: 'OAuthException',
      code,
      ...(subcode ? { error_subcode: subcode } : {}),
      error_data: { messaging_product: 'whatsapp', details: details || message },
      fbtrace_id: 'MOCK-' + rand(6),
    },
  });
}

// ------------------------------------------------------------------ supabase (le app_secret da conta)
async function getAccountByPnid(pnid) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/whatsapp_api_accounts?phone_number_id=eq.${encodeURIComponent(pnid)}&select=id,phone_number_id,waba_id,app_secret,verify_token,display_phone&limit=1`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

// ------------------------------------------------------------------ app
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'warn' },
  bodyLimit: 60 * 1024 * 1024,
  // Aceita e ignora o prefixo de versao do Graph (/v21.0/...)
  rewriteUrl(req) { return req.url.replace(/^\/v\d+\.\d+(?=\/|$)/, '') || '/'; },
});
app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => done(null, body));

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const mimeDefault = { image: 'image/png', audio: 'audio/ogg', video: 'video/mp4', document: 'application/pdf', sticker: 'image/webp' };

function requireAuth(req, reply) {
  const h = req.headers.authorization || '';
  if (!/^(Bearer|OAuth) .{3,}/.test(h)) {
    metaError(reply, { code: 190, message: 'Invalid OAuth access token - Cannot parse access token', details: 'missing Authorization: Bearer' }, 401);
    return false;
  }
  return true;
}

// ---- utilitarios / estado (somente teste) ----
app.get('/health', async () => ({ status: 'ok', service: 'mock-meta', registered: state.registered.size, messages: state.messages.length }));
app.get('/_state', async () => ({
  registered: [...state.registered],
  subscribedApps: Object.fromEntries(state.subscribedApps),
  templates: Object.fromEntries(state.templates),
  messages: state.messages,
  inbound: state.inbound,
  uploads: Object.fromEntries(state.uploads),
}));
app.get('/_state/messages', async (req) => {
  const { to, phone_number_id, since } = req.query;
  let list = state.messages;
  if (to) list = list.filter((m) => m.to === to);
  if (phone_number_id) list = list.filter((m) => m.phone_number_id === phone_number_id);
  if (since) list = list.filter((m) => m.at >= Number(since));
  return { data: list };
});
app.delete('/_state', async () => { state.registered.clear(); state.subscribedApps.clear(); state.templates.clear(); state.messages.length = 0; state.uploads.clear(); state.inbound.length = 0; state.media.clear(); return { success: true }; });
app.delete('/_state/messages', async () => { state.messages.length = 0; return { success: true }; });

// ---- simulacao de inbound (linchpin dos testes de inbox/fluxo) ----
app.post('/_simulate/inbound', async (req, reply) => {
  const b = req.body || {};
  const pnid = b.phone_number_id;
  const from = String(b.from || '').replace(/\D/g, '');
  if (!pnid || !from) return reply.code(400).send({ error: 'phone_number_id e from sao obrigatorios' });
  const acc = await getAccountByPnid(pnid);
  const secret = b.app_secret || acc?.app_secret;
  if (!secret) return reply.code(404).send({ error: `conta com phone_number_id=${pnid} nao encontrada (ou sem app_secret)` });
  const wabaId = b.waba_id || acc?.waba_id || 'WABA-MOCK';
  const displayPhone = b.display_phone_number || acc?.display_phone || '+55 11 99999-0001';
  const type = b.type || 'text';
  const timestamp = nowTs();
  const wamid = b.wamid || `wamid.MOCK-in-${rand(10)}`;
  const value = {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: displayPhone, phone_number_id: pnid },
  };
  if (type === 'status') {
    value.statuses = [{ id: b.wamid || `wamid.MOCK-${rand(6)}`, status: b.status || 'delivered', timestamp, recipient_id: from,
      conversation: { id: 'conv-' + rand(4), origin: { type: 'marketing' } }, pricing: { billable: true, pricing_model: 'CBP', category: 'marketing' },
      ...(b.errors ? { errors: b.errors } : {}) }];
  } else {
    value.contacts = [{ profile: { name: b.name || `Lead ${from.slice(-4)}` }, wa_id: from }];
    const msg = { from, id: wamid, timestamp, type };
    if (b.context_wamid) msg.context = { from: displayPhone.replace(/\D/g, ''), id: b.context_wamid };
    switch (type) {
      case 'text': msg.text = { body: b.text ?? '' }; break;
      case 'button': msg.button = { payload: b.button_payload ?? b.button_text ?? '', text: b.button_text ?? b.button_payload ?? '' }; break;
      case 'interactive': msg.interactive = { type: 'button_reply', button_reply: { id: b.interactive_id ?? 'btn-1', title: b.interactive_title ?? b.text ?? 'Sim' } }; break;
      case 'reaction': msg.reaction = { message_id: b.reaction_wamid || '', emoji: b.emoji || '👍' }; break;
      case 'location': msg.location = { latitude: b.latitude ?? -23.55, longitude: b.longitude ?? -46.63, name: b.name_location, address: b.address }; break;
      case 'image': case 'audio': case 'video': case 'document': case 'sticker': {
        const mediaId = `MEDIA-${rand(6)}`;
        const mime = b.media_mime || mimeDefault[type];
        state.media.set(mediaId, { mime, filename: b.filename });
        msg[type] = { id: mediaId, mime_type: mime, sha256: 'mock-sha256', ...(b.caption ? { caption: b.caption } : {}), ...(b.filename ? { filename: b.filename } : {}) };
        break;
      }
      default: msg.type = 'unsupported'; msg.errors = [{ code: 131051, title: 'Unsupported message type' }];
    }
    value.messages = [msg];
  }
  const payload = { object: 'whatsapp_business_account', entry: [{ id: wabaId, changes: [{ value, field: 'messages' }] }] };
  const raw = Buffer.from(JSON.stringify(payload));
  const signSecret = b.bad_signature ? secret + '-WRONG' : secret;
  const signature = 'sha256=' + crypto.createHmac('sha256', signSecret).update(raw).digest('hex');
  const target = b.webhook_url || WEBHOOK_URL;
  let res, text;
  try {
    res = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature, 'User-Agent': 'facebookexternalua' }, body: raw });
    text = await res.text();
  } catch (e) {
    return reply.code(502).send({ delivered: false, error: String(e), target });
  }
  let body; try { body = JSON.parse(text); } catch { body = text; }
  const rec = { wamid, phone_number_id: pnid, from, type, status: res.status, at: Date.now() };
  state.inbound.push(rec);
  return { delivered: true, status: res.status, body, wamid, payload, signature };
});

// ---- Graph API emulado ----
app.get('/debug_token', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return { data: { app_id: 'APP-MOCK', type: 'USER', application: 'App Mock', is_valid: true, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'], expires_at: 0 } };
});

app.get('/_media/:id', async (req, reply) => {
  const m = state.media.get(req.params.id) || { mime: 'image/png' };
  if (m.mime === 'image/png') return reply.type('image/png').send(TINY_PNG);
  return reply.type(m.mime).send(Buffer.from(`mock media ${req.params.id} (${m.mime})`));
});

// GET /:id -> numero (phone_number_id), midia (MEDIA-*), upload (upload:*)
app.get('/:id', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = req.params.id;
  if (id.startsWith('MEDIA-')) {
    const m = state.media.get(id) || { mime: 'image/png' };
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return { url: `${proto}://${req.headers.host}/_media/${id}`, mime_type: m.mime, sha256: 'mock-sha256', file_size: m.mime === 'image/png' ? TINY_PNG.length : 32, id, messaging_product: 'whatsapp' };
  }
  if (id.startsWith('upload:')) {
    const u = state.uploads.get(id);
    if (!u) return metaError(reply, { code: 100, message: 'Unsupported get request. Object does not exist', details: id }, 400);
    return { id, file_offset: u.received };
  }
  if (id.startsWith('NOPE')) return metaError(reply, { code: 100, message: 'Unsupported get request. Object with ID does not exist', details: id }, 400);
  return {
    id, verified_name: 'Numero de Teste', display_phone_number: '+55 11 99999-0001', quality_rating: 'GREEN',
    code_verification_status: 'VERIFIED', platform_type: 'CLOUD_API', name_status: 'APPROVED',
    is_official_business_account: false, messaging_limit_tier: 'TIER_1K', registered: state.registered.has(id),
  };
});

app.post('/:pnid/register', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const pin = String(req.body?.pin ?? '');
  if (!/^\d{6}$/.test(pin)) return metaError(reply, { code: 100, message: 'Invalid parameter', details: 'pin must be 6 digits' });
  state.registered.add(req.params.pnid);
  return { success: true };
});
app.post('/:pnid/deregister', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  state.registered.delete(req.params.pnid);
  return { success: true };
});

app.post('/:pnid/messages', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const b = req.body || {};
  if (b.messaging_product !== 'whatsapp') return metaError(reply, { code: 100, message: 'Invalid parameter', details: 'messaging_product must be whatsapp' });
  const to = String(b.to || '').replace(/\D/g, '');
  if (!to) return metaError(reply, { code: 100, message: 'Invalid parameter', details: 'to is required' });
  if (!b.type) return metaError(reply, { code: 100, message: 'Invalid parameter', details: 'type is required' });
  const trig = ERROR_TRIGGERS[to.slice(-4)];
  if (trig) return metaError(reply, trig, trig.code === 190 ? 401 : 400);
  if (b.type === 'template') {
    const name = b.template?.name;
    if (!name) return metaError(reply, { code: 100, message: 'Invalid parameter', details: 'template.name is required' });
    const lang = b.template?.language?.code;
    // valida contra os templates conhecidos de qualquer WABA (mock: qualquer waba)
    const all = [...state.templates.values()].flat();
    const def = all.find((t) => t.name === name && (!lang || t.language === lang));
    if (all.length && !def) {
      return metaError(reply, { code: 132001, message: 'Template does not exist', details: `template name (${name}) does not exist in ${lang || 'any language'}` });
    }
    if (def) { // fidelidade a Meta: cabecalho de midia obrigatorio, contagem de variaveis do corpo
      const comps = Array.isArray(b.template.components) ? b.template.components : [];
      const header = (def.components || []).find((c) => c.type === 'HEADER');
      const fmt = String(header?.format || '').toUpperCase();
      if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(fmt)) {
        const hp = comps.find((c) => String(c.type).toLowerCase() === 'header')?.parameters?.[0];
        const kind = fmt.toLowerCase();
        if (!hp || String(hp.type).toLowerCase() !== kind || !(hp[kind]?.link || hp[kind]?.id)) {
          return metaError(reply, { code: 132012, message: 'Parameter format does not match format in the created template', details: `header: Format mismatch, expected ${fmt}, received ${hp ? String(hp.type).toUpperCase() : 'UNKNOWN'}` });
        }
      }
      const bodyDef = (def.components || []).find((c) => c.type === 'BODY');
      const expected = (String(bodyDef?.text || '').match(/\{\{\d+\}\}/g) || []).length;
      const got = comps.find((c) => String(c.type).toLowerCase() === 'body')?.parameters?.length || 0;
      if (expected !== got) {
        return metaError(reply, { code: 132000, message: 'Number of parameters does not match the expected number of params', details: `body: number of localizable_params (${got}) does not match the expected number of params (${expected})` });
      }
    }
  }
  const wamid = `wamid.MOCK-${rand(10)}`;
  let body = '';
  if (b.type === 'text') body = b.text?.body || '';
  else if (b.type === 'template') body = `[template:${b.template?.name}]`;
  else if (b.type === 'interactive') body = b.interactive?.body?.text || '[interactive]';
  else body = `[${b.type}]`;
  state.messages.push({ id: wamid, phone_number_id: req.params.pnid, to, type: b.type, body, payload: b, at: Date.now() });
  // Como a Meta: celular BR com 9 (55+DDD+9XXXXXXXX) e identificado pelo wa_id SEM o 9
  const waId = /^55\d{2}9\d{8}$/.test(to) ? to.slice(0, 4) + to.slice(5) : to;
  return { messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: waId }], messages: [{ id: wamid, message_status: 'accepted' }] };
});

app.get('/:wabaId/message_templates', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  let data = templatesOf(req.params.wabaId);
  if (req.query.name) data = data.filter((t) => t.name === req.query.name);
  if (req.query.status) data = data.filter((t) => t.status === req.query.status);
  return { data, paging: { cursors: { before: 'MOCK', after: 'MOCK' } } };
});
app.post('/:wabaId/message_templates', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const b = req.body || {};
  if (!b.name || !/^[a-z0-9_]+$/.test(b.name)) return metaError(reply, { code: 100, message: 'Invalid parameter', details: 'name: only lowercase letters, numbers and underscores' });
  if (!b.language) return metaError(reply, { code: 100, message: 'Invalid parameter', details: 'language is required' });
  if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(b.category)) return metaError(reply, { code: 100, message: 'Invalid parameter', details: 'category must be MARKETING, UTILITY or AUTHENTICATION' });
  if (!Array.isArray(b.components) || !b.components.some((c) => c.type === 'BODY')) return metaError(reply, { code: 100, message: 'Invalid parameter', details: 'components must include a BODY' });
  const header = b.components.find((c) => c.type === 'HEADER');
  if (header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format)) {
    const h = header.example?.header_handle?.[0];
    if (!h) return metaError(reply, { code: 100, message: 'Invalid parameter', details: 'header example.header_handle is required for media headers' });
    const known = [...state.uploads.values()].some((u) => u.handle === h) || h.startsWith('HANDLE-MOCK');
    if (!known) return metaError(reply, { code: 100, message: 'Invalid parameter', details: 'header_handle unknown' });
  }
  const list = templatesOf(req.params.wabaId);
  if (list.some((t) => t.name === b.name && t.language === b.language)) return metaError(reply, { code: 100, message: 'Invalid parameter', details: `template ${b.name} (${b.language}) already exists` }, 400);
  const tpl = { id: `tpl-MOCK-${rand(6)}`, name: b.name, language: b.language, category: b.category, status: 'APPROVED', components: b.components };
  list.push(tpl);
  return { id: tpl.id, status: tpl.status, category: tpl.category };
});

app.post('/:wabaId/subscribed_apps', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const list = state.subscribedApps.get(req.params.wabaId) || [];
  if (!list.some((a) => a.whatsapp_business_api_data?.id === 'APP-MOCK')) {
    list.push({ whatsapp_business_api_data: { id: 'APP-MOCK', name: 'App Mock', link: 'https://www.facebook.com/games/?app_id=APP-MOCK' } });
  }
  state.subscribedApps.set(req.params.wabaId, list);
  return { success: true };
});
app.get('/:wabaId/subscribed_apps', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return { data: state.subscribedApps.get(req.params.wabaId) || [] };
});

// Upload resumable: POST /:appId/uploads?file_length&file_type&file_name -> { id }
app.post('/:appId/uploads', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = `upload:MOCK-${rand(8)}`;
  state.uploads.set(id, { file_length: Number(req.query.file_length || 0), file_type: req.query.file_type || 'application/octet-stream', file_name: req.query.file_name, received: 0, handle: null });
  return { id };
});
// POST /upload:ID  (header file_offset, corpo = bytes) -> { h: header_handle }
app.post('/:uploadId', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = req.params.uploadId;
  if (!id.startsWith('upload:')) return metaError(reply, { code: 100, message: 'Unsupported post request', details: id });
  const u = state.uploads.get(id);
  if (!u) return metaError(reply, { code: 100, message: 'Unsupported post request. Object does not exist', details: id });
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''));
  u.received += bytes.length;
  u.handle = u.handle || `HANDLE-MOCK-${rand(8)}`;
  return { h: u.handle };
});

app.setNotFoundHandler((req, reply) => metaError(reply, { code: 803, message: `Unsupported ${req.method} request. Path ${req.url} not emulated by mock-meta`, details: req.url }, 404));

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`[mock-meta] ouvindo em :${PORT} | webhook -> ${WEBHOOK_URL} | supabase=${SUPABASE_URL || '(sem)'}`);
});
