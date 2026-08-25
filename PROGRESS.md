# PROGRESS.md - Estado da construcao (fonte de verdade no disco)

O agente atualiza este arquivo a cada mudanca de estado de tarefa. Se o contexto
reiniciar, e daqui que voce retoma. Nao apague historico: acrescente.

Formato de cada entrada:
`TX | STATUS | timestamp | nota curta`
STATUS: TODO | IN_PROGRESS | DONE | BLOCKED

---

## Estado atual

- Tarefa em foco: T4 (contas)
- Ultima stack verde: 2026-08-25 16:45 (`./verify.sh t3` = 0)

## Log

- T0  | DONE | 2026-08-25 16:20 | Harness completo: colima+docker+compose instalados via brew; supabase local (6 containers, sem studio/analytics/etc); mock-meta (:4000) emulando Graph + /_simulate/inbound assinado; backend esqueleto (:3000, rawBody, 50MB, auth, metaFetch); schema.sql completo; seed (teste@disparador.local / Teste123! + conta PNID-TEST-0001); verify.sh (smoke|tN|all|up|down, --down). `./verify.sh smoke` verde.
- T1  | DONE | 2026-08-25 16:28 | db/schema.sql idempotente (9 tabelas, RLS select authenticated, grants explicitos, colunas secretas da conta ocultas de authenticated, publication realtime, bucket wa-media publico). test/t1_schema.test.js verde (6 testes).
- T2  | DONE | 2026-08-25 16:33 | Fastify 5 :3000, CORS, bodyLimit 50MB, parser JSON preservando rawBody, auth por JWT do Supabase (requireAuth), metaFetch via META_BASE_URL, /health, /_debug/echo-hmac (so dev). test/t2_backend.test.js verde (6 testes, inclui checagem estatica de rota duplicada).
- T3  | DONE | 2026-08-25 16:45 | web/index.html (1 arquivo, Tailwind+supabase-js via CDN): login Supabase Auth, menu lateral data-view, views inicio/apioficial/config, abas contas/inbox/templates/disparo/fluxos/relatorio, App.api() com JWT, API_URL='/api' (backend faz rewriteUrl tirando /api). Backend serve web/ em `/` localmente. test/t3_front.test.js roda em Chrome headless real via CDP (test/browser.mjs, WebSocket nativo do Node 22, zero deps): 8 testes verdes.
- T4  | IN_PROGRESS | 2026-08-25 16:46 | CRUD de contas + testar/registrar/inscrever contra o mock-meta.
- T5  | TODO | -            | -
- T6  | TODO | -            | -
- T7  | TODO | -            | -
- T8  | TODO | -            | -
- T9  | TODO | -            | -
- T10 | BLOCKED | -         | Deploy real aguarda VPS + dominio + DNS do dono.
- T11 | TODO | -            | -

## Blockers abertos

- BLUEPRINT AUSENTE: o arquivo `BLUEPRINT-Disparador-WhatsApp-API-Oficial.md` nao
  estava na pasta do projeto (nem no disco, nem no Google Drive do dono). A
  construcao segue usando TASKS.md + HARNESS-SETUP.md + CLAUDE.md como
  especificacao (tabelas, endpoints e comportamentos estao descritos la). Quando o
  dono colocar o blueprint na pasta, reconciliar nomes de colunas/telas com ele.

## Notas de tentativas (bugs encontrados e como resolvi)

- T3 | Testar front sem framework: usei Chrome headless (ja instalado na
  maquina) via Chrome DevTools Protocol com o WebSocket nativo do Node 22
  (test/browser.mjs). Ruidos que NAO sao erro e sao filtrados: favicon 404
  (resolvido com favicon inline data:), net::ERR_ABORTED (requests cancelados)
  e o 400 proposital do teste de senha errada. Se nao houver Chrome, defina
  CHROME_BIN.

- T0 | Docker nao existia na maquina (nem Docker Desktop). Instalei `colima`
  + `docker` + `docker-compose` via Homebrew (CLI puro, sem admin). Colima roda
  com `--cpu 2 --memory 3` (maquina tem 8 GB). O supabase CLI precisa de
  `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` (verify.sh exporta).
  `host.docker.internal` funciona no colima tanto por default quanto via
  `extra_hosts: host-gateway` (testado).
- T0 | Seed falhou com `permission denied for table whatsapp_api_accounts` pra
  service_role. Causa: no Supabase CLI 2.111 os default privileges do role
  postgres em `public` dao so TRUNCATE/REFERENCES/TRIGGER pras roles da API.
  Solucao: schema.sql faz `grant select,insert,update,delete ... to service_role`
  e `grant select ... to authenticated` explicitamente por tabela.
- T0 | O blueprint nao esta na pasta; TASKS.md + HARNESS-SETUP.md sao a spec.
- T0 | Supabase CLI 2.111 imprime tambem PUBLISHABLE_KEY/SECRET_KEY (novo
  formato). Usamos os JWTs legados ANON_KEY/SERVICE_ROLE_KEY (sync-env prefere
  eles; cai pro novo formato se nao existirem).
