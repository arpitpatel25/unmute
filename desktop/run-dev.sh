#!/usr/bin/env bash
# Dev launcher for the wrapped engine.
#
# WHY THIS EXISTS: the renderer's Supabase client reads __SUPABASE_URL__ /
# __SUPABASE_ANON_KEY__, which the vite config injects from env vars. The
# production DMG sets them at build time; a bare `npm run dev` does NOT, so
# createClient("") throws "supabaseUrl is required" and the WHOLE renderer
# renders blank. Sourcing .env.dev first fixes that.
#
# Usage:  ./run-dev.sh
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env.dev ]]; then
  echo "[run-dev] sourcing .env.dev"
  set -a; source .env.dev; set +a
else
  echo "[run-dev] WARN: no .env.dev — cloud sign-in will be disabled (Local/BYOK/Remote still work)"
fi

exec ./build/wire-into-engine.sh dev
