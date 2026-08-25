# HARNESS-SETUP.md - Como montar o scaffolding de teste (Tarefa T0)

Este arquivo detalha o que voce constroi na T0 pra que todos os outros modulos
sejam testaveis sozinhos, sem VPS e sem credenciais da Meta. Implemente exatamente
o comportamento descrito. Os nomes de arquivo sao sugestoes; o comportamento nao e.

---

## 1. Estrutura de pastas

```
/  (raiz do projeto)
├── CLAUDE.md
├── TASKS.md
├── PROGRESS.md
├── HARNESS-SETUP.md
├── CREDENTIALS-TODO.md
├── BLUEPRINT-Disparador-WhatsApp-API-Oficial.md
├── verify.sh
├── docker-compose.yml            # local: api + mock-meta
├── .env / .env.example
├── db/
│   ├── schema.sql                # T1, idempotente
│   └── seed.mjs                  # cria usuario de auth + conta de teste
├── server/
│   ├── Dockerfile
│   ├── package.json
│   └── src/index.js              # o backend inteiro
├── mock-meta/
│   ├── Dockerfile
│   ├── package.json
│   └── src/index.js              # o Meta falso
├── web/
│   └── index.html                # o front inteiro
└── test/
    ├── helpers.mjs               # utilitarios comuns de teste
    ├── t2_backend.test.js
    ├── t4_contas.test.js
    └── ...                       # um arquivo por modulo
```

---

## 2. Supabase local

Use o Supabase CLI pra subir o stack real localmente:

```
supabase init
supabase start
supabase status         # imprime API URL, anon key, service_role key locais
```

- Pegue `SUPABASE_URL`, anon e service_role do `supabase status` e escreva no
  `.env` (backend) e no topo do `web/index.html` (URL + anon).
- Aplique `db/schema.sql` via `supabase db execute` ou psql na porta local.
- `db/seed.mjs` usa a service_role pra: criar um usuario de auth de teste
  (`teste@local` / senha conhecida) via admin API, e inserir uma conta de teste
  em `whatsapp_api_accounts` com `phone_number_id`, `waba_id`, `app_secret` e
  `verify_token` conhecidos, apontando implicitamente pro mock via `META_BASE_URL`.

Se o ambiente nao tiver o Supabase CLI, instale-o antes (documentar no
PROGRESS). O objetivo e ter Auth, Realtime e Storage REAIS nos testes.

---

## 3. mock-meta (o Meta falso) - `:4000`

Servidor Node simples (pode ser Fastify tambem) que emula o Graph API. Ele NAO
precisa ser fiel a tudo; precisa ser fiel ao que o backend consome. Endpoints:

Emulacao do Graph:
- `GET /health` -> 200.
- `GET /:phoneNumberId` -> `{ id, verified_name: "Numero de Teste", ... }`.
- `POST /:phoneNumberId/register` -> `{ success: true }` e guarda em memoria que
  o numero foi registrado.
- `POST /:phoneNumberId/messages` -> `{ messages: [{ id: "wamid.MOCK-<rand>" }] }`.
  Deve conseguir simular erros: se o texto/variavel contiver um gatilho especial
  (ex.: numero de destino terminando em `0000`), retornar um erro no formato da
  Meta com um `error.code` conhecido (ex.: 131047, 132000) pra exercitar o
  `WA_ERROR_HELP` do T8.
- `GET /:wabaId/message_templates` -> lista de templates de exemplo (incluindo um
  com botao QUICK_REPLY, pra T9, e um `hello_world`).
- `POST /:wabaId/message_templates` -> `{ id: "tpl-MOCK-<rand>" }`.
- `POST /:wabaId/subscribed_apps` -> `{ success: true }`, marca o app como
  inscrito.
- `GET /:wabaId/subscribed_apps` -> lista (vazia antes do POST, populada depois).
- `GET /debug_token` -> `{ data: { app_id: "APP-MOCK" } }`.
- Endpoints de upload resumable (o minimo pro fluxo de midia de template):
  iniciar upload -> retorna um id; enviar bytes -> retorna `{ h: "HANDLE-MOCK" }`
  usado como `header_handle`.

Ponto-chave (linchpin dos testes de inbox e fluxo):
- `POST /_simulate/inbound` (endpoint SO de teste). Recebe
  `{ phone_number_id, from, type, text|button_payload, ... }`. O mock monta um
  payload de webhook no formato da Meta, calcula `X-Hub-Signature-256 =
  "sha256=" + HMAC_SHA256(rawBody, app_secret_da_conta)` usando o `app_secret`
  gravado na conta de teste, e faz `POST` pro webhook do backend
  (`http://api:3000/whatsapp/webhook`). E assim que voce simula "o lead
  respondeu" ou "o lead clicou no botao" de forma que a validacao de assinatura
  do backend passe de verdade.

O mock guarda estado em memoria (mapas). Reinicio zera. Tudo bem.

---

## 4. Ligacao backend <-> mock

- O backend chama a Meta SEMPRE via `process.env.META_BASE_URL`. Em dev/teste
  isso e `http://mock-meta:4000`; em producao, `https://graph.facebook.com`.
- O mock precisa saber o `app_secret` e o `verify_token` da conta pra assinar os
  inbounds. Ele pode ler do mesmo Supabase (com a service key), ou receber no
  corpo do `/_simulate/inbound`. Prefira ler do banco pra ficar fiel.

---

## 5. verify.sh

Script bash. Contrato:

```
./verify.sh smoke   # garante stack no ar; testa /health do api e do mock e
                    # supabase status; retorna 0/!=0
./verify.sh t4      # roda: node --test test/t4_*.test.js
./verify.sh all     # roda: node --test test/*.test.js
```

Comportamento:
1. Se a stack nao estiver no ar, sobe (`supabase start` se preciso;
   `docker compose up -d`).
2. Espera os healthchecks (`/health` do api e do mock-meta) responderem.
3. Roda os testes do alvo pedido com o test runner nativo do Node.
4. Propaga o codigo de saida dos testes (0 verde, !=0 vermelho). Isso e o que o
   agente le pra decidir avancar ou consertar.

---

## 6. Convencoes de teste (`test/*.test.js`)

- Use `node:test` e `node:assert/strict`. Sem framework externo.
- `helpers.mjs` exporta: cliente supabase (service) pra checar/limpar estado,
  base URL do api, base URL do mock, funcao pra criar conta de teste, funcao pra
  disparar `/_simulate/inbound`, e uma funcao de login que pega um JWT do
  Supabase Auth local pra chamar endpoints autenticados.
- Cada teste e independente: cria o proprio estado, checa, e limpa (ou usa ids
  unicos). Nao dependa da ordem entre arquivos.
- Testes de Realtime: subscreva no canal, dispare o evento, aguarde o callback
  com timeout, faca assert. Se o Realtime local demorar, de um timeout generoso
  (ex.: 5s) antes de falhar.

---

## 7. Definicao de "stack no ar" pro smoke

`./verify.sh smoke` so retorna 0 quando:
- `supabase status` ok,
- `GET http://localhost:3000/health` = 200,
- `GET http://localhost:4000/health` = 200,
- `schema.sql` ja aplicado (as tabelas existem),
- `seed.mjs` ja rodou (usuario de teste e conta de teste existem).

Com isso pronto, T1 em diante tem onde rodar.
