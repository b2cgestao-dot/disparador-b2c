-- ============================================================================
-- Disparador WhatsApp (API Oficial) - schema do banco (Supabase / Postgres)
-- IDEMPOTENTE: pode rodar N vezes no SQL Editor sem erro.
-- Tabelas: whatsapp_api_accounts, whatsapp_api_sends, wa_contacts,
--          wa_conversations, wa_messages, wa_internal_notes, wa_templates,
--          wa_flows, wa_webhook_events
-- ============================================================================
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- funcoes util
create or replace function public.wa_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ------------------------------------------------------ whatsapp_api_accounts
-- Contas da API Oficial (uma por numero). Tokens ficam AQUI, nunca no front.
create table if not exists public.whatsapp_api_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  phone_number_id text not null unique,
  waba_id text,
  app_id text,
  access_token text,          -- SECRETO (token de sistema da Meta)
  app_secret text,            -- SECRETO (assina os webhooks)
  verify_token text,          -- usado no GET /whatsapp/webhook
  display_phone text,
  verified_name text,
  quality_rating text,
  registered boolean not null default false,
  subscribed boolean not null default false,
  active boolean not null default true,
  last_test_at timestamptz,
  last_test_ok boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_wa_accounts_updated on public.whatsapp_api_accounts;
create trigger trg_wa_accounts_updated before update on public.whatsapp_api_accounts
  for each row execute function public.wa_set_updated_at();

-- ------------------------------------------------------------ wa_contacts
create table if not exists public.wa_contacts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.whatsapp_api_accounts(id) on delete cascade,
  phone text not null,                       -- so digitos, com DDI (5511999999999)
  name text,
  tags text[] not null default '{}',
  opt_out boolean not null default false,
  custom jsonb not null default '{}'::jsonb,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, phone)
);
create index if not exists idx_wa_contacts_phone on public.wa_contacts (phone);
create index if not exists idx_wa_contacts_tags on public.wa_contacts using gin (tags);
drop trigger if exists trg_wa_contacts_updated on public.wa_contacts;
create trigger trg_wa_contacts_updated before update on public.wa_contacts
  for each row execute function public.wa_set_updated_at();

-- ------------------------------------------------------------ wa_conversations
create table if not exists public.wa_conversations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.whatsapp_api_accounts(id) on delete cascade,
  contact_id uuid not null references public.wa_contacts(id) on delete cascade,
  status text not null default 'open' check (status in ('open','closed')),
  assigned_to uuid,                          -- auth.users.id do atendente
  assigned_email text,
  assigned_at timestamptz,
  unread_count integer not null default 0,
  last_message_at timestamptz,
  last_message_preview text,
  last_direction text check (last_direction in ('in','out')),
  window_expires_at timestamptz,             -- janela de 24h (ultimo inbound + 24h)
  closed_at timestamptz,
  closed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, contact_id)
);
create index if not exists idx_wa_conversations_status on public.wa_conversations (status, last_message_at desc);
create index if not exists idx_wa_conversations_assigned on public.wa_conversations (assigned_to);
drop trigger if exists trg_wa_conversations_updated on public.wa_conversations;
create trigger trg_wa_conversations_updated before update on public.wa_conversations
  for each row execute function public.wa_set_updated_at();

-- ------------------------------------------------------------ wa_messages
create table if not exists public.wa_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade,
  account_id uuid not null references public.whatsapp_api_accounts(id) on delete cascade,
  contact_id uuid references public.wa_contacts(id) on delete set null,
  direction text not null check (direction in ('in','out')),
  type text not null default 'text',          -- text|image|audio|video|document|sticker|button|interactive|template|location|reaction|unsupported
  body text,
  media_url text,
  media_mime text,
  media_filename text,
  media_path text,                            -- caminho no bucket wa-media
  wamid text,
  status text not null default 'received',    -- received|accepted|sent|delivered|read|failed
  error jsonb,
  sent_by uuid,                               -- atendente (auth.users.id) se outbound humano
  sent_by_email text,
  is_flow boolean not null default false,     -- "Fluxo automatico"
  flow_id uuid,
  template_name text,
  payload jsonb,                              -- payload cru (inbound) ou request (outbound)
  created_at timestamptz not null default now()
);
create unique index if not exists idx_wa_messages_wamid on public.wa_messages (wamid) where wamid is not null;
create index if not exists idx_wa_messages_conv on public.wa_messages (conversation_id, created_at);
alter table public.wa_messages replica identity full;

-- ------------------------------------------------------------ wa_internal_notes
create table if not exists public.wa_internal_notes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade,
  author_id uuid,
  author_email text,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_wa_notes_conv on public.wa_internal_notes (conversation_id, created_at);

-- ------------------------------------------------------------ wa_templates (cache)
create table if not exists public.wa_templates (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.whatsapp_api_accounts(id) on delete cascade,
  meta_id text,
  name text not null,
  language text not null,
  category text,
  status text,
  components jsonb not null default '[]'::jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (account_id, name, language)
);

-- ------------------------------------------------------------ wa_flows
create table if not exists public.wa_flows (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.whatsapp_api_accounts(id) on delete cascade, -- null = todas as contas
  name text not null,
  trigger_text text not null,                 -- texto do botao QUICK_REPLY (ou payload) que dispara
  active boolean not null default true,
  steps jsonb not null default '[]'::jsonb,   -- [{ type:'text', text, delay_s, actions:[{type:'add_tag',tag}|{type:'remove_tag',tag}|{type:'opt_out'}] }]
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_wa_flows_updated on public.wa_flows;
create trigger trg_wa_flows_updated before update on public.wa_flows
  for each row execute function public.wa_set_updated_at();

-- ------------------------------------------------------------ wa_webhook_events (cru)
create table if not exists public.wa_webhook_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.whatsapp_api_accounts(id) on delete set null,
  phone_number_id text,
  event_type text,                            -- messages|statuses|unknown
  signature_valid boolean,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_wa_webhook_events_created on public.wa_webhook_events (created_at desc);

-- ------------------------------------------------------------ whatsapp_api_sends (log de disparo)
create table if not exists public.whatsapp_api_sends (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.whatsapp_api_accounts(id) on delete set null,
  job_id text,
  list_name text,
  phone text,
  name text,
  template_name text,
  template_language text,
  variables jsonb,
  status text not null default 'queued',      -- queued|sent|failed|skipped
  skip_reason text,
  wamid text,
  error_code integer,
  error_message text,
  error jsonb,
  sent_by uuid,
  sent_by_email text,
  created_at timestamptz not null default now()
);
create index if not exists idx_wa_sends_job on public.whatsapp_api_sends (job_id);
create index if not exists idx_wa_sends_created on public.whatsapp_api_sends (created_at desc);

-- ============================================================================
-- RLS: authenticated pode LER (o front le direto do Supabase); escrita so pelo
-- backend (service_role, que ignora RLS).
-- ============================================================================
-- Grants explicitos (nao dependemos dos default privileges do projeto: em
-- versoes recentes do Supabase local eles NAO dao DML pras roles da API).
grant usage on schema public to anon, authenticated, service_role;
do $$
declare t text;
begin
  foreach t in array array['whatsapp_api_accounts','whatsapp_api_sends','wa_contacts','wa_conversations',
                           'wa_messages','wa_internal_notes','wa_templates','wa_flows','wa_webhook_events']
  loop
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select_authenticated', t);
  end loop;
end $$;
grant execute on function public.wa_set_updated_at() to service_role, authenticated;

-- Segredos das contas NUNCA saem pro front: tira o SELECT de tabela e devolve
-- so nas colunas publicas (anon nao enxerga nada).
revoke select on public.whatsapp_api_accounts from anon, authenticated;
grant select (id, label, phone_number_id, waba_id, app_id, verify_token, display_phone, verified_name,
              quality_rating, registered, subscribed, active, last_test_at, last_test_ok, created_at, updated_at)
  on public.whatsapp_api_accounts to authenticated;

-- ============================================================================
-- Realtime: tabelas wa_* na publication supabase_realtime (anti-bug #9)
-- ============================================================================
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['wa_contacts','wa_conversations','wa_messages','wa_internal_notes','wa_templates','wa_flows','wa_webhook_events']
  loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ============================================================================
-- Storage: bucket wa-media (midias recebidas/enviadas), publico pra leitura
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('wa-media', 'wa-media', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "wa-media leitura publica" on storage.objects;
create policy "wa-media leitura publica" on storage.objects
  for select using (bucket_id = 'wa-media');

-- ============================================================================
-- Evolucoes (add column if not exists mantem a idempotencia)
-- ============================================================================
alter table public.whatsapp_api_sends add column if not exists delivery_status text; -- accepted|sent|delivered|read|failed (via webhook de status)
alter table public.wa_flows add column if not exists match_text boolean not null default false; -- true = texto digitado igual ao gatilho tambem dispara
-- 9o digito BR: a Meta identifica numeros brasileiros pelo formato SEM o 9 (wa_id). Guardamos os dois.
alter table public.wa_contacts add column if not exists wa_id text;
create index if not exists idx_wa_contacts_wa_id on public.wa_contacts (account_id, wa_id);
-- Midia padrao do cabecalho de template (imagem/video/documento) usada nos envios
alter table public.wa_templates add column if not exists header_media_url text;
alter table public.wa_templates add column if not exists header_media_path text;
alter table public.wa_templates add column if not exists header_media_filename text;
