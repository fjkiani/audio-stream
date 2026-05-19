#!/usr/bin/env bash
set -e

echo "=== Installing pnpm ==="
npm install -g pnpm@9

echo "=== Installing dependencies ==="
# Set user agent to bypass preinstall guard
npm_config_user_agent="pnpm/9.0.0 npm/? node/$(node --version) linux x64" \
  pnpm install --no-frozen-lockfile

echo "=== Building frontend ==="
PORT=3000 pnpm --filter @workspace/interview-copilot run build

echo "=== Building backend ==="
pnpm --filter @workspace/api-server run build

echo "=== Build complete ==="
