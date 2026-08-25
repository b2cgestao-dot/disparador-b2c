# KICKOFF.md - Como disparar a construcao autonoma

## Passo 1 - Montar a pasta do projeto

Coloque numa pasta nova (ex.: `Documents/Disparador`) TODOS estes arquivos:

```
CLAUDE.md
TASKS.md
PROGRESS.md
HARNESS-SETUP.md
CREDENTIALS-TODO.md
KICKOFF.md
BLUEPRINT-Disparador-WhatsApp-API-Oficial.md   <- o seu .md original
```

Abra o Claude Code dentro dessa pasta.

## Passo 2 - Pre-requisitos na sua maquina

O agente vai usar estes programas. Se nao tiver, peca a ele pra instalar antes:
Docker + Docker Compose v2, Node 22, Supabase CLI, git.

## Passo 3 - Rodar em modo hands-off

Pra ele nao parar pedindo permissao a cada comando, inicie o Claude Code com as
permissoes liberadas. Como e uma stack LOCAL de desenvolvimento (nada em
producao, nada de VPS ainda), o raio de acao fica contido na sua maquina:

```
claude --dangerously-skip-permissions
```

Se preferir mais controle, rode sem essa flag e va aprovando; mas ai nao e
100 por cento hands-off.

## Passo 4 - Colar o prompt de partida (uma vez so)

```
Leia CLAUDE.md inteiro e depois HARNESS-SETUP.md e TASKS.md.

Voce vai construir o sistema do BLUEPRINT-Disparador-WhatsApp-API-Oficial.md em
modo AUTONOMO, seguindo o loop do CLAUDE.md, comecando pela T0 e indo ate a T11.

Regras que voce ja conhece pelo CLAUDE.md e deve seguir sem me perguntar:
- Nao pare pra pedir confirmacao. Construa, teste, conserte e passe pra proxima.
- Tudo com mock: Supabase local + mock-meta. Sem VPS e sem chaves reais da Meta.
- Nenhuma tarefa avanca sem ./verify.sh <id> verde.
- Um commit git por tarefa concluida. Atualize PROGRESS.md a cada passo.
- Se travar num ponto que exige chave/acao minha, implemente o mock, anote em
  CREDENTIALS-TODO.md com um // [PLUG-KEY] e siga.
- So pare quando todas as tarefas estiverem DONE ou BLOCKED, os testes verdes, e
  o RELATORIO-FINAL.md gerado.

Comece agora pela T0. Nao me responda pedindo permissao: apenas comece a
trabalhar e siga ate o fim.
```

## Passo 5 - Se o contexto reiniciar no meio

Se a sessao cair, compactar ou voce fechar e reabrir, cole so isto:

```
Retome o projeto. Faca o bootstrap do CLAUDE.md: leia CLAUDE.md, PROGRESS.md e
TASKS.md, rode ./verify.sh smoke, ache a primeira tarefa nao concluida e
continue de onde parou, em modo autonomo, ate o fim.
```

O PROGRESS.md e os commits garantem que ele sabe onde estava.

## O que esperar no fim

Quando ele parar por conta propria, voce tera:
- Codigo completo (front, back, banco, mock-meta) com os 9 modulos testados.
- `./verify.sh all` verde pra tudo que nao esta bloqueado.
- Artefatos de deploy prontos (Dockerfile, compose de producao, Caddyfile).
- `RELATORIO-FINAL.md` com o passo a passo pra plugar suas chaves e ir ao ar.
- `CREDENTIALS-TODO.md` preenchido com cada encaixe que falta.

Ai e so seguir a Parte 09 do seu guia (conectar a 1a conta real) trocando o
`META_BASE_URL` pro Graph da Meta e cadastrando a conta de verdade.
