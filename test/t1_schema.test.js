// T1 - Banco: schema idempotente, 9 tabelas com colunas, publication realtime, bucket wa-media.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { psql, sb } from './helpers.mjs';

const TABLES = {
  whatsapp_api_accounts: ['id', 'label', 'phone_number_id', 'waba_id', 'access_token', 'app_secret', 'verify_token', 'registered', 'subscribed', 'active', 'created_at', 'updated_at'],
  whatsapp_api_sends: ['id', 'account_id', 'job_id', 'list_name', 'phone', 'name', 'template_name', 'variables', 'status', 'wamid', 'error_code', 'error_message', 'created_at'],
  wa_contacts: ['id', 'account_id', 'phone', 'name', 'tags', 'opt_out', 'created_at', 'updated_at'],
  wa_conversations: ['id', 'account_id', 'contact_id', 'status', 'assigned_to', 'unread_count', 'last_message_at', 'window_expires_at', 'created_at', 'updated_at'],
  wa_messages: ['id', 'conversation_id', 'account_id', 'contact_id', 'direction', 'type', 'body', 'media_url', 'wamid', 'status', 'is_flow', 'payload', 'created_at'],
  wa_internal_notes: ['id', 'conversation_id', 'author_id', 'author_email', 'body', 'created_at'],
  wa_templates: ['id', 'account_id', 'meta_id', 'name', 'language', 'category', 'status', 'components', 'synced_at'],
  wa_flows: ['id', 'account_id', 'name', 'trigger_text', 'active', 'steps', 'created_at', 'updated_at'],
  wa_webhook_events: ['id', 'account_id', 'phone_number_id', 'event_type', 'signature_valid', 'payload', 'created_at'],
};

test('T1: schema.sql roda duas vezes seguidas sem erro (idempotencia)', () => {
  assert.doesNotThrow(() => psql(null, { file: 'db/schema.sql' }), 'primeira execucao');
  assert.doesNotThrow(() => psql(null, { file: 'db/schema.sql' }), 'segunda execucao');
});

test('T1: as 9 tabelas existem com as colunas esperadas', () => {
  for (const [table, cols] of Object.entries(TABLES)) {
    const out = psql(`select column_name from information_schema.columns where table_schema='public' and table_name='${table}'`);
    const have = new Set(out.trim().split('\n').filter(Boolean));
    assert.ok(have.size > 0, `tabela ${table} existe`);
    for (const c of cols) assert.ok(have.has(c), `${table}.${c} existe`);
  }
});

test('T1: RLS habilitado e policy de SELECT para authenticated em todas as tabelas', () => {
  for (const table of Object.keys(TABLES)) {
    const rls = psql(`select relrowsecurity from pg_class where relname='${table}' and relnamespace='public'::regnamespace`).trim();
    assert.equal(rls, 't', `RLS em ${table}`);
    const pol = psql(`select count(*) from pg_policies where schemaname='public' and tablename='${table}' and cmd='SELECT' and 'authenticated' = any(roles)`).trim();
    assert.ok(Number(pol) >= 1, `policy select authenticated em ${table}`);
  }
});

test('T1: tabelas wa_* estao na publication supabase_realtime', () => {
  const out = psql(`select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'`);
  const have = new Set(out.trim().split('\n').filter(Boolean));
  for (const t of Object.keys(TABLES).filter((t) => t.startsWith('wa_'))) assert.ok(have.has(t), `${t} na publication`);
});

test('T1: bucket wa-media existe (Storage)', async () => {
  const { data, error } = await sb.storage.getBucket('wa-media');
  assert.equal(error, null, error?.message);
  assert.equal(data.id, 'wa-media');
  assert.equal(data.public, true);
});

test('T1: service_role escreve e authenticated so le; segredos da conta nao vazam pela API', async () => {
  const out = psql(`select privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='wa_messages' and grantee='service_role'`);
  const privs = new Set(out.trim().split('\n'));
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.ok(privs.has(p), `service_role ${p} em wa_messages`);
  const cols = psql(`select column_name from information_schema.column_privileges where table_schema='public' and table_name='whatsapp_api_accounts' and grantee='authenticated' and privilege_type='SELECT'`);
  const visible = new Set(cols.trim().split('\n'));
  assert.ok(!visible.has('access_token') && !visible.has('app_secret'), 'authenticated nao enxerga access_token/app_secret');
  assert.ok(visible.has('label') && visible.has('phone_number_id'), 'authenticated enxerga colunas publicas');
});
