# CREDENTIALS-TODO.md - O que o Israel vai encaixar depois

O agente constroi tudo com mock. Aqui ficam listados os pontos que, na hora de
ir pra producao, precisam de uma chave ou acao real. Cada `// [PLUG-KEY]` no
codigo deve ter uma linha aqui. O agente ADICIONA itens conforme constroi.

---

## Supabase (trocar local -> producao)

- [ ] `SUPABASE_URL` (Project Settings -> API -> Project URL)
- [ ] `SUPABASE_ANON_KEY` (anon public) -> vai no topo do `web/index.html`
- [ ] `SUPABASE_SERVICE_KEY` (service_role, SECRETA) -> `.env` do backend
- [ ] Rodar `db/schema.sql` no SQL Editor do projeto de producao
- [ ] Criar o(s) usuario(s) atendente(s) em Authentication -> Users

## Meta / WhatsApp Cloud API (por conta, cadastrado na tela de Contas)

Trocar `META_BASE_URL` de `http://mock-meta:4000` para
`https://graph.facebook.com` e cadastrar a conta real com:

- [ ] App ID
- [ ] App Secret
- [ ] Phone Number ID (o codigo longo, nao o telefone)
- [ ] WABA ID
- [ ] Access Token (token de sistema, expiracao Nunca)
- [ ] Verify Token (voce inventa)
- [ ] PIN de 6 digitos pra registrar o numero
- [ ] Cadastrar a URL do webhook na Meta e assinar o campo `messages`
- [ ] Inscrever o app na WABA (`subscribed_apps`) - o passo que destrava tudo
- [ ] URL de Politica de Privacidade publica (pra sair do modo de teste)

## VPS + dominio (Tarefa T10, BLOCKED)

- [ ] Contratar VPS (1-2 GB) e pegar o IP publico
- [ ] Registrar dominio + criar registro A `painel` -> IP
- [ ] Chave SSH pro agente acessar o servidor
- [ ] Rodar o runbook de `DEPLOY.md` (Docker + Caddy + subir os containers)

---

Enquanto esses itens estao em aberto, o sistema roda 100 por cento em mock local
e todos os testes passam contra o mock-meta e o Supabase local.
