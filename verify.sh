#!/usr/bin/env bash
# ============================================================================
# verify.sh - sobe a stack local (se preciso) e roda os testes de um modulo.
#   ./verify.sh smoke            # stack no ar + health checks (= t0)
#   ./verify.sh t4               # node --test test/t4_*.test.js
#   ./verify.sh all              # suite inteira
#   ./verify.sh <alvo> --down    # roda e derruba a stack ao final (modo economico)
#   ./verify.sh deps             # lista dependencias que faltam (com comando de instalacao)
#   ./verify.sh up | down        # so sobe / so derruba
# Saida: 0 = verde, != 0 = vermelho.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"
TARGET="${1:-all}"; shift || true
DOWN=0; for a in "$@"; do [ "$a" = "--down" ] && DOWN=1; done
SB_EXCLUDE="studio,imgproxy,edge-runtime,mailpit,logflare,vector,supavisor"
SB_DB_CONTAINER="supabase_db_$(grep -E '^project_id' supabase/config.toml | sed -E 's/.*= *"(.*)"/\1/')"
COLIMA_ARGS="--cpu 2 --memory 3 --disk 30"

log() { echo "[verify] $*"; }
die() { echo "[verify] ERRO: $*" >&2; exit 1; }

# --- docker (colima) --------------------------------------------------------
if [ -z "${DOCKER_HOST:-}" ] && [ ! -S /var/run/docker.sock ] && [ -S "$HOME/.colima/default/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
fi
ensure_docker() {
  if ! docker info >/dev/null 2>&1; then
    command -v colima >/dev/null || die "docker nao disponivel e colima nao instalado (brew install colima docker docker-compose)"
    log "docker fora do ar; subindo colima ($COLIMA_ARGS)"
    colima start $COLIMA_ARGS >/dev/null 2>&1 || die "colima start falhou"
    export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
    docker info >/dev/null 2>&1 || die "docker continua fora do ar"
  fi
}

# --- supabase local ---------------------------------------------------------
supabase_up() { supabase status >/dev/null 2>&1; }
ensure_supabase() {
  if ! supabase_up; then
    log "subindo supabase local (sem: $SB_EXCLUDE)"
    supabase start -x "$SB_EXCLUDE" >/dev/null || die "supabase start falhou"
  fi
  node scripts/sync-env.mjs || die "sync-env falhou"
}
apply_schema() {
  log "aplicando db/schema.sql (idempotente)"
  docker exec -i "$SB_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f - < db/schema.sql \
    || die "schema.sql falhou"
}
run_seed() {
  log "rodando seed"
  node db/seed.mjs || die "seed falhou"
}

# --- api + mock-meta --------------------------------------------------------
wait_http() { # url, segundos
  local url="$1" secs="${2:-60}" i=0
  while [ $i -lt "$secs" ]; do
    if curl -fsS -m 2 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1; i=$((i+1))
  done
  return 1
}
ensure_compose() {
  log "docker compose up -d --build"
  docker compose up -d --build --quiet-pull >/dev/null 2>&1 || { docker compose up -d --build; die "docker compose up falhou"; }
  wait_http http://127.0.0.1:4000/health 60 || { docker compose logs --tail 40 mock-meta; die "mock-meta nao respondeu /health"; }
  wait_http http://127.0.0.1:3000/health 60 || { docker compose logs --tail 40 api; die "api nao respondeu /health"; }
  log "api :3000 e mock-meta :4000 no ar"
}

stack_up() {
  ensure_docker
  ensure_supabase
  apply_schema
  run_seed
  ensure_compose
}
stack_down() {
  log "derrubando stack (docker compose down + supabase stop)"
  docker compose down --remove-orphans >/dev/null 2>&1 || true
  supabase stop >/dev/null 2>&1 || true
  # colima (se for o daemon em uso): para a VM pra liberar RAM/CPU
  if command -v colima >/dev/null 2>&1 && [ "${DOCKER_HOST:-}" = "unix://$HOME/.colima/default/docker.sock" ]; then
    colima stop >/dev/null 2>&1 || true
  fi
}

# --- dependencias -----------------------------------------------------------
check_deps() {
  local missing=0 os="linux"; [ "$(uname -s)" = "Darwin" ] && os="mac"
  have() { command -v "$1" >/dev/null 2>&1; }
  row() { printf '  %-14s %s\n' "$1" "$2"; }
  echo "[deps] sistema: $(uname -s) $(uname -m)"
  if have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then row node "ok ($(node -v))"; else row node "FALTA (precisa >= 22)"; missing=1; fi
  if have npm; then row npm "ok"; else row npm "FALTA"; missing=1; fi
  if have git; then row git "ok"; else row git "FALTA"; missing=1; fi
  if have docker; then row docker "ok ($(docker --version | sed 's/,.*//'))"; else row docker "FALTA"; missing=1; fi
  if have docker && docker compose version >/dev/null 2>&1; then row "compose v2" "ok"; else row "compose v2" "FALTA (plugin 'docker compose')"; missing=1; fi
  if have docker && docker info >/dev/null 2>&1; then row "docker daemon" "rodando"; elif have colima; then row "docker daemon" "parado (o verify.sh sobe o colima sozinho)"; else row "docker daemon" "parado/ausente"; fi
  if have supabase; then row supabase "ok ($(supabase --version 2>/dev/null))"; else row supabase "FALTA (Supabase CLI)"; missing=1; fi
  if [ -n "${CHROME_BIN:-}" ] || [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] || have google-chrome || have chromium || have chromium-browser; then row chrome "ok"; else row chrome "ausente (so os testes de front precisam)"; fi
  if [ "$missing" = 1 ]; then
    echo
    echo "[deps] Como instalar o que falta:"
    if [ "$os" = "mac" ]; then
      echo "  brew install node@22 git supabase/tap/supabase"
      echo "  brew install colima docker docker-compose        # docker sem Docker Desktop"
      echo "  mkdir -p ~/.docker && echo '{\"cliPluginsExtraDirs\":[\"/opt/homebrew/lib/docker/cli-plugins\"]}' > ~/.docker/config.json"
      echo "  colima start --cpu 2 --memory 3                  # (o verify.sh tambem faz isso)"
    else
      echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git"
      echo "  curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker \$USER && newgrp docker"
      echo "  curl -fsSL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.deb -o /tmp/supabase.deb && sudo dpkg -i /tmp/supabase.deb"
    fi
    echo "  (Chrome so e necessario pros testes de interface: t3, t4, t6, t7, t8, t9)"
    return 1
  fi
  echo "[deps] tudo instalado."
}

# --- alvos ------------------------------------------------------------------
NEEDS_STACK=1
case "$TARGET" in
  deps) check_deps; exit $? ;;
  up)   check_deps || exit 1; stack_up; echo "[verify] painel local: http://localhost:3000  (login: teste@disparador.local / Teste123!)"; exit 0 ;;
  down) stack_down; exit 0 ;;
  t10|t11) NEEDS_STACK=0 ;;
esac

[ "$NEEDS_STACK" = 1 ] && stack_up

case "$TARGET" in
  smoke|t0) FILES=(test/t0_*.test.js) ;;
  all)      FILES=(test/*.test.js) ;;
  t[0-9]|t1[0-1]) FILES=(test/${TARGET}_*.test.js) ;;
  *) die "alvo desconhecido: $TARGET (use smoke|t0..t11|all|up|down)" ;;
esac
if [ ! -e "${FILES[0]}" ]; then die "nenhum arquivo de teste para o alvo $TARGET (${FILES[*]})"; fi

log "rodando: node --test ${FILES[*]}"
node --test --test-concurrency=1 "${FILES[@]}"
CODE=$?

[ "$DOWN" = 1 ] && stack_down
if [ $CODE -eq 0 ]; then log "VERDE ($TARGET)"; else log "VERMELHO ($TARGET) exit=$CODE"; fi
exit $CODE
