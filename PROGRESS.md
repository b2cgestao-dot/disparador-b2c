# PROGRESS.md - Estado da construcao (fonte de verdade no disco)

O agente atualiza este arquivo a cada mudanca de estado de tarefa. Se o contexto
reiniciar, e daqui que voce retoma. Nao apague historico: acrescente.

Formato de cada entrada:
`TX | STATUS | timestamp | nota curta`
STATUS: TODO | IN_PROGRESS | DONE | BLOCKED

---

## Estado atual

- Tarefa em foco: T9 (fluxos por botao)
- Ultima stack verde: 2026-08-25 18:35 (`./verify.sh t8` = 0)

## Log

- T0  | DONE | 2026-08-25 16:20 | Harness completo: colima+docker+compose instalados via brew; supabase local (6 containers, sem studio/analytics/etc); mock-meta (:4000) emulando Graph + /_simulate/inbound assinado; backend esqueleto (:3000, rawBody, 50MB, auth, metaFetch); schema.sql completo; seed (teste@disparador.local / Teste123! + conta PNID-TEST-0001); verify.sh (smoke|tN|all|up|down, --down). `./verify.sh smoke` verde.
- T1  | DONE | 2026-08-25 16:28 | db/schema.sql idempotente (9 tabelas, RLS select authenticated, grants explicitos, colunas secretas da conta ocultas de authenticated, publication realtime, bucket wa-media publico). test/t1_schema.test.js verde (6 testes).
- T2  | DONE | 2026-08-25 16:33 | Fastify 5 :3000, CORS, bodyLimit 50MB, parser JSON preservando rawBody, auth por JWT do Supabase (requireAuth), metaFetch via META_BASE_URL, /health, /_debug/echo-hmac (so dev). test/t2_backend.test.js verde (6 testes, inclui checagem estatica de rota duplicada).
- T3  | DONE | 2026-08-25 16:45 | web/index.html (1 arquivo, Tailwind+supabase-js via CDN): login Supabase Auth, menu lateral data-view, views inicio/apioficial/config, abas contas/inbox/templates/disparo/fluxos/relatorio, App.api() com JWT, API_URL='/api' (backend faz rewriteUrl tirando /api). Backend serve web/ em `/` localmente. test/t3_front.test.js roda em Chrome headless real via CDP (test/browser.mjs, WebSocket nativo do Node 22, zero deps): 8 testes verdes.
- T4  | DONE | 2026-08-25 17:02 | /api-oficial/accounts CRUD (+/test, /register, /subscribe, /subscribed-apps) com requireAuth; publicAccount() remove access_token/app_secret e expoe has_*; PATCH com segredo vazio mantem o atual; erros da Meta viram 502 META_ERROR {code,message}. Front: aba Contas (tabela, dialog de conta, dialog de PIN, badges). 14 testes verdes (11 API + 3 no Chrome).
- T5  | DONE | 2026-08-25 17:15 | GET /whatsapp/webhook (verify_token de qualquer conta -> ecoa challenge); POST valida X-Hub-Signature-256 sobre rawBody (timingSafeEqual), acha conta por phone_number_id, grava wa_webhook_events (mesmo invalido), upsert contato, abre/reabre conversa (+unread, janela +24h), insere wa_messages (dedup por wamid), baixa midia da Meta pro bucket wa-media (URL publica via SUPABASE_PUBLIC_URL), status delivered/read/failed atualiza wa_messages e whatsapp_api_sends (nao rebaixa status). Gancho waOnInbound pros fluxos (T9). 9 testes verdes.
- T6  | DONE | 2026-08-25 17:50 | /api-oficial/conversations (lista c/ contato+conta, filtros status/assigned/account/search), /:id, /:id/messages, /:id/notes (GET/POST), /:id/(assign|release|read|status|send), PATCH /contacts/:id. waSendAndRecord() compartilhado (texto/template, grava sucesso ou falha em wa_messages, atualiza conversa/contato). Texto fora da janela -> 409 JANELA_FECHADA; template sempre pode. Front: inbox 3 colunas (lista com filtros, thread com bolhas in/out/fluxo/midia/status, composer que troca pra template quando a janela fecha, lateral com contato/tags/opt-out/notas), Realtime em wa_messages e wa_conversations. 14 testes verdes (9 API incl. Realtime em Node + 5 no Chrome).
- T7  | DONE | 2026-08-25 18:05 | GET /accounts/:id/templates (ao vivo, paginado), POST /sync-templates (upsert em wa_templates por account+name+language, remove os que sumiram), GET /templates-cache, POST /templates (valida nome/idioma/categoria/BODY; header_media base64 -> Storage wa-media/templates/... -> upload resumable na Meta (POST /{app_id}/uploads + POST /{upload_id} com Authorization: OAuth) -> header_handle no HEADER -> POST message_templates -> cache). Front: aba Templates (select de conta, Sincronizar, tabela com resumo, dialog de novo template com cabecalho texto/midia, corpo, rodape, ate 3 quick replies + URL). App.templateOptions(accountId) alimenta o composer do inbox (e o disparo na T8). 9 testes verdes.
- T8  | DONE | 2026-08-25 18:35 | POST /broadcast -> 202 {job_id,total,invalid,duplicates} na hora; runBroadcast() nao-awaited (rate 1-50 msg/s); GET /broadcast(/:jobId), POST /:jobId/cancel; GET /sends-report {summary, rows[].help{code,motivo,fix}} com WA_ERROR_HELP (~55 codigos em PT). CSV: aspas, "" escapado, CRLF, BOM, separador , ou ;, cabecalho = 1a linha com letras. Telefone <10 digitos descartado, 10-11 digitos ganha 55, dedup. Nome da lista vira tag no contato; opt_out pulado (skipped + skip_reason); variaveis {{n}} do BODY (e HEADER texto) vem das colunas apos o telefone. Cada envio vira wa_messages out (template_name) + whatsapp_api_sends. Front: aba Disparo (previa validos/invalidos/duplicados, template do cache, progresso por polling, cancelar) e aba Relatorio (filtros, motivo + fix em PT). 11 testes verdes.
- T9  | IN_PROGRESS | 2026-08-25 18:36 | Fluxos: motor waRunFlow/waSendFlowStep/waApplyActions, gatilho por botao QUICK_REPLY, delay, acoes, janela.
- T10 | BLOCKED | -         | Deploy real aguarda VPS + dominio + DNS do dono.
- T11 | TODO | -            | -

## Blockers abertos

- BLUEPRINT AUSENTE: o arquivo `BLUEPRINT-Disparador-WhatsApp-API-Oficial.md` nao
  estava na pasta do projeto (nem no disco, nem no Google Drive do dono). A
  construcao segue usando TASKS.md + HARNESS-SETUP.md + CLAUDE.md como
  especificacao (tabelas, endpoints e comportamentos estao descritos la). Quando o
  dono colocar o blueprint na pasta, reconciliar nomes de colunas/telas com ele.

## Notas de tentativas (bugs encontrados e como resolvi)

- T8 | Deteccao de cabecalho do CSV por "poucos digitos no 1o campo" engolia a
  linha `16,Lixo` (que deveria contar como invalida). Regra final: 1a linha e
  cabecalho se o 1o campo tem letras.
- T8 | Teste com telefone fixo (5511987654321) acumulava envios no mock entre
  execucoes. Asserts de contagem no mock devem usar telefones aleatorios ou
  checar por job_id no banco.

- T6 | `node --test` ficou pendurado (>400s): o cliente Realtime do supabase-js
  mantem o event loop vivo. Solucao: no teste, `removeChannel` +
  `realtime.disconnect()` + um `after()` com `process.exit` agendado (unref).
  macOS nao tem `timeout`; use `perl -e 'alarm N; exec @ARGV' N cmd` como watchdog.
- T6 | CDP `Runtime.evaluate` com returnByValue falha ("Object reference chain
  is too long") se a expressao retorna um objeto circular (ex.: canal
  Realtime). Sempre retornar booleanos/JSON simples nos `page.waitFor`.

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
