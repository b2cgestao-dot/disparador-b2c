# RELATORIO-FINAL.md - Disparador WhatsApp (API Oficial)

Construido em modo autonomo em 2026-08-25, 100% com mock (Supabase local +
mock-meta). Nenhuma chave real da Meta e nenhuma VPS foram usadas.

> Observacao: o arquivo `BLUEPRINT-Disparador-WhatsApp-API-Oficial.md` nao
> estava na pasta (nem no Drive). A construcao seguiu `TASKS.md` +
> `HARNESS-SETUP.md` + `CLAUDE.md` como especificacao. Se o blueprint aparecer,
> vale reconciliar nomes de colunas/telas.

## 1. Modulos concluidos

| Tarefa | Status | O que entrega |
| --- | --- | --- |
| T0 Harness | DONE | Colima+Docker, Supabase local (6 containers), mock-meta `:4000`, backend `:3000`, `verify.sh`, seed |
| T1 Banco | DONE | `db/schema.sql` idempotente: 9 tabelas, RLS, grants, publication realtime, bucket `wa-media` |
| T2 Backend | DONE | Fastify 5, CORS, `bodyLimit` 50 MB, `rawBody`, auth por JWT do Supabase, `metaFetch` via `META_BASE_URL` |
| T3 Front | DONE | `web/index.html` unico: login Supabase Auth, menu `data-view`, abas |
| T4 Contas | DONE | CRUD + Testar / Registrar (PIN) / Inscrever app; segredos nunca saem pro front |
| T5 Webhook | DONE | `GET` (hub.challenge) e `POST` com `X-Hub-Signature-256` sobre o corpo cru; contato/conversa/mensagem; midia no Storage; status de entrega |
| T6 Inbox | DONE | Conversas, envio (janela 24h -> `JANELA_FECHADA`), atribuir/liberar/lida/fechar, notas, Realtime |
| T7 Templates | DONE | Sincronizar, listar, criar (cabecalho de midia via upload resumable), cache em `wa_templates` |
| T8 Disparo | DONE | Job em memoria + polling, CSV robusto, opt-out, tag da lista, `sends-report` com erros em PT |
| T9 Fluxos | DONE | Motor por botao QUICK_REPLY, delay, acoes (tag/opt-out/fechar), respeita a janela |
| T10 Deploy | BLOCKED | Artefatos prontos e validados (`Dockerfile`, `docker-compose.prod.yml`, `Caddyfile`, `DEPLOY.md`). Deploy real aguarda VPS + dominio + DNS |
| T11 Relatorio | DONE | Este arquivo + `./verify.sh all` verde + commit final |

## 2. Cobertura de testes por modulo (`node --test`, sem framework externo)

| Modulo | Arquivos | Testes | O que cobre |
| --- | --- | --- | --- |
| T0 | `t0_smoke` | 5 | supabase, `/health` api e mock, 9 tabelas, seed |
| T1 | `t1_schema` | 6 | idempotencia (roda 2x), colunas, RLS, publication, bucket, grants/segredos |
| T2 | `t2_backend` | 6 | health, 2 MB sem 413, rawBody por HMAC, JSON invalido = 400, CORS, sem rota duplicada |
| T3 | `t3_front` (Chrome headless) | 8 | sem erro de console, login seed, views, abas, config, logout |
| T4 | `t4_contas` + `_front` | 14 | CRUD, 401, validacao/409, testar, erro da Meta, registrar PIN, inscrever, segredos ocultos, UI |
| T5 | `t5_webhook` | 9 | challenge, inbound assinado, assinatura invalida 401, midia no bucket, botao, status, dedup wamid, reabrir |
| T6 | `t6_inbox` + `_front` | 14 | dentro/fora da janela, template fora da janela, falha da Meta, estados, notas, listagem, contato, Realtime (Node e navegador) |
| T7 | `t7_templates` + `_front` | 9 | sync sem duplicar, listar, criar, validacao, cabecalho de midia -> Storage -> `header_handle`, seletor alimentado pelo cache |
| T8 | `t8_broadcast` + `_front` | 11 | resposta imediata + percent avancando, opt-out, CSV com aspas, telefone curto, help em PT, template inexistente, cancelar, `/sends` x `/sends-report`, UI |
| T9 | `t9_flows` + `_front` | 10 | CRUD, gatilho por QUICK_REPLY, URL/ligar nao dispara, match_text, delay, acoes, janela 24h, escopo por conta, UI |
| T10 | `t10_deploy` | 7 | artefatos existem, `docker compose config`, `caddy validate`, no-cache na raiz, runbook, BLOCKED registrado |
| T11 | `t11_final` | 3 | tarefas fechadas, relatorio, PROGRESS |
| **Total** | 17 arquivos | **102** | `./verify.sh all` |

Como rodar: `./verify.sh smoke`, `./verify.sh t6`, `./verify.sh all`,
`./verify.sh all --down` (derruba a stack ao final, modo economico).

## 3. O que esta rodando com mock (e como e trocado)

| Componente | Em dev/teste | Em producao | Ponto de troca |
| --- | --- | --- | --- |
| Meta Graph API | `mock-meta` (`http://mock-meta:4000`): numero, register, messages (com gatilhos de erro por sufixo do telefone), templates, subscribed_apps, debug_token, upload resumable, midia, `POST /_simulate/inbound` que assina o webhook com o `app_secret` da conta | `https://graph.facebook.com` | env `META_BASE_URL` (o codigo nunca crava a URL) |
| Supabase (Postgres, Auth, Realtime, Storage) | stack local real do Supabase CLI (`supabase start -x studio,...`) | projeto Supabase de producao | `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` no `.env`; `SUPABASE_URL` + anon no topo do `web/index.html` |
| Conta WhatsApp | conta seed `PNID-TEST-0001` (token/secret falsos) | conta real cadastrada na tela **Contas** | tela de Contas (tokens ficam por conta no banco) |
| Usuario atendente | `teste@disparador.local` / `Teste123!` (seed local) | usuarios criados em Authentication -> Users | painel do Supabase |
| Hospedagem | `docker compose` local (api + mock-meta) + backend servindo `web/` | VPS com `docker-compose.prod.yml` (api + Caddy) | `DEPLOY.md` |

Gatilhos de erro do mock (sufixo do telefone de destino): `0000`=131047 janela,
`0001`=132000 parametros, `0002`=131026 nao entregue, `0003`=131049,
`0004`=130429 rate limit, `0005`=100, `0006`=190 token, `0007`=133010 nao
registrado, `0008`=131051, `0009`=131030, `0010`=132001, `0011`=131056.

## 4. Encaixes de credencial (copiado de CREDENTIALS-TODO.md)

Todos os pontos que precisam de chave/acao real estao marcados no codigo com
`// [PLUG-KEY]` e listados em `CREDENTIALS-TODO.md`:

**Supabase (trocar local -> producao)**
- `SUPABASE_URL` (Project Settings -> API -> Project URL)
- `SUPABASE_ANON_KEY` (anon public) -> topo do `web/index.html`
- `SUPABASE_SERVICE_KEY` (service_role, SECRETA) -> `.env` do backend
- Rodar `db/schema.sql` no SQL Editor do projeto de producao
- Criar o(s) usuario(s) atendente(s) em Authentication -> Users

**Meta / WhatsApp Cloud API (por conta, cadastrado na tela de Contas)**
- `META_BASE_URL=https://graph.facebook.com` no `.env`
- App ID, App Secret, Phone Number ID, WABA ID, Access Token (token de sistema, expiracao Nunca), Verify Token (voce inventa), PIN de 6 digitos
- Cadastrar a URL do webhook na Meta (`https://<dominio>/whatsapp/webhook`) e assinar o campo `messages`
- Inscrever o app na WABA (botao **Inscrever app**) - o passo que destrava tudo
- URL de Politica de Privacidade publica (pra sair do modo de teste)

**VPS + dominio (T10, BLOCKED)**
- Contratar VPS (1-2 GB) e pegar o IP publico
- Registrar dominio + criar registro A `painel` -> IP
- Trocar `painel.exemplo.com.br` no `Caddyfile`
- Rodar o runbook de `DEPLOY.md`

## 5. Passo a passo: mock -> producao

1. **Supabase**: crie o projeto; SQL Editor -> cole `db/schema.sql` -> Run (idempotente, pode repetir); Authentication -> Users -> crie os atendentes.
2. **Front**: em `web/index.html`, topo do `<script>` (`[PLUG-KEY]`): `SUPABASE_URL` e `SUPABASE_ANON_KEY` do projeto. `API_URL` continua `/api`.
3. **Backend**: crie o `.env` de producao a partir de `.env.example`: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `META_BASE_URL=https://graph.facebook.com`, `META_API_VERSION=v21.0`, `NODE_ENV=production`. Nunca commitar.
4. **VPS**: siga `DEPLOY.md` (Docker na VPS, `scp` de `server/ web/ Caddyfile docker-compose.prod.yml .env`, `docker compose -f docker-compose.prod.yml up -d --build`, `curl https://painel.../health` deve mostrar `meta_base_url: https://graph.facebook.com`).
5. **Conta real**: painel -> Contas -> + Nova conta (Phone Number ID, WABA ID, App ID, Access Token, App Secret, Verify Token) -> **Testar** -> **Registrar** (PIN) -> na Meta, cadastrar o webhook `https://<dominio>/whatsapp/webhook` com o mesmo verify token e assinar `messages` -> **Inscrever app**.
6. **Templates**: aba Templates -> Sincronizar. Crie os seus (com botoes de resposta rapida se quiser usar Fluxos).
7. **Teste ponta a ponta**: Disparo com 2-3 numeros permitidos -> responder do celular -> ver no Inbox em tempo real -> conferir o Relatorio.
8. **Fluxos**: crie fluxos com gatilho = texto do botao de resposta rapida do template.

Nada do codigo muda entre mock e producao: sao so as envs, o topo do
`index.html`, o dominio no `Caddyfile` e a conta cadastrada na tela.

## 6. Decisoes tecnicas e licoes (resumo do PROGRESS.md)

- Docker nao existia na maquina: instalado **Colima** + docker CLI + compose v2 via Homebrew (sem GUI/admin). `verify.sh` exporta `DOCKER_HOST` pro Supabase CLI enxergar o Colima.
- Supabase CLI 2.111: default privileges nao dao DML pras roles da API -> o schema faz `grant` explicito por tabela.
- Segredos da conta (`access_token`, `app_secret`) sao invisiveis pra `authenticated` ate via PostgREST (grant por coluna); o backend responde `has_access_token`/`has_app_secret`.
- Front testado em **Chrome headless real** via CDP com o WebSocket nativo do Node 22 (`test/browser.mjs`, zero dependencias).
- O front chama `API_URL='/api'`; o backend remove o prefixo (`rewriteUrl`), entao local e producao (Caddy) usam o mesmo `index.html`.
- Regras anti-bug do CLAUDE.md aplicadas: bodyLimit 50 MB, rawBody, assinatura sobre corpo cru, sem rotas duplicadas (teste estatico), disparo em segundo plano, CSV com aspas + descarte de telefone curto, opt-out pulado, `no-cache` na raiz `/`, `wa_*` na publication, register com PIN, `subscribed_apps`, janela de 24h (`JANELA_FECHADA`).
- Modo economico: `./verify.sh <alvo> --down` derruba `docker compose` e `supabase stop` ao terminar.

## 7. Estrutura final

```
CLAUDE.md TASKS.md PROGRESS.md HARNESS-SETUP.md CREDENTIALS-TODO.md DEPLOY.md RELATORIO-FINAL.md
verify.sh docker-compose.yml docker-compose.prod.yml Caddyfile .env.example package.json
db/schema.sql db/seed.mjs scripts/sync-env.mjs
server/{Dockerfile,package.json,src/index.js}      # backend inteiro (1 arquivo)
mock-meta/{Dockerfile,package.json,src/index.js}   # Meta falsa
web/index.html                                     # front inteiro (1 arquivo)
test/helpers.mjs test/browser.mjs test/t0..t11_*.test.js
supabase/config.toml
```
