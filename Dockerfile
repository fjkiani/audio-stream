FROM node:20-slim
WORKDIR /app
RUN npm install -g pnpm@9
COPY . .
RUN node scripts/patch-preinstall.mjs
RUN pnpm install --no-frozen-lockfile
RUN PORT=3000 pnpm --filter @workspace/interview-copilot run build
RUN pnpm --filter @workspace/api-server run build
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]
