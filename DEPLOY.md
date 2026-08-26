# DEPLOY.md - Runbook de producao (VPS + Caddy + Docker)

> Estado: **BLOCKED** ate o dono ter VPS + dominio + DNS (ver `CREDENTIALS-TODO.md`).
> Tudo abaixo esta pronto e testado localmente; so falta a maquina e o dominio.

## 0. O que vai pro ar

| Peca | Onde | Como |
| --- | --- | --- |
| Front | `web/index.html` (1 arquivo) | servido pelo Caddy em `/` (sem cache) |
| Backend | `server/` (Fastify, `server/src/index.js`) | container `api` (porta interna 3000) |
| Proxy/HTTPS | `Caddyfile` + container `caddy` | `/api/*`, `/whatsapp/*`, `/health` -> api |
| Banco/Auth/Realtime/Storage | Supabase (projeto de producao) | `db/schema.sql` no SQL Editor |
| Meta | Graph API real | `META_BASE_URL=https://graph.facebook.com` |

## 0.1 Caminho RECOMENDADO: VPS com Dokploy (Hostinger KVM) - sem Caddy

O Dokploy ja traz Traefik (portas 80/443, HTTPS automatico). Nao suba o Caddy
nele. O `Dockerfile` da RAIZ empacota backend + front num container so; o
backend serve o `index.html` e injeta `SUPABASE_URL`/`SUPABASE_ANON_KEY` do
ambiente (nao precisa editar o arquivo).

1. **DNS**: registro **A** `painel` -> IP da VPS (ex.: `painel.seudominio.com.br`).
   Sem dominio ainda? Use `painel.<IP-com-tracos>.sslip.io` (ex.: `painel.187-77-1-2.sslip.io`)
   como dominio temporario - funciona com HTTPS.
2. Dokploy (`http://IP:3000`) -> **Projects -> Create Project** `disparador`.
3. Dentro do projeto -> **Create Service -> Application**:
   - **Provider**: Git (ou GitHub) -> `https://github.com/b2cgestao-dot/disparador-b2c.git`, branch `main`.
   - **Build Type**: `Dockerfile` -> Dockerfile path `Dockerfile`, build context `.`
4. Aba **Environment** (cole os valores de `.env.production`):
   ```
   NODE_ENV=production
   PORT=3000
   SUPABASE_URL=https://sdnciriewxconxyoehwo.supabase.co
   SUPABASE_ANON_KEY=<anon de .env.production>
   SUPABASE_SERVICE_KEY=<service_role de .env.production>
   META_BASE_URL=https://graph.facebook.com
   META_API_VERSION=v21.0
   ```
5. Aba **Domains -> Add Domain**: host `painel.seudominio.com.br`, **Container Port 3000**,
   HTTPS ligado, certificado Let's Encrypt.
6. **Deploy**. Acompanhe em Logs. Teste: `https://painel.../health` deve mostrar
   `"meta_base_url":"https://graph.facebook.com"`.
7. Siga a secao 5 (conectar a Meta): a conta ja esta cadastrada no banco; falta o webhook
   `https://painel.../whatsapp/webhook` + verify token (em `.env.meta`) e assinar `messages`.
8. Atualizacoes: `git push` na `main` + **Deploy** no Dokploy (ou ligue Auto Deploy por webhook do GitHub).

Recursos: o container usa ~100 MB de RAM; KVM 4 sobra.

## 1. Pre-requisitos (uma vez) - caminho alternativo SEM Dokploy (Caddy)

1. VPS Linux (Ubuntu 22.04+, 1-2 GB RAM) com IP publico. Portas 80 e 443 abertas.
2. Dominio com registro **A** `painel` -> IP da VPS (ex.: `painel.exemplo.com.br`).
3. Na VPS: Docker + Compose v2
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER && newgrp docker
   docker compose version
   ```
4. Projeto Supabase de producao criado. Anote **Project URL**, **anon key** e **service_role key**.

## 2. Preparar o banco (Supabase de producao)

1. SQL Editor -> cole `db/schema.sql` -> Run (pode rodar de novo a qualquer momento; e idempotente).
2. Authentication -> Users -> **Add user** pra cada atendente (email + senha; marque "auto confirm").
3. Confira em Database -> Publications que as tabelas `wa_*` estao em `supabase_realtime` (o schema ja faz isso).

## 3. Preparar os arquivos

Na sua maquina:

1. `web/index.html`, topo do `<script>` ([PLUG-KEY]):
   ```js
   const SUPABASE_URL = 'https://<ref>.supabase.co';
   const SUPABASE_ANON_KEY = '<anon public key>';
   const API_URL = '/api';
   ```
2. `Caddyfile`: troque `painel.exemplo.com.br` pelo seu dominio.
3. Crie um `.env` de producao (NAO commitar):
   ```
   PORT=3000
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_KEY=<service_role>
   META_BASE_URL=https://graph.facebook.com
   META_API_VERSION=v21.0
   NODE_ENV=production
   ```

## 4. Subir (primeira vez)

```bash
# na sua maquina: copia so o necessario
ssh root@IP "mkdir -p /opt/disparador"
scp -r server web Caddyfile docker-compose.prod.yml .env root@IP:/opt/disparador/

# na VPS
ssh root@IP
cd /opt/disparador
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
curl -s https://painel.exemplo.com.br/health
```

O Caddy emite o certificado sozinho na primeira requisicao (precisa do DNS apontando).

## 5. Conectar a Meta (Parte 09 do guia)

1. Abra `https://painel.exemplo.com.br`, faca login, va em **WhatsApp API Oficial -> Contas -> + Nova conta** e preencha: label, Phone Number ID, WABA ID, App ID, Access Token (token de sistema, expiracao Nunca), App Secret, Verify Token (voce inventa).
2. Clique **Testar** (tem que mostrar o nome verificado do numero).
3. Clique **Registrar** e informe o PIN de 6 digitos (erro `133010` = nao registrado).
4. No painel da Meta (App -> WhatsApp -> Configuracao): Callback URL = `https://painel.exemplo.com.br/whatsapp/webhook`, Verify Token = o mesmo da conta, clique **Verificar e salvar**; depois assine o campo **messages**.
5. Volte ao painel e clique **Inscrever app** (isso e o que faz as mensagens chegarem).
6. **Templates -> Sincronizar**. Mande um teste pelo **Disparo**. Responda do celular e veja no **Inbox**.

## 6. Atualizar (deploy de nova versao)

```bash
scp -r server web Caddyfile docker-compose.prod.yml root@IP:/opt/disparador/
ssh root@IP "cd /opt/disparador && docker compose -f docker-compose.prod.yml up -d --build"
```
So mudou o front? Basta `scp web/index.html root@IP:/opt/disparador/web/` (o Caddy serve sem cache).

## 7. Operacao

```bash
docker compose -f docker-compose.prod.yml logs -f api       # logs do backend
docker compose -f docker-compose.prod.yml logs -f caddy     # logs do proxy/TLS
docker compose -f docker-compose.prod.yml restart api
docker compose -f docker-compose.prod.yml down              # parar tudo
```

- Health: `GET /health` (mostra `meta_base_url` em uso - tem que ser graph.facebook.com).
- Backup: o estado vive no Supabase (banco + bucket `wa-media`); use os backups do projeto.
- Disparos em andamento vivem em memoria: um `restart` do api cancela o job atual (o relatorio fica no banco).

## 8. Checklist de go-live

- [ ] `curl https://painel.../health` responde `{"status":"ok",...,"meta_base_url":"https://graph.facebook.com"}`
- [ ] Login funciona com um usuario criado no Supabase de producao
- [ ] Conta real: Testar OK, Registrar OK, Inscrever app OK
- [ ] Webhook verificado na Meta (GET com hub.challenge) e campo `messages` assinado
- [ ] Mensagem enviada do celular aparece no Inbox em tempo real
- [ ] Disparo de teste com 2-3 numeros da lista permitida
