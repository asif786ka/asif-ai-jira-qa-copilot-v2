#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# run-dev.sh — one-shot local preview
#
# Starts the Next.js frontend (port 3000) and the FastAPI sidecar (port 5001)
# in parallel. Open http://localhost:3000 in your browser.
#
# On first run, installs pnpm deps and creates apps/web/.env.local from the
# template. Re-run any time — installs are skipped when nothing's changed.
# Ctrl-C stops both processes cleanly.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; DIM="\033[2m"; RESET="\033[0m"
log()  { echo -e "${GREEN}▶${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*" >&2; }

# ─── 1. Prerequisite checks ─────────────────────────────────────────────────
log "Checking prerequisites..."
command -v node    >/dev/null || { err "node is not installed. Install Node 20+ from nodejs.org"; exit 1; }
command -v pnpm    >/dev/null || { err "pnpm is not installed. Run: npm install -g pnpm@9"; exit 1; }
command -v python3 >/dev/null || { err "python3 is not installed. Install Python 3.12+"; exit 1; }

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if (( NODE_MAJOR < 20 )); then
  err "Node $NODE_MAJOR detected. Need Node 20+. Try: nvm install 20"
  exit 1
fi
echo -e "  ${DIM}node $(node -v), pnpm $(pnpm -v), python $(python3 -V | awk '{print $2}')${RESET}"

# ─── 2. .env.local bootstrap ────────────────────────────────────────────────
ENV_LOCAL="apps/web/.env.local"
if [[ ! -f "$ENV_LOCAL" ]]; then
  log "Creating $ENV_LOCAL from .env.example..."
  cp .env.example "$ENV_LOCAL"
  # Generate a fresh SESSION_SECRET
  SECRET=$(openssl rand -base64 32 2>/dev/null || python3 -c "import secrets,base64; print(base64.b64encode(secrets.token_bytes(32)).decode())")
  sed -i.bak "s|SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" "$ENV_LOCAL" && rm -f "$ENV_LOCAL.bak"
  warn "Edit $ENV_LOCAL and add OPENAI_API_KEY and/or GEMINI_API_KEY before generating."
fi

# ─── 3a. Clean any dangling symlinks (defends against cross-machine clones) ─
# If any node_modules entry is a symlink whose target doesn't exist on THIS
# machine, remove it so pnpm can recreate it. Common after copying the project
# between machines or after a sandboxed verification step left links behind.
# Disable -e/pipefail for this block: missing search roots are expected and
# must not abort the script.
set +e
set +o pipefail
DANGLERS=""
while IFS= read -r link; do
  if [[ -L "$link" ]] && [[ ! -e "$link" ]]; then
    DANGLERS+="${link}"$'\n'
  fi
done < <(find node_modules packages apps -maxdepth 5 -type l 2>/dev/null)
set -e
set -o pipefail
if [[ -n "$DANGLERS" ]]; then
  warn "Removing dangling symlinks left from a previous environment:"
  printf "%s" "$DANGLERS" | sed 's/^/    /'
  printf "%s" "$DANGLERS" | xargs -r rm -f 2>/dev/null || true
fi

# ─── 3b. pnpm install (only if lockfile or package.json changed) ────────────
INSTALL_STAMP="node_modules/.install-stamp"
NEEDS_INSTALL=false
if [[ ! -d node_modules ]] || [[ ! -f "$INSTALL_STAMP" ]]; then
  NEEDS_INSTALL=true
else
  for f in package.json apps/web/package.json packages/core/package.json packages/providers/package.json pnpm-workspace.yaml; do
    if [[ "$f" -nt "$INSTALL_STAMP" ]]; then
      NEEDS_INSTALL=true
      break
    fi
  done
fi

if $NEEDS_INSTALL; then
  log "Installing JS deps (this may take a minute on first run)..."
  pnpm install
  touch "$INSTALL_STAMP"
else
  echo -e "  ${DIM}JS deps up to date — skipping install${RESET}"
fi

# ─── 4. Python deps ─────────────────────────────────────────────────────────
PY_STAMP="apps/api-python/.install-stamp"
if [[ ! -f "$PY_STAMP" ]] || [[ requirements.txt -nt "$PY_STAMP" ]]; then
  log "Installing Python deps..."
  python3 -m pip install -r requirements.txt --quiet --disable-pip-version-check
  touch "$PY_STAMP"
else
  echo -e "  ${DIM}Python deps up to date — skipping install${RESET}"
fi

# ─── 5. Run both backends in parallel ───────────────────────────────────────
log "Starting backends..."
echo -e "  ${DIM}TypeScript: http://localhost:3000${RESET}"
echo -e "  ${DIM}FastAPI:    http://localhost:5001/pyapi/healthz${RESET}"
echo -e "  ${DIM}Press Ctrl-C to stop both.${RESET}"
echo

cleanup() {
  echo
  log "Stopping..."
  [[ -n "${TS_PID:-}" ]] && kill "$TS_PID" 2>/dev/null || true
  [[ -n "${PY_PID:-}" ]] && kill "$PY_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo -e "${GREEN}Stopped.${RESET}"
}
trap cleanup EXIT INT TERM

# FastAPI sidecar
(
  cd apps/api-python
  exec python3 -m uvicorn api.main:app --host 0.0.0.0 --port 5001 --reload
) &
PY_PID=$!

# Give FastAPI a moment to bind before Next.js dev rewrites kick in
sleep 1

# Next.js
(
  exec pnpm --filter @jiraqa/web dev
) &
TS_PID=$!

wait
