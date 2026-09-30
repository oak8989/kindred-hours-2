FROM node:24-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@10.25.0 --activate && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && node --test src/backend/smoke.test.mjs

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/backend ./src/backend
RUN mkdir -p /app/data/assets
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/backend/server.mjs"]
