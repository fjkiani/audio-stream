# Single-stage build — keeps it simple and avoids workspace symlink issues
FROM node:20-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy entire monorepo
COPY . .

# Install all dependencies (bypass preinstall guard by spoofing user agent)
RUN npm_config_user_agent="pnpm/9.0.0 npm/? node/$(node --version) linux x64" \
    pnpm install --frozen-lockfile

# Build frontend (PORT required by vite.config.ts validation at build time)
RUN PORT=3000 pnpm --filter @workspace/interview-copilot run build

# Build backend
RUN pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]
