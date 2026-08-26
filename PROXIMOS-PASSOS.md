# PROXIMOS-PASSOS.md - O que o dono faz a partir de agora

Estado em 2026-08-26: EM PRODUCAO em https://disparador.b2cgestao.com.br (Dokploy). Fases 1-5 concluidas com o numero de TESTE da Meta; falta a Fase 6 (primeiro uso) e o numero comercial real.

Estado em 2026-08-25: sistema completo e testado em mock (102 testes verdes).
Banco de PRODUCAO ja criado no Supabase via CLI (projeto `DISPARADOR-B2C`,
ref `sdnciriewxconxyoehwo`, sa-east-1) com o schema aplicado. Chaves em
`.env.production` (fora do git).

Legenda: [VOCE] = so voce pode fazer (conta/pagamento/senha) · [AGENTE] = pode
pedir pro agente fazer.

## Fase 1 - Supabase (FEITO, falta so usuarios)

- [x] Projeto criado, `db/schema.sql` aplicado, Realtime e bucket `wa-media` prontos.
- [ ] [VOCE ou AGENTE] Criar os usuarios atendentes: Dashboard -> Authentication ->
      Users -> Add user (email + senha, marque "Auto Confirm User").
      https://supabase.com/dashboard/project/sdnciriewxconxyoehwo/auth/users
      (ou peca: "cria o usuario X com senha Y no Supabase de producao")

## Fase 2 - Meta / WhatsApp Cloud API [VOCE]

1. https://developers.facebook.com -> Meus apps -> Criar app -> tipo **Empresa**.
2. Adicionar o produto **WhatsApp** ao app e vincular ao Gerenciador de Negocios.
3. Anotar (App -> Configuracoes -> Basico): **App ID** e **App Secret**.
4. WhatsApp -> Configuracao da API: anotar **Phone Number ID** e **WABA ID**
   (use o numero de teste da Meta ou adicione seu numero real).
5. Criar **token de sistema** (Gerenciador de Negocios -> Usuarios do sistema ->
   Adicionar -> Gerar token: app do disparador, expiracao **Nunca**, permissoes
   `whatsapp_business_messaging` + `whatsapp_business_management`). Anotar.
6. Ter em maos o **PIN de 6 digitos** da verificacao em duas etapas do numero.
7. Inventar um **Verify Token** (qualquer frase secreta).
8. Se for usar numero real fora do modo de teste: verificar o negocio e
   publicar uma URL de **Politica de Privacidade**.

## Fase 3 - VPS + dominio [VOCE] - VPS Hostinger KVM 4 com Dokploy JA CONTRATADA (2026-08-26)

Falta so o **dominio**: registro A `painel` -> IP da VPS (ou usar `painel.<IP-com-tracos>.sslip.io` temporario).
Deploy via Dokploy: ver `DEPLOY.md` secao 0.1 (Application a partir do GitHub, Dockerfile da raiz, env do `.env.production`, dominio na porta 3000).

## Fase 3 (original) - VPS + dominio [VOCE]

1. Contratar VPS Linux (Ubuntu 22.04+, 1-2 GB RAM, ex.: Hetzner/DigitalOcean/
   Contabo). Anotar IP publico e liberar portas 22, 80 e 443.
2. No seu dominio, criar registro **A**: `painel` -> IP da VPS
   (ex.: `painel.b2cgestao.com.br`).
3. Ter acesso SSH (root ou usuario com sudo). Se quiser que o agente faca o deploy,
   passe o IP + usuario + chave/senha SSH.

## Fase 4 - Deploy [AGENTE, quando a Fase 3 existir]

1. Ajustar `web/index.html` (topo do script) com a URL + anon key de producao
   (estao em `.env.production`).
2. Trocar `painel.exemplo.com.br` no `Caddyfile` pelo dominio real.
3. Montar o `.env` da VPS a partir de `.env.production` (SUPABASE_URL,
   SUPABASE_SERVICE_KEY, META_BASE_URL=https://graph.facebook.com).
4. Seguir `DEPLOY.md`: instalar Docker na VPS, `scp` de `server/ web/ Caddyfile
   docker-compose.prod.yml .env`, `docker compose -f docker-compose.prod.yml up -d --build`.
5. Conferir `https://<dominio>/health` -> `meta_base_url: https://graph.facebook.com`.

## Fase 5 - Conectar o numero (no painel, 10 minutos) [VOCE]

1. Abrir `https://<dominio>`, logar com o usuario da Fase 1.
2. **WhatsApp API Oficial -> Contas -> + Nova conta**: label, Phone Number ID,
   WABA ID, App ID, Access Token, App Secret, Verify Token -> Salvar.
3. Clicar **Testar** (deve mostrar o nome verificado do numero).
4. Clicar **Registrar** e digitar o PIN de 6 digitos.
5. No painel da Meta (App -> WhatsApp -> Configuracao -> Webhook):
   Callback URL = `https://<dominio>/whatsapp/webhook`, Verify Token = o mesmo
   da conta -> **Verificar e salvar**; depois **assinar o campo `messages`**.
6. Voltar ao painel e clicar **Inscrever app** (sem isso nada chega).
7. **Templates -> Sincronizar**. Criar templates novos se quiser (aprovacao da
   Meta leva de minutos a 24h).

## Fase 6 - Primeiro uso [VOCE]

1. **Disparo**: colar um CSV `telefone,nome` com 2-3 numeros seus -> Disparar ->
   acompanhar a barra -> **Relatorio** (erros vem explicados em portugues).
2. Responder do celular -> ver a conversa aparecer no **Inbox** em tempo real ->
   responder pelo painel (texto so dentro da janela de 24h; fora dela, template).
3. **Fluxos**: criar um fluxo com gatilho = texto do botao de resposta rapida do
   template (ex.: "Quero saber mais") e testar clicando no botao no celular.

## Referencias

- `RELATORIO-FINAL.md` - o que foi construido e a cobertura de testes
- `CREDENTIALS-TODO.md` - onde cada chave entra (`[PLUG-KEY]`)
- `DEPLOY.md` - runbook completo da VPS
- `./verify.sh all` - roda a suite inteira local (`--down` derruba a stack no fim)
