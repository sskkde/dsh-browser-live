#!/usr/bin/env bash
# Recreate the peer-dependency symlink farm inside this plugin workspace.
#
# The dsh-app-boot resolution closure resolves a linked plugin's bare imports
# by walking node_modules up from the plugin's REAL path. For this
# link:-installed plugin that is the workspace, which sits outside the
# profile tree — so its peerDependencies would never reach
# `resolution.entries` and every import would fail at harness boot
# ("browser-live: failed to import"). The fix is a node_modules of symlinks
# to the SAME copies the harness/profile use (single module instances, no
# version drift).
#
# Run once after cloning/moving this workspace (or after changing the peer
# list), then restart the harness. See README "Linked-plugin resolution".
set -euo pipefail

WS="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
FARM="$DSH_HOME/profiles/node_modules"           # harness-bundled peer farm
PROFILE="${DSH_PROFILE:-web}"                    # profile carrying this plugin
PROF="$DSH_HOME/profiles/$PROFILE/node_modules"

# name  preferred-source-dir  fallback-source-dir
PEERS=(
  "@deepseek-ai/cordis|$FARM|$PROF"
  "@deepseek-ai/schemastery|$FARM|$PROF"
  "@deepseek-ai/dsh-tools|$FARM|$PROF"
  "@deepseek-ai/dsh-mcp-client|$FARM|$PROF"
  "@deepseek-ai/dsh-scope|$FARM|$PROF"
  "@deepseek-ai/dsh-experimental-browser-use-runtime|$FARM|$PROF"
  "@deepseek-ai/dsh-browser-use|$FARM|$PROF"
  "@playwright/mcp|$PROF|$FARM"
  "playwright-core|$PROF|$FARM"
)

mkdir -p "$WS/node_modules/@deepseek-ai" "$WS/node_modules/@playwright"
missing=0
for entry in "${PEERS[@]}"; do
  name="${entry%%|*}"; rest="${entry#*|}"
  first="${rest%%|*}"; second="${rest#*|}"
  if [ -e "$first/$name/package.json" ]; then src="$first"
  elif [ -e "$second/$name/package.json" ]; then src="$second"
  else echo "MISSING peer $name in both $first and $second" >&2; missing=1; continue
  fi
  ln -sfn "$src/$name" "$WS/node_modules/$name"
  echo "linked $name -> $src/$name"
done
[ "$missing" = "0" ] || { echo "some peers are missing; install them into the profile first" >&2; exit 1; }
echo "peer farm ready in $WS/node_modules"
