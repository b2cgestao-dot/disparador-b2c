// T4 - Contas: CRUD + Testar/Registrar/Inscrever contra o mock-meta; segredos nunca vazam.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, authed, mock, sb, uid, deleteAccount, SEED } from './helpers.mjs';

const created = [];
after(async () => { for (const id of created) await deleteAccount(id); });

function assertNoSecrets(obj, secrets) {
  const json = JSON.stringify(obj);
  for (const s of secrets) assert.ok(!json.includes(s), `segredo vazou na resposta: ${s}`);
  assert.ok(!/"access_token"\s*:\s*"[^"]/.test(json), 'campo access_token nao pode vir preenchido');
  assert.ok(!/"app_secret"\s*:\s*"[^"]/.test(json), 'campo app_secret nao pode vir preenchido');
}

const payload = () => {
  const id = uid(4);
  return { label: `Conta T4 ${id}`, phone_number_id: `PNID-T4-${id}`, waba_id: `WABA-T4-${id}`, app_id: 'APP-MOCK',
    access_token: `TOKEN-T4-${id}`, app_secret: `secret-t4-${id}`, verify_token: `verify-t4-${id}`, display_phone: '+55 11 90000-0000' };
};

test('T4: rotas de contas exigem autenticacao', async () => {
  const r = await api('/api-oficial/accounts');
  assert.equal(r.status, 401);
  const r2 = await api('/api-oficial/accounts', { method: 'POST', body: payload() });
  assert.equal(r2.status, 401);
  const r3 = await api('/api-oficial/accounts', { headers: { Authorization: 'Bearer token-falso' } });
  assert.equal(r3.status, 401);
});

test('T4: criar conta persiste no banco (com segredos) e a resposta nao expoe segredos', async () => {
  const p = payload();
  const r = await authed('/api-oficial/accounts', { method: 'POST', body: p });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  created.push(r.body.id);
  assert.equal(r.body.label, p.label);
  assert.equal(r.body.phone_number_id, p.phone_number_id);
  assert.equal(r.body.has_access_token, true);
  assert.equal(r.body.has_app_secret, true);
  assertNoSecrets(r.body, [p.access_token, p.app_secret]);
  const { data } = await sb.from('whatsapp_api_accounts').select('*').eq('id', r.body.id).single();
  assert.equal(data.access_token, p.access_token, 'token gravado no banco');
  assert.equal(data.app_secret, p.app_secret);
  assert.equal(data.verify_token, p.verify_token);
});

test('T4: validacao - label e phone_number_id obrigatorios; phone_number_id duplicado da 409', async () => {
  const r = await authed('/api-oficial/accounts', { method: 'POST', body: { label: 'sem pnid' } });
  assert.equal(r.status, 400);
  const dup = await authed('/api-oficial/accounts', { method: 'POST', body: { ...payload(), phone_number_id: SEED.account.phone_number_id } });
  assert.equal(dup.status, 409);
});

test('T4: listar e buscar contas (sem segredos)', async () => {
  const r = await authed('/api-oficial/accounts');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.some((a) => a.phone_number_id === SEED.account.phone_number_id), 'conta seed na lista');
  assertNoSecrets(r.body, [SEED.account.access_token, SEED.account.app_secret]);
  const one = r.body.find((a) => a.phone_number_id === SEED.account.phone_number_id);
  const g = await authed(`/api-oficial/accounts/${one.id}`);
  assert.equal(g.status, 200);
  assert.equal(g.body.id, one.id);
  assertNoSecrets(g.body, [SEED.account.access_token, SEED.account.app_secret]);
  const nf = await authed(`/api-oficial/accounts/00000000-0000-0000-0000-000000000000`);
  assert.equal(nf.status, 404);
});

test('T4: editar conta persiste; segredo vazio no PATCH mantem o antigo', async () => {
  const p = payload();
  const c = await authed('/api-oficial/accounts', { method: 'POST', body: p });
  created.push(c.body.id);
  const r = await authed(`/api-oficial/accounts/${c.body.id}`, { method: 'PATCH', body: { label: 'Editada', access_token: '', app_secret: '', waba_id: 'WABA-NOVA' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.label, 'Editada');
  assert.equal(r.body.waba_id, 'WABA-NOVA');
  assertNoSecrets(r.body, [p.access_token, p.app_secret]);
  const { data } = await sb.from('whatsapp_api_accounts').select('*').eq('id', c.body.id).single();
  assert.equal(data.label, 'Editada');
  assert.equal(data.access_token, p.access_token, 'token antigo mantido');
  assert.equal(data.app_secret, p.app_secret, 'secret antigo mantido');
  const r2 = await authed(`/api-oficial/accounts/${c.body.id}`, { method: 'PATCH', body: { access_token: 'TOKEN-NOVO' } });
  assert.equal(r2.status, 200);
  const { data: d2 } = await sb.from('whatsapp_api_accounts').select('access_token').eq('id', c.body.id).single();
  assert.equal(d2.access_token, 'TOKEN-NOVO');
});

test('T4: "Testar" chama GET {META_BASE_URL}/{phone_number_id} e retorna o verified_name do mock', async () => {
  const c = await authed('/api-oficial/accounts', { method: 'POST', body: payload() });
  created.push(c.body.id);
  const r = await authed(`/api-oficial/accounts/${c.body.id}/test`, { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.verified_name, 'Numero de Teste');
  assert.ok(r.body.display_phone_number);
  const { data } = await sb.from('whatsapp_api_accounts').select('verified_name, last_test_ok, last_test_at').eq('id', c.body.id).single();
  assert.equal(data.verified_name, 'Numero de Teste');
  assert.equal(data.last_test_ok, true);
  assert.ok(data.last_test_at);
});

test('T4: "Testar" com phone_number_id inexistente na Meta retorna erro traduzido (nao 500)', async () => {
  const c = await authed('/api-oficial/accounts', { method: 'POST', body: { ...payload(), phone_number_id: `NOPE-${uid(3)}` } });
  created.push(c.body.id);
  const r = await authed(`/api-oficial/accounts/${c.body.id}/test`, { method: 'POST' });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'META_ERROR');
  assert.equal(r.body.code, 100);
  const { data } = await sb.from('whatsapp_api_accounts').select('last_test_ok').eq('id', c.body.id).single();
  assert.equal(data.last_test_ok, false);
});

test('T4: "Registrar" com PIN chama o register do mock e marca a conta como registrada', async () => {
  const p = payload();
  const c = await authed('/api-oficial/accounts', { method: 'POST', body: p });
  created.push(c.body.id);
  const bad = await authed(`/api-oficial/accounts/${c.body.id}/register`, { method: 'POST', body: { pin: '12' } });
  assert.equal(bad.status, 400, 'PIN precisa ter 6 digitos');
  const r = await authed(`/api-oficial/accounts/${c.body.id}/register`, { method: 'POST', body: { pin: '123456' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  const st = await mock('/_state');
  assert.ok(st.body.registered.includes(p.phone_number_id), 'mock marcou o numero como registrado');
  const { data } = await sb.from('whatsapp_api_accounts').select('registered').eq('id', c.body.id).single();
  assert.equal(data.registered, true);
});

test('T4: "Inscrever app" chama subscribed_apps do mock e a lista deixa de estar vazia', async () => {
  const p = payload();
  const c = await authed('/api-oficial/accounts', { method: 'POST', body: p });
  created.push(c.body.id);
  const before = await mock(`/${p.waba_id}/subscribed_apps`, { headers: { Authorization: 'Bearer token-de-teste' } });
  assert.deepEqual(before.body.data, [], 'antes: vazia');
  const r = await authed(`/api-oficial/accounts/${c.body.id}/subscribe`, { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.ok(Array.isArray(r.body.apps) && r.body.apps.length >= 1, 'lista de apps inscritos na resposta');
  const after = await mock(`/${p.waba_id}/subscribed_apps`, { headers: { Authorization: 'Bearer token-de-teste' } });
  assert.ok(after.body.data.length >= 1, 'depois: populada');
  const { data } = await sb.from('whatsapp_api_accounts').select('subscribed').eq('id', c.body.id).single();
  assert.equal(data.subscribed, true);
});

test('T4: remover conta apaga do banco', async () => {
  const c = await authed('/api-oficial/accounts', { method: 'POST', body: payload() });
  const r = await authed(`/api-oficial/accounts/${c.body.id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  const { data } = await sb.from('whatsapp_api_accounts').select('id').eq('id', c.body.id);
  assert.equal(data.length, 0);
  const again = await authed(`/api-oficial/accounts/${c.body.id}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
});

test('T4: pelo Supabase direto (como o front), authenticated NAO le access_token/app_secret', async () => {
  const { anonClient } = await import('./helpers.mjs');
  const c = anonClient();
  const { error: le } = await c.auth.signInWithPassword({ email: SEED.user.email, password: SEED.user.password });
  assert.equal(le, null);
  const ok = await c.from('whatsapp_api_accounts').select('id, label, phone_number_id').limit(1);
  assert.equal(ok.error, null, 'colunas publicas: ' + ok.error?.message);
  const bad = await c.from('whatsapp_api_accounts').select('id, access_token').limit(1);
  assert.ok(bad.error, 'select de access_token deve falhar por permissao');
});
