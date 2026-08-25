# TASKS.md - Backlog do Disparador

Ordem obrigatoria. Cada tarefa e construida ponta a ponta (SQL, backend, front)
e so vira `[x] DONE` quando TODOS os criterios de aceitacao viram teste verde.
Marque o progresso aqui e detalhe no `PROGRESS.md`.

Legenda: `[ ]` pendente, `[~]` em progresso, `[x]` concluido, `[!]` bloqueado.

---

## [x] T0 - Scaffolding do harness

Base pra tudo. Sem isso nao da pra testar nada.

Entrega:
- `git init` e estrutura de pastas (`server/`, `mock-meta/`, `db/`, `test/`, `web/`).
- `docker-compose.yml` local (servico `api` + servico `mock-meta`).
- Stack local do Supabase configurado (`supabase init` + `supabase start`).
- `mock-meta/` no ar em `:4000` (ver HARNESS-SETUP.md).
- `verify.sh` funcional com os alvos `smoke`, `t0..t11`, `all`.
- `.env` e `.env.example`.
- Seed: um usuario de auth de teste + uma conta de teste apontando pro mock.

Aceitacao:
- [x] `./verify.sh smoke` retorna 0.
- [x] `GET /health` do backend responde 200.
- [x] `GET :4000/health` do mock-meta responde 200.
- [x] `supabase status` mostra o stack no ar.
- [x] O schema aplica limpo (ver T1) e o seed roda sem erro.

---

## [x] T1 - Banco (schema idempotente)

Entrega: `db/schema.sql` com todas as tabelas do blueprint secao 5
(`whatsapp_api_accounts`, `whatsapp_api_sends`, `wa_contacts`,
`wa_conversations`, `wa_messages`, `wa_internal_notes`, `wa_templates`,
`wa_flows`, `wa_webhook_events`), RLS `authenticated` para SELECT, tabelas
`wa_*` na publication `supabase_realtime`, bucket `wa-media`.

Aceitacao:
- [x] Rodar o `schema.sql` duas vezes seguidas nao gera erro (idempotencia).
- [x] Todas as 9 tabelas existem com as colunas do blueprint.
- [x] As tabelas `wa_*` estao na publication `supabase_realtime`.
- [x] O bucket `wa-media` existe.

---

## [x] T2 - Backend esqueleto (Fastify)

Entrega: `server/src/index.js` na porta 3000, CORS, parser que preserva
`rawBody`, `bodyLimit` 50 MB, cliente Supabase com service key, leitura de
`META_BASE_URL`, rota `GET /health`.

Aceitacao:
- [x] `GET /health` responde 200 com corpo de status.
- [x] Um POST de corpo com ~2 MB NAO retorna 413.
- [x] O `rawBody` fica disponivel no handler (teste calcula um HMAC do corpo e
      confere que o backend leu o mesmo corpo cru).
- [x] Subir o processo com duas rotas de mesmo nome deve ser impossivel: existe
      um teste/checagem que garante que nao ha rota duplicada.

---

## [x] T3 - Front esqueleto + Auth

Entrega: `web/index.html` (servido estatico), login via Supabase Auth, menu
lateral com `data-view`, `sb`/`API_URL` no topo do script, troca de views por
JS.

Aceitacao:
- [x] A pagina carrega sem erro de console.
- [x] Login com o usuario seed (email/senha) autentica via Supabase local.
- [x] Apos login, o app aparece; sem login, so a tela de login.
- [x] Trocar de item no menu troca a view (`inicio`, `apioficial`, `config`).

---

## [x] T4 - Contas (conectar WhatsApp Oficial)

Entrega: CRUD de `whatsapp_api_accounts` (label, phone_number_id, waba_id,
access_token, app_secret, verify_token). Botoes Testar, Registrar (PIN),
Inscrever app. Tudo contra o mock-meta.

Endpoints: `GET/POST/PATCH/DELETE /api-oficial/accounts(/:id)`,
`POST /api-oficial/accounts/:id/(test|register|subscribe)`.

Aceitacao:
- [x] Criar/editar/remover conta persiste no banco.
- [x] "Testar" chama `GET {META_BASE_URL}/{phone_number_id}` e retorna o
      `verified_name` do mock.
- [x] "Registrar" com PIN chama o register do mock e marca a conta registrada.
- [x] "Inscrever app" chama `subscribed_apps` do mock e a lista deixa de estar
      vazia.
- [x] Access token e app secret NUNCA aparecem em resposta pro front.

---

## [x] T5 - Webhook da Meta (respostas chegando)

Entrega: `GET /whatsapp/webhook` (verificacao com `hub.challenge`) e
`POST /whatsapp/webhook` (acha conta por `phone_number_id`, valida
`X-Hub-Signature-256` sobre `rawBody`, grava contato/conversa/mensagem, salva
midia no Storage, grava evento cru em `wa_webhook_events`).

Aceitacao:
- [x] GET do webhook com o verify_token certo ecoa o `hub.challenge`.
- [x] `POST /_simulate/inbound` do mock (assinado com o app_secret da conta) faz
      a mensagem aparecer em `wa_messages` e criar/atualizar `wa_conversations`
      e `wa_contacts`.
- [x] Assinatura invalida e rejeitada (401/403), sem gravar mensagem.
- [x] Mensagem de midia salva o arquivo no bucket `wa-media` e grava a URL.
- [x] `window_expires_at` da conversa e setado 24h a frente na entrada.

---

## [x] T6 - Inbox multiagente

Entrega: leitura de conversas/mensagens/notas (front le direto do Supabase +
Realtime), e acoes via backend: enviar (com janela 24h), atribuir, liberar,
marcar lida, fechar, notas internas.

Endpoints: `GET /api-oficial/conversations(/:id/messages|/notes)`,
`POST /api-oficial/conversations/:id/(send|assign|release|read|status|notes)`.

Aceitacao:
- [x] Enviar mensagem DENTRO da janela de 24h grava outbound e chama o envio no
      mock-meta.
- [x] Enviar FORA da janela retorna `JANELA_FECHADA` e nao envia texto livre.
- [x] Atribuir/liberar/marcar lida/fechar alteram o estado da conversa.
- [x] Nota interna e gravada em `wa_internal_notes`.
- [x] Uma nova mensagem inbound (via mock) aparece no Realtime (teste
      subscreve e recebe o evento).

---

## [~] T7 - Templates

Entrega: listar/sincronizar templates da Meta (mock) e criar novos, com cache em
`wa_templates`. Cabecalho de midia via upload (mock retorna `header_handle`).

Endpoints: `GET/POST /api-oficial/accounts/:id/templates`,
`GET /api-oficial/accounts/:id/templates-cache`,
`POST /api-oficial/accounts/:id/sync-templates`.

Aceitacao:
- [ ] "Sincronizar" busca do mock e popula `wa_templates`.
- [ ] "Criar template" faz POST no mock e retorna id.
- [ ] Criar com cabecalho de midia sobe pro Storage, o backend reenvia pro mock
      e recebe um `header_handle`.
- [ ] O cache alimenta o seletor de template no disparo.

---

## [ ] T8 - Disparo / Broadcast

Entrega: job em memoria (`broadcastJobs` Map), `POST /api-oficial/broadcast` ->
`{job_id,total}` na hora e `runBroadcast()` nao-awaited; polling em
`GET /api-oficial/broadcast/:jobId`; `GET /api-oficial/sends-report` com
`WA_ERROR_HELP` traduzindo erros pro PT; parse de CSV; nome da lista vira tag;
pula opt-out; variaveis do template por linha.

Aceitacao:
- [ ] `POST /broadcast` responde na hora com `{job_id,total}` e o job roda em
      segundo plano.
- [ ] O polling retorna `{total,sent,failed,skipped,processed,percent,done}` e o
      `percent` avanca ao longo do tempo.
- [ ] Contato com `opt_out=true` e contado em `skipped`, nao enviado.
- [ ] CSV com virgula dentro de aspas e parseado sem embaralhar colunas.
- [ ] Telefone com menos de 10 digitos (ex.: "16") e descartado.
- [ ] `sends-report` retorna `help:{code,motivo,fix}` em PT pros codigos de erro
      simulados pelo mock.
- [ ] Nao existe rota duplicada (`/sends` vs `/sends-report`); o processo sobe.

---

## [ ] T9 - Fluxos (chatbot por botao) - opcional mas incluido

Entrega: `wa_flows` + motor no backend (`waRunFlow`, `waSendFlowStep`,
`waSendAndRecord`, `waApplyActions`). Botao QUICK_REPLY do template dispara o
fluxo; passos com delay e acoes (add_tag/remove_tag/opt_out). Respostas marcadas
como "Fluxo automatico".

Endpoints: `GET/POST/PUT/DELETE /api-oficial/flows(/:id)`.

Aceitacao:
- [ ] Webhook (mock) com clique em botao QUICK_REPLY cujo texto casa um
      `trigger_text` dispara a resposta automatica, gravada como fluxo.
- [ ] Clique em botao de URL/ligar NAO dispara fluxo.
- [ ] Passo com `delay` respeita o atraso antes de enviar.
- [ ] Acao `add_tag`/`opt_out` altera o contato conforme definido.
- [ ] Respostas do fluxo respeitam a janela de 24h.

---

## [!] T10 - Artefatos de deploy (BLOCKED: aguardando VPS)

Entrega (so os artefatos, sem deploy real): `server/Dockerfile` (node 22-alpine),
`docker-compose.prod.yml` (servico api, env, healthcheck, restart
unless-stopped), `Caddyfile` (static + proxy `/api/*` + no-cache na raiz `/`),
`DEPLOY.md` (runbook scp + `docker compose up -d --build`).

Aceitacao:
- [ ] Os quatro artefatos existem e passam num lint/checagem basica de sintaxe.
- [ ] O `Caddyfile` tem `no-cache` cobrindo a raiz `/`.
- [ ] Marcado `BLOCKED` ate o dono ter VPS + dominio + DNS. Registrar isso em
      `CREDENTIALS-TODO.md`.

---

## [ ] T11 - Relatorio final

Entrega: `RELATORIO-FINAL.md` conforme secao 9 do CLAUDE.md. Commit final. PARE.

Aceitacao:
- [ ] Todas as tarefas acima estao `DONE` ou `BLOCKED`.
- [ ] `./verify.sh all` verde pra tudo que nao esta bloqueado.
- [ ] Relatorio gerado com o passo a passo de "mock -> producao".
