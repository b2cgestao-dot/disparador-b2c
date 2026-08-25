#!/usr/bin/env bash
# ============================================================================
# verify.sh - sobe a stack local (se preciso) e roda os testes de um modulo.
#   ./verify.sh smoke            # stack no ar + health checks (= t0)
#   ./verify.sh t4               # node --test test/t4_*.test.js
#   ./verify.sh all              # suite inteira
#   ./verify.sh <alvo> --down    # roda e derruba a stack ao final (modo economico)
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
}

# --- alvos ------------------------------------------------------------------
NEEDS_STACK=1
case "$TARGET" in
  up)   stack_up; exit 0 ;;
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
