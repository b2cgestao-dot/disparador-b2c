// Seed local: cria usuario de auth de teste + conta de teste apontando pro mock-meta.
// Idempotente. Usa a service_role do .env. Exporta SEED pros testes.
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

export const SEED = {
  user: {
    email: process.env.SEED_USER_EMAIL || 'teste@disparador.local',
    password: process.env.SEED_USER_PASSWORD || 'Teste123!',
    name: 'Atendente Teste',
  },
  account: {
    label: 'Conta de Teste (mock-meta)',
    phone_number_id: 'PNID-TEST-0001',
    waba_id: 'WABA-TEST-0001',
    app_id: 'APP-MOCK',
    access_token: 'TOKEN-MOCK-0001',      // [PLUG-KEY] em producao: token de sistema real, cadastrado na tela de Contas
    app_secret: 'mock-app-secret-0001',   // [PLUG-KEY] em producao: App Secret real
    verify_token: 'verify-mock-0001',
    display_phone: '+55 11 99999-0001',
    active: true,
  },
};

export async function runSeed() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY ausentes (.env)');
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // usuario de auth
  const { data: list, error: le } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (le) throw le;
  let user = list.users.find((u) => u.email === SEED.user.email);
  if (!user) {
    const { data, error } = await sb.auth.admin.createUser({
      email: SEED.user.email, password: SEED.user.password, email_confirm: true,
      user_metadata: { name: SEED.user.name },
    });
    if (error) throw error;
    user = data.user;
  }

  // conta de teste
  const { data: acc, error: ae } = await sb.from('whatsapp_api_accounts')
    .upsert(SEED.account, { onConflict: 'phone_number_id' }).select('id, phone_number_id').single();
  if (ae) throw ae;

  return { user_id: user.id, email: user.email, account_id: acc.id, phone_number_id: acc.phone_number_id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSeed().then((r) => { console.log('[seed] ok', JSON.stringify(r)); })
    .catch((e) => { console.error('[seed] ERRO', e.message || e); process.exit(1); });
}
