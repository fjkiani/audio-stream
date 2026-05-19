# Use Debian-based Node (glibc) — Alpine (musl) breaks tailwindcss/rollup/lightningcss
# because the pnpm-workspace.yaml overrides disable the musl native binaries.
FROM node:20-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy entire monorepo
COPY . .

# Patch out the preinstall guard (blocks non-pnpm user agents in CI),
# then install all dependencies
RUN node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  delete pkg.scripts.preinstall;
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
  console.log('Removed preinstall guard');
" && pnpm install --no-frozen-lockfile

# Build frontend (PORT required by vite.config.ts validation at build time)
RUN PORT=3000 pnpm --filter @workspace/interview-copilot run build

# Build backend
RUN pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]
