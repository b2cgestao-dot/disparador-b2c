# Disparador WhatsApp - API Oficial (Cloud API)

Painel simples pra uma equipe operar o WhatsApp Business API oficial: contas,
inbox multiagente em tempo real, templates, disparo em massa por CSV,
relatorio com erros explicados em portugues e fluxos automaticos por botao.

- Front: 1 arquivo (`web/index.html`, JS puro + Tailwind + supabase-js via CDN)
- Back: 1 arquivo (`server/src/index.js`, Fastify 5)
- Banco/Auth/Realtime/Storage: Supabase (`db/schema.sql`, idempotente)
- Dev/teste: 100% local com Supabase CLI + `mock-meta/` (Meta falsa). Zero chaves reais.

## Quickstart (maquina nova)

```bash
git clone https://github.com/b2cgestao-dot/disparador-b2c.git && cd disparador-b2c
npm run deps      # lista o que falta (node 22, docker + compose v2, supabase cli, git) e como instalar
npm install && (cd server && npm install) && (cd mock-meta && npm install)
npm run dev       # sobe docker/colima + supabase local + schema + seed + api + mock-meta
#  -> painel: http://localhost:3000   login: teste@disparador.local / Teste123!
npm stop          # derruba tudo (modo economico)
```

Testes (102, `node --test`, sem framework externo; os de interface rodam num Chrome instalado):

```bash
./verify.sh smoke        # stack no ar + health checks
./verify.sh t6           # um modulo (t0..t11)
./verify.sh all --down   # suite inteira e derruba a stack no fim
```

## Producao

Leia nesta ordem: [PROXIMOS-PASSOS.md](PROXIMOS-PASSOS.md) (checklist do dono),
[CREDENTIALS-TODO.md](CREDENTIALS-TODO.md) (onde cada chave entra),
[DEPLOY.md](DEPLOY.md) (runbook da VPS com Caddy + Docker).

Arquivos com segredos ficam fora do git e devem ser passados por outro canal:
`.env.production` (Supabase de producao) e `.env.meta` (credenciais da Meta).
O `.env` local e gerado pelo `verify.sh`.

## Documentos do projeto

| Arquivo | Conteudo |
| --- | --- |
| `RELATORIO-FINAL.md` | O que foi construido, cobertura de testes, mocks, passo a passo mock -> producao |
| `TASKS.md` / `PROGRESS.md` | Backlog e log da construcao autonoma (T0..T11) |
| `CLAUDE.md` / `HARNESS-SETUP.md` | Manual do agente e do harness de testes |
