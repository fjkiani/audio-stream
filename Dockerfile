# Use Debian-based Node (glibc) — Alpine (musl) breaks tailwindcss/rollup/lightningcss
FROM node:20-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy entire monorepo
COPY . .

# Remove the preinstall guard (it blocks non-pnpm user agents in CI)
RUN node scripts/patch-preinstall.mjs

# Install all dependencies
RUN pnpm install --no-frozen-lockfile

# Build frontend (PORT required by vite.config.ts validation at build time)
RUN PORT=3000 pnpm --filter @workspace/interview-copilot run build

# Build backend
RUN pnpm --filter @workspace/api-server run build

# Make start script executable
RUN chmod +x start.sh

ENV NODE_ENV=production
EXPOSE 10000

CMD ["sh", "start.sh"]
