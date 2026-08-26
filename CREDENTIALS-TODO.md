# CREDENTIALS-TODO.md - O que o Israel vai encaixar depois

O agente constroi tudo com mock. Aqui ficam listados os pontos que, na hora de
ir pra producao, precisam de uma chave ou acao real. Cada `// [PLUG-KEY]` no
codigo deve ter uma linha aqui. O agente ADICIONA itens conforme constroi.

---

## Supabase (trocar local -> producao)

- [x] Projeto de producao criado via CLI em 2026-08-25: **DISPARADOR-B2C**
      (ref `sdnciriewxconxyoehwo`, org "Israel Bugia", sa-east-1).
      Dashboard: https://supabase.com/dashboard/project/sdnciriewxconxyoehwo
- [x] `SUPABASE_URL` = `https://sdnciriewxconxyoehwo.supabase.co` (salvo em `.env.production`, fora do git)
- [x] `SUPABASE_ANON_KEY` (salvo em `.env.production`) -> FALTA colar no topo do `web/index.html` na hora do deploy
- [x] `SUPABASE_SERVICE_KEY` (salvo em `.env.production`) -> FALTA copiar pro `.env` da VPS
- [x] `db/schema.sql` aplicado no projeto de producao via `supabase db query --linked -f db/schema.sql` (2x, idempotente): 9 tabelas, publication realtime, bucket wa-media
- [x] Usuarios atendentes criados em producao (2026-08-26, role=admin nos metadados): juliowcezar22@gmail.com e ibugia08@gmail.com. Novos usuarios: Authentication -> Users -> Add user (Auto Confirm).

## Meta / WhatsApp Cloud API (por conta, cadastrado na tela de Contas)

Trocar `META_BASE_URL` de `http://mock-meta:4000` para
`https://graph.facebook.com` e cadastrar a conta real com:

- [x] App "DISPARADOR B2C" criado (App ID 2120262292702343). App Secret salvo em `.env.meta` (fora do git)
- [x] Numero de TESTE da Meta: Phone Number ID 1316081858247969 (+1 555-201-2180), WABA de teste 1217938763844050
- [x] Access Token de usuario do sistema (expiracao Nunca; escopos whatsapp_business_messaging/management) - validado via debug_token; salvo em `.env.meta`
- [x] Verify Token gerado (em `.env.meta`)
- [x] Conta cadastrada no banco de PRODUCAO (whatsapp_api_accounts) em 2026-08-25
- [x] App ja inscrito na WABA de teste (`subscribed_apps` confirmado via Graph)
- [ ] Numero REAL (comercial): adicionar na WABA comercial, registrar com PIN de 6 digitos e cadastrar como 2a conta no painel
- [x] Webhook registrado na Meta via Graph API (2026-08-26): callback `https://disparador.b2cgestao.com.br/whatsapp/webhook`, campo `messages` ativo
- [ ] URL de Politica de Privacidade publica (pra sair do modo de teste)

## Onde cada chave entra (marcadores `[PLUG-KEY]` no codigo)

| Arquivo | O que trocar |
| --- | --- |
| `web/index.html` (topo do `<script>`) | `SUPABASE_URL` e `SUPABASE_ANON_KEY` do projeto de producao. `API_URL` fica `/api`. |
| `.env` (a partir de `.env.example`) | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service_role), `META_BASE_URL=https://graph.facebook.com`, `META_API_VERSION`. |
| `server/src/index.js` | Nada a editar: le `META_BASE_URL` do ambiente (mock em dev, Graph real em producao). |
| `docker-compose.prod.yml` | `META_BASE_URL` vem do `.env` (default ja e graph.facebook.com). |
| `Caddyfile` | Trocar `painel.exemplo.com.br` pelo dominio real. |
| `db/seed.mjs` | SOMENTE local (usuario/conta de teste). NAO rodar em producao; a conta real e cadastrada na tela de Contas. |
| Tela **Contas** (no painel) | Phone Number ID, WABA ID, App ID, Access Token, App Secret, Verify Token, PIN (botao Registrar). |

## Ordem sugerida pra ir de mock -> producao

1. Supabase: criar projeto, rodar `db/schema.sql`, criar usuarios (Auth).
2. `web/index.html`: colar URL + anon key. `.env`: colar URL + service_role + `META_BASE_URL=https://graph.facebook.com`.
3. VPS + dominio: seguir `DEPLOY.md` (scp + `docker compose -f docker-compose.prod.yml up -d --build`).
4. Meta: cadastrar a conta na tela de Contas -> Testar -> Registrar (PIN) -> Inscrever app; cadastrar webhook `https://<dominio>/whatsapp/webhook` + verify token e assinar `messages`.
5. Templates -> Sincronizar; disparo de teste; responder do celular e conferir o Inbox.

## VPS + dominio (Tarefa T10, DONE em 2026-08-26 via Dokploy)

- [x] VPS Hostinger KVM 4 com Dokploy: IP 179.199.133.18. Dominio `disparador.b2cgestao.com.br` (Cloudflare, registro A -> IP; manter DNS only ate o Let's Encrypt emitir)
- [x] Deploy feito pelo Dokploy (DEPLOY.md secao 0.1). Atualizar = git push na main + Deploy no Dokploy

---

O sistema esta em PRODUCAO em https://disparador.b2cgestao.com.br com o numero de teste da Meta. Local continua 100% mock pra desenvolvimento e testes.
