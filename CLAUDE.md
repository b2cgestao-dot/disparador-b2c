# CLAUDE.md - Manual Operacional do Agente

Este arquivo e carregado automaticamente a cada sessao. Ele governa COMO voce
trabalha neste projeto. Leia inteiro no inicio de toda sessao, sem excecao.

Voce esta construindo o sistema descrito em
`BLUEPRINT-Disparador-WhatsApp-API-Oficial.md`. Esse blueprint e a fonte de
verdade sobre O QUE construir. Este CLAUDE.md e a fonte de verdade sobre COMO
construir de forma autonoma.

---

## 0. RITUAL DE BOOTSTRAP (execute no inicio de TODA sessao)

O contexto pode ser compactado ou reiniciado no meio da construcao. Por isso o
estado real vive no disco, nao na sua memoria. Sempre que uma sessao comecar
(ou logo apos uma compactacao de contexto), faca nesta ordem:

1. Leia este `CLAUDE.md` inteiro.
2. Leia `PROGRESS.md`. Ele diz o que ja foi concluido e o que falta.
3. Leia `TASKS.md`. Ache a PRIMEIRA tarefa nao marcada como `[x] DONE`.
4. Se houver uma tarefa `IN_PROGRESS`, retome ela do ponto em que parou (o
   `PROGRESS.md` tem as notas).
5. Rode `./verify.sh smoke` pra confirmar que a stack local sobe antes de
   continuar. Se nao subir, conserte a stack primeiro.

So depois disso comece a trabalhar. Nunca assuma o estado de cabeca: confirme
no disco.

---

## 1. MODO DE OPERACAO: AUTONOMO

O dono deste projeto NAO vai ficar aprovando passos. Sua missao e levar o
sistema a 100 por cento dos modulos com testes verdes, sozinho.

Regras inegociaveis do modo autonomo:

- NUNCA pergunte "posso continuar?", "quer que eu prossiga?" ou similar. Apenas
  continue.
- NUNCA pare no fim de um modulo esperando resposta. Passe direto pro proximo.
- So existe UMA condicao de parada legitima antes do fim: um bloqueio de
  credencial real que nao da pra mockar (ver secao 4). E mesmo nesse caso, voce
  NAO para: voce implementa o mock/stub, registra o encaixe em
  `CREDENTIALS-TODO.md` e segue.
- A condicao de parada FINAL e: todas as tarefas de `TASKS.md` estao `DONE` ou
  `BLOCKED`, os testes estao verdes, e o relatorio final foi gerado. Ai sim
  voce para e me chama.
- Se ficar em duvida entre parar e seguir, SIGA. O objetivo e progresso
  continuo.

---

## 2. O LOOP POR TAREFA (repita pra cada tarefa de TASKS.md)

Cada tarefa e construida ponta a ponta e so e considerada pronta quando os
testes dela passam. Para cada tarefa:

1. LER. Abra a tarefa em `TASKS.md`, leia os criterios de aceitacao dela e a
   secao correspondente do blueprint.
2. MARCAR. Em `PROGRESS.md`, marque a tarefa como `IN_PROGRESS` com timestamp.
3. CONSTRUIR. Implemente na ordem do blueprint: SQL do banco, depois endpoints
   do backend, depois a tela no front. Respeite a secao 5 (escopo) deste
   arquivo.
4. TESTAR. Escreva os testes automatizados da tarefa em `test/` (ver secao 3) e
   rode `./verify.sh <id-da-tarefa>`.
5. VERIFICAR. Todos os criterios de aceitacao viraram teste verde? Faca tambem
   um smoke manual rapido via curl se fizer sentido.
6. SE FALHOU. Diagnostique, conserte, rode de novo. Ate 5 tentativas por
   tarefa. Registre cada tentativa e o que aprendeu no `PROGRESS.md`.
   - Se apos 5 tentativas ainda falhar, marque a tarefa como `BLOCKED` com a
     causa detalhada, PULE para a proxima tarefa independente e siga. Nunca
     entre em loop infinito na mesma tarefa.
7. SE PASSOU. Marque `[x] DONE` em `TASKS.md`, atualize `PROGRESS.md`, faca um
   commit git (`git add -A && git commit -m "TX: <resumo>"`) e va pra proxima.

Um commit por tarefa concluida. Isso cria pontos de retomada caso o contexto
reinicie.

---

## 3. TESTES = DEFINICAO DE PRONTO

Autonomia so funciona se voce consegue se auto-verificar sem humano. Portanto
nenhuma tarefa avanca sem teste automatizado verde.

- Os testes ficam em `test/tN_nome.test.js` e rodam com o test runner nativo do
  Node (`node --test`). Sem framework externo de teste.
- `./verify.sh <id>` sobe a stack local (se preciso), roda os testes daquele
  modulo e retorna codigo de saida 0 (verde) ou diferente de 0 (vermelho).
- `./verify.sh all` roda a suite inteira. `./verify.sh smoke` roda so o smoke
  (stack sobe, /health responde, mock-meta responde, supabase local responde).
- Todo endpoint que fala com a Meta e testado contra o MOCK-META (secao 4), nao
  contra a Meta real.
- Todo fluxo de "chegou mensagem" e testado disparando um webhook assinado a
  partir do mock-meta (endpoint `POST /_simulate/inbound` do mock).

Regra de ouro: se um criterio de aceitacao nao esta coberto por um teste que
voce roda e ve passar, a tarefa NAO esta pronta.

---

## 4. ESTRATEGIA DE MOCKS (como construir sem as chaves reais)

O dono ainda nao tem VPS nem credenciais da Meta. Voce constroi tudo local e
deixa os "encaixes" prontos. Detalhes de implementacao do scaffolding estao em
`HARNESS-SETUP.md`. Resumo das regras:

- SUPABASE: use o stack LOCAL do Supabase (Supabase CLI, `supabase start`), que
  sobe Postgres + Auth + Realtime + Storage de verdade em Docker. Assim Auth,
  Realtime e Storage sao reais nos testes. Trocar pro Supabase de producao
  depois e so trocar URL + anon key + service_role key.

- META: voce NAO tem credenciais da Meta. Construa um servidor MOCK-META
  (`mock-meta/`) que emula os endpoints do Graph API que o sistema chama
  (dados do numero, register, subscribed_apps, envio de mensagem, templates,
  debug_token, upload de midia). O backend deve chamar a Meta atraves de uma
  variavel `META_BASE_URL`:
  - em teste/dev: `META_BASE_URL=http://mock-meta:4000`
  - em producao: `META_BASE_URL=https://graph.facebook.com`
  Isso e OBRIGATORIO. Nunca cravar `graph.facebook.com` no codigo. O ponto de
  troca pra chave real e essa env + cadastrar a conta real na tela de Contas.

- O mock-meta assina os webhooks de entrada com o MESMO `app_secret` que estiver
  gravado na conta de teste, pra que a validacao de `X-Hub-Signature-256` do
  backend passe de verdade. E isso que permite testar inbox e fluxos ponta a
  ponta sem a Meta.

- VPS / DEPLOY: gere os artefatos (`Dockerfile`, `docker-compose.prod.yml`,
  `Caddyfile`, runbook de deploy), mas NAO tente fazer deploy real. Marque a
  tarefa de deploy como `BLOCKED` com o motivo "aguardando VPS + dominio + DNS".

- Sempre que deixar um ponto que precisa de chave/acao real do dono, marque no
  codigo com um comentario `// [PLUG-KEY] ...` e adicione uma linha em
  `CREDENTIALS-TODO.md` explicando o que ele vai colar e onde.

---

## 5. ESCOPO E RESTRICOES (nao viole)

O blueprint foi recortado pra ser simples de operar por uma pessoa. Manter a
simplicidade e parte da tarefa.

- Front = 1 arquivo `index.html`. JS puro + Tailwind via CDN + Supabase JS via
  CDN. SEM React, Vue, Next, bundler, npm no front. Deploy do front = copiar 1
  arquivo.
- Back = 1 arquivo `server/src/index.js`, Fastify 5, ES modules. Dependencias
  permitidas: `fastify`, `@fastify/cors`, `@supabase/supabase-js`, `pino`. Nada
  alem disso sem necessidade real justificada no PROGRESS.
- NAO adicione ORM, framework de teste externo, TypeScript, monorepo, nem
  "melhore" a arquitetura pra algo mais moderno. A forca e a simplicidade.
- Banco: um `.sql` idempotente que roda no SQL Editor sem erro se rodado duas
  vezes seguidas.
- Single-tenant, multiagente. Tokens da Meta ficam por-conta no banco, nunca no
  front, nunca em env.

---

## 6. REGRAS ANTI-BUG (licoes ja aprendidas - nao redescubra na dor)

Aplique preventivamente. Cada uma dessas ja quebrou o sistema original:

1. Fastify: `bodyLimit: 50 * 1024 * 1024` (50 MB). O default de 1 MB estoura o
   disparo grande com 413.
2. Fastify: registre um content-type parser que PRESERVA o `rawBody`. Sem isso
   a validacao de `X-Hub-Signature-256` do webhook nao funciona.
3. Webhook: valide `X-Hub-Signature-256` sobre o corpo CRU. Ache a conta pelo
   `phone_number_id` do payload.
4. Rotas duplicadas no Fastify derrubam o processo inteiro (crash loop). Antes
   de adicionar uma rota, confira que o nome nao colide (ex.: nao ter
   `/api-oficial/sends` e `/api-oficial/sends-report` conflitando).
5. Disparo: rode em segundo plano (job em memoria + polling do front). Disparo
   sincrono trava o navegador.
6. CSV: respeite aspas (mensagem com virgula dentro) e descarte telefone com
   menos de 10 digitos (senao lixo tipo "16" vira destinatario).
7. Disparo: pule contatos com `opt_out = true`.
8. Caddy: `no-cache` tem que cobrir a raiz `/`, nao so `/index.html`.
9. Realtime so funciona se as tabelas `wa_*` estiverem na publication
   `supabase_realtime`.
10. Meta: numero precisa de `POST /{phone_number_id}/register` com PIN, senao da
    erro `(#133010) Account not registered`. (No mock, o register apenas marca a
    conta como registrada.)
11. Meta: `POST /{waba-id}/subscribed_apps` e o que faz mensagens chegarem.
    Configurar so a URL no painel nao basta. (No mock, popular a lista de apps
    inscritos.)
12. Janela de 24h: fora dela, so template. Dentro dela, texto livre. O envio no
    inbox deve retornar `JANELA_FECHADA` quando expirada.

---

## 7. VARIAVEIS DE AMBIENTE

Backend (`server/.env`, nunca commitar chave real):

```
PORT=3000
SUPABASE_URL=<url do supabase local>
SUPABASE_SERVICE_KEY=<service_role do supabase local>
META_BASE_URL=http://mock-meta:4000
```

Front (`index.html`, topo do script): `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`API_URL = '/api'`. Nunca colocar service_role nem token da Meta no front.

Um `.env.example` deve existir com placeholders e os `[PLUG-KEY]`.

---

## 7.1 MODO ECONOMICO (o dono trabalha em paralelo na mesma maquina)

Durante toda a construcao, minimize o consumo de recursos. Nao deixe a stack
ligada o tempo todo: ela sobe so na hora de testar e cai logo depois.

- Suba o Supabase local SEM os containers desnecessarios pros testes. Rode:
  `supabase start -x studio,imgproxy,edge-runtime,mailpit,logflare,vector,supavisor`
  (mantenha ao menos postgres, gotrue/auth, realtime, storage-api, postgrest, kong).
- Assim que `./verify.sh <id>` de uma tarefa fica verde e o commit e feito,
  DERRUBE a stack: `supabase stop` e `docker compose down`. So suba de novo na
  proxima vez que precisar rodar teste.
- O `verify.sh` deve subir a stack se ela nao estiver no ar e pode derruba-la ao
  final (adicione um modo que faca isso, ex.: `./verify.sh <id> --down`).
- Nao rode watchers, nao deixe `docker compose up` em foreground segurando o
  terminal, nao abra o Supabase Studio. Trabalhe em picos curtos: sobe, testa,
  derruba.
- Se algum teste exigir a stack no ar por varios segundos (ex.: Realtime), tudo
  bem manter no ar durante aquele teste; derrube ao terminar o modulo.

O objetivo: fora dos momentos de teste, o consumo tende a zero.

## 8. COMANDOS DE REFERENCIA

```
./verify.sh smoke              # stack sobe + health checks
./verify.sh t4                 # roda testes do modulo 4 (contas)
./verify.sh t4 --down          # roda e derruba a stack ao terminar (economico)
./verify.sh all                # suite inteira
docker compose up -d           # sobe backend + mock-meta local
docker compose down            # derruba backend + mock-meta
supabase start -x studio,imgproxy,edge-runtime,mailpit,logflare,vector,supavisor
supabase stop                  # derruba o stack local do Supabase
supabase status                # mostra URLs e chaves locais
```

Use `docker compose` (v2), nunca `docker-compose`.

---

## 9. FECHAMENTO

Quando todas as tarefas estiverem `DONE` ou `BLOCKED` e `./verify.sh all` estiver
verde para tudo que nao esta bloqueado:

1. Gere `RELATORIO-FINAL.md` com: modulos concluidos, cobertura de testes por
   modulo, o que esta rodando com mock, a lista de encaixes de credencial
   (copie de `CREDENTIALS-TODO.md`), e o passo a passo pro dono ir de "mock"
   pra "producao".
2. Faca o commit final.
3. Escreva um resumo curto do que foi feito e PARE. Agora sim pode me chamar.