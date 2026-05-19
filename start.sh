#!/bin/sh
set -e
echo "=== Starting audio-stream ==="
echo "PORT: $PORT"
echo "NODE_ENV: $NODE_ENV"
echo "DATABASE_URL set: $([ -n "$DATABASE_URL" ] && echo yes || echo NO)"
echo "ASSEMBLYAI_API_KEY set: $([ -n "$ASSEMBLYAI_API_KEY" ] && echo yes || echo NO)"
echo "Node version: $(node --version)"
echo "Working dir: $(pwd)"
echo "Checking dist file..."
ls -la ./artifacts/api-server/dist/ 2>/dev/null || echo "DIST NOT FOUND!"
echo "Starting server..."
exec node --enable-source-maps ./artifacts/api-server/dist/index.mjs
