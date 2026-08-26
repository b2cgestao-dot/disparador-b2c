// T7 - Templates: sincronizar (cache em wa_templates), listar ao vivo, criar (com e sem cabecalho de midia).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { authed, api, mock, sb, uid, createTestAccount, deleteAccount } from './helpers.mjs';

let acc;
before(async () => { acc = await createTestAccount(); });
after(async () => { if (acc) await deleteAccount(acc.id); });
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('T7: rotas de templates exigem autenticacao', async () => {
  assert.equal((await api(`/api-oficial/accounts/${acc.id}/templates`)).status, 401);
  assert.equal((await api(`/api-oficial/accounts/${acc.id}/sync-templates`, { method: 'POST' })).status, 401);
});

test('T7: "Sincronizar" busca do mock e popula wa_templates (sem duplicar na 2a vez)', async () => {
  const r = await authed(`/api-oficial/accounts/${acc.id}/sync-templates`, { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.synced >= 4, 'mock tem 4 templates de exemplo');
  const { data } = await sb.from('wa_templates').select('*').eq('account_id', acc.id).order('name');
  const names = data.map((t) => t.name);
  for (const n of ['hello_world', 'promo_botao', 'aviso_link', 'promo_imagem']) assert.ok(names.includes(n), n + ' no cache');
  const promo = data.find((t) => t.name === 'promo_botao');
  assert.equal(promo.language, 'pt_BR'); assert.equal(promo.category, 'MARKETING'); assert.equal(promo.status, 'APPROVED');
  assert.ok(promo.meta_id.startsWith('tpl-MOCK'));
  const buttons = promo.components.find((c) => c.type === 'BUTTONS');
  assert.equal(buttons.buttons[0].type, 'QUICK_REPLY');
  assert.equal(buttons.buttons[0].text, 'Quero saber mais');
  const r2 = await authed(`/api-oficial/accounts/${acc.id}/sync-templates`, { method: 'POST' });
  assert.equal(r2.status, 200);
  const { data: again } = await sb.from('wa_templates').select('id').eq('account_id', acc.id);
  assert.equal(again.length, data.length, 'segunda sync nao duplica');
  const cache = await authed(`/api-oficial/accounts/${acc.id}/templates-cache`);
  assert.equal(cache.status, 200);
  assert.equal(cache.body.length, data.length);
});

test('T7: listar templates ao vivo (GET) vem direto do mock', async () => {
  const r = await authed(`/api-oficial/accounts/${acc.id}/templates`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.data));
  assert.ok(r.body.data.some((t) => t.name === 'hello_world'));
});

test('T7: sync sem waba_id retorna 400 (nao 500)', async () => {
  const noWaba = await createTestAccount({ waba_id: null });
  try {
    const r = await authed(`/api-oficial/accounts/${noWaba.id}/sync-templates`, { method: 'POST' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'WABA_ID_OBRIGATORIO');
  } finally { await deleteAccount(noWaba.id); }
});

test('T7: "Criar template" faz POST no mock, retorna id e entra no cache', async () => {
  const name = 'boas_vindas_' + uid(2);
  const body = { name, language: 'pt_BR', category: 'MARKETING', components: [
    { type: 'BODY', text: 'Ola {{1}}, bem-vindo a {{2}}!', example: { body_text: [['Maria', 'Loja X']] } },
    { type: 'FOOTER', text: 'Responda SAIR para nao receber mais' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Quero ofertas' }, { type: 'QUICK_REPLY', text: 'SAIR' }] },
  ] };
  const r = await authed(`/api-oficial/accounts/${acc.id}/templates`, { method: 'POST', body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.id, /^tpl-MOCK-/);
  assert.equal(r.body.status, 'APPROVED');
  const live = await mock(`/${acc.waba_id}/message_templates?name=${name}`, { headers: { Authorization: 'Bearer token-de-teste' } });
  assert.equal(live.body.data.length, 1, 'mock tem o template');
  const { data: cached } = await sb.from('wa_templates').select('*').eq('account_id', acc.id).eq('name', name).single();
  assert.equal(cached.meta_id, r.body.id);
  assert.equal(cached.components.find((c) => c.type === 'BUTTONS').buttons.length, 2);
});

test('T7: validacao de template: nome invalido e falta de BODY viram erro (400/502), nunca 500', async () => {
  const bad = await authed(`/api-oficial/accounts/${acc.id}/templates`, { method: 'POST', body: { name: 'Nome Invalido', language: 'pt_BR', category: 'MARKETING', components: [{ type: 'BODY', text: 'x' }] } });
  assert.ok([400, 502].includes(bad.status), 'status ' + bad.status);
  const noBody = await authed(`/api-oficial/accounts/${acc.id}/templates`, { method: 'POST', body: { name: 'sem_corpo', language: 'pt_BR', category: 'MARKETING', components: [] } });
  assert.equal(noBody.status, 400);
  const badCat = await authed(`/api-oficial/accounts/${acc.id}/templates`, { method: 'POST', body: { name: 'cat_x', language: 'pt_BR', category: 'OUTRA', components: [{ type: 'BODY', text: 'x' }] } });
  assert.equal(badCat.status, 400);
});

test('T7: criar com cabecalho de midia: sobe pro Storage, reenvia pro mock e recebe header_handle', async () => {
  const name = 'promo_img_' + uid(2);
  const r = await authed(`/api-oficial/accounts/${acc.id}/templates`, { method: 'POST', body: {
    name, language: 'pt_BR', category: 'MARKETING',
    header_media: { base64: TINY_PNG, mime: 'image/png', filename: 'banner.png' },
    components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Ola {{1}}, veja a novidade!' }],
  } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.header_handle, /^HANDLE-MOCK-/);
  assert.ok(r.body.media_url?.includes('/storage/v1/object/public/wa-media/'), 'midia salva no Storage: ' + r.body.media_url);
  assert.ok(r.body.media_path?.startsWith(`templates/${acc.id}/`));
  const { data: obj, error } = await sb.storage.from('wa-media').download(r.body.media_path);
  assert.equal(error, null, error?.message); assert.ok(obj.size > 0);
  const st = await mock('/_state');
  const up = Object.values(st.body.uploads).find((u) => u.handle === r.body.header_handle);
  assert.ok(up, 'mock registrou o upload');
  assert.equal(up.file_type, 'image/png');
  assert.ok(up.received > 0, 'bytes chegaram ao mock');
  const live = await mock(`/${acc.waba_id}/message_templates?name=${name}`, { headers: { Authorization: 'Bearer token-de-teste' } });
  const header = live.body.data[0].components.find((c) => c.type === 'HEADER');
  assert.equal(header.format, 'IMAGE');
  assert.deepEqual(header.example.header_handle, [r.body.header_handle]);
  const { data: cached } = await sb.from('wa_templates').select('components').eq('account_id', acc.id).eq('name', name).single();
  assert.equal(cached.components.find((c) => c.type === 'HEADER').example.header_handle[0], r.body.header_handle);
});

test('T7: midia padrao do cabecalho - upload vai pro Storage e fica no cache do template', async () => {
  const { data: tpl } = await sb.from('wa_templates').select('*').eq('account_id', acc.id).eq('name', 'promo_imagem').single();
  assert.ok(tpl, 'promo_imagem sincronizado');
  assert.equal(tpl.header_media_url, null);
  const r = await authed(`/api-oficial/accounts/${acc.id}/templates/${tpl.id}/header-media`, { method: 'POST', body: { base64: TINY_PNG, mime: 'image/png', filename: 'banner.png' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.header_media_url.includes('/storage/v1/object/public/wa-media/templates/'), r.body.header_media_url);
  const pub = await fetch(r.body.header_media_url);
  assert.equal(pub.status, 200);
  const cache = await authed(`/api-oficial/accounts/${acc.id}/templates-cache`);
  assert.equal(cache.body.find((t) => t.name === 'promo_imagem').header_media_url, r.body.header_media_url);
  const byUrl = await authed(`/api-oficial/accounts/${acc.id}/templates/${tpl.id}/header-media`, { method: 'POST', body: { url: 'https://exemplo.com/banner.jpg' } });
  assert.equal(byUrl.status, 200); assert.equal(byUrl.body.header_media_url, 'https://exemplo.com/banner.jpg');
  const bad = await authed(`/api-oficial/accounts/${acc.id}/templates/${tpl.id}/header-media`, { method: 'POST', body: {} });
  assert.equal(bad.status, 400);
});
