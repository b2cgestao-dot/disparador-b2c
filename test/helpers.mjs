// Utilitarios comuns de teste. Tudo roda no HOST contra a stack local.
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { SEED, loadEnv } from '../db/seed.mjs';

loadEnv();
export { SEED };
export const API = (process.env.API_URL_TEST || 'http://127.0.0.1:3000').replace(/\/$/, '');
export const MOCK = (process.env.MOCK_URL_TEST || 'http://127.0.0.1:4000').replace(/\/$/, '');
export const SUPABASE_URL = (process.env.SUPABASE_URL || 'http://127.0.0.1:54321').replace(/\/$/, '');
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// cliente service_role (ignora RLS) pra checar/limpar estado
export const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
// cliente anon (como o front)
export function anonClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const uid = (n = 6) => crypto.randomBytes(n).toString('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function doFetch(base, path, { method = 'GET', body, headers = {}, raw } = {}) {
  const isRaw = raw !== undefined;
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined && !isRaw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: isRaw ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, ok: res.ok, body: json, headers: res.headers };
}
export const api = (path, opts) => doFetch(API, path, opts);
export const mock = (path, opts) => doFetch(MOCK, path, opts);

let cachedToken = null;
export async function login(email = SEED.user.email, password = SEED.user.password) {
  const c = anonClient();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error('login falhou: ' + error.message);
  return data.session.access_token;
}
export async function token() { return (cachedToken ||= await login()); }
export async function authed(path, opts = {}) {
  const t = opts.token || await token();
  return doFetch(API, path, { ...opts, headers: { Authorization: `Bearer ${t}`, ...(opts.headers || {}) } });
}

// conta de teste unica (aponta pro mock via META_BASE_URL do backend)
export async function createTestAccount(overrides = {}) {
  const id = uid(4);
  const row = {
    label: `Conta Teste ${id}`,
    phone_number_id: `PNID-T-${id}`,
    waba_id: `WABA-T-${id}`,
    app_id: 'APP-MOCK',
    access_token: `TOKEN-T-${id}`,
    app_secret: `secret-t-${id}`,
    verify_token: `verify-t-${id}`,
    display_phone: `+55 11 9${id.slice(0, 4)}-0001`,
    active: true,
    ...overrides,
  };
  const { data, error } = await sb.from('whatsapp_api_accounts').insert(row).select('*').single();
  if (error) throw new Error('createTestAccount: ' + error.message);
  return data;
}
export async function deleteAccount(id) {
  await sb.from('whatsapp_api_accounts').delete().eq('id', id);
}
export async function seedAccount() {
  const { data, error } = await sb.from('whatsapp_api_accounts').select('*').eq('phone_number_id', SEED.account.phone_number_id).single();
  if (error) throw new Error('seedAccount: ' + error.message);
  return data;
}

// dispara um inbound assinado a partir do mock-meta -> webhook do backend
export async function simulateInbound(body) {
  const r = await mock('/_simulate/inbound', { method: 'POST', body });
  return r.body;
}
export async function resetMock() { return mock('/_state', { method: 'DELETE' }); }
export async function mockMessages(query = {}) {
  const qs = new URLSearchParams(query).toString();
  const r = await mock('/_state/messages' + (qs ? `?${qs}` : ''));
  return r.body.data || [];
}

// espera ate fn() retornar truthy (ou lancar timeout)
export async function waitFor(fn, { timeout = 5000, interval = 100, label = 'condicao' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`timeout (${timeout}ms) esperando ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

// --- acesso direto ao Postgres local (introspeccao de schema nos testes) ---
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
function dbContainer() {
  const toml = fs.readFileSync(path.resolve(process.cwd(), 'supabase/config.toml'), 'utf8');
  const m = toml.match(/^project_id\s*=\s*"([^"]+)"/m);
  return `supabase_db_${m ? m[1] : 'default'}`;
}
export function dockerEnv() {
  const env = { ...process.env };
  const sock = path.join(os.homedir(), '.colima/default/docker.sock');
  if (!env.DOCKER_HOST && !fs.existsSync('/var/run/docker.sock') && fs.existsSync(sock)) env.DOCKER_HOST = `unix://${sock}`;
  return env;
}
// roda SQL como postgres; retorna stdout (formato -At: uma linha por row, colunas separadas por |)
export function psql(sql, { file } = {}) {
  const args = ['exec', '-i', dbContainer(), 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q'];
  if (file) args.push('-f', '-');
  else args.push('-c', sql);
  return execFileSync('docker', args, { env: dockerEnv(), input: file ? fs.readFileSync(file) : undefined, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
