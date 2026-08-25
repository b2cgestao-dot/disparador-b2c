// T0 - smoke: stack no ar (supabase, api, mock-meta), schema aplicado, seed rodou.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, mock, sb, SEED, SUPABASE_URL, SUPABASE_ANON_KEY } from './helpers.mjs';

test('T0: supabase local responde (auth + rest)', async () => {
  const h = await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SUPABASE_ANON_KEY } });
  assert.equal(h.status, 200, 'auth/v1/health');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: { apikey: SUPABASE_ANON_KEY } });
  assert.equal(r.status, 200, 'rest/v1/');
});

test('T0: GET /health do backend responde 200', async () => {
  const r = await api('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.match(r.body.meta_base_url, /mock-meta|localhost|127\.0\.0\.1/, 'backend deve apontar pro mock em teste');
});

test('T0: GET :4000/health do mock-meta responde 200', async () => {
  const r = await mock('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

test('T0: schema aplicado (9 tabelas existem)', async () => {
  const tables = ['whatsapp_api_accounts', 'whatsapp_api_sends', 'wa_contacts', 'wa_conversations',
    'wa_messages', 'wa_internal_notes', 'wa_templates', 'wa_flows', 'wa_webhook_events'];
  for (const t of tables) {
    const { error } = await sb.from(t).select('id', { count: 'exact', head: true });
    assert.equal(error, null, `tabela ${t}: ${error?.message}`);
  }
});

test('T0: seed rodou (usuario de teste + conta de teste)', async () => {
  const { data: list, error } = await sb.auth.admin.listUsers({ perPage: 1000 });
  assert.equal(error, null);
  assert.ok(list.users.some((u) => u.email === SEED.user.email), 'usuario seed existe');
  const { data: acc } = await sb.from('whatsapp_api_accounts').select('id, app_secret').eq('phone_number_id', SEED.account.phone_number_id).single();
  assert.ok(acc?.id, 'conta seed existe');
  assert.equal(acc.app_secret, SEED.account.app_secret);
});
