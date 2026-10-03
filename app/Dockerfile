FROM node:22-slim AS build
RUN npm install -g pnpm@11.9.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/package.json app/
COPY evals/package.json evals/
COPY infra/package.json infra/
RUN pnpm install --frozen-lockfile --filter @front-desk/app
COPY app/ app/
RUN pnpm --filter @front-desk/app build

FROM node:22-slim
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 MIGRATIONS_DIR=/srv/app/migrations
WORKDIR /srv
COPY --from=build /repo/app/.next/standalone ./
COPY --from=build /repo/app/.next/static ./app/.next/static
COPY --from=build /repo/app/src/db/migrations ./app/migrations
USER node
EXPOSE 3000
CMD ["node", "app/server.js"]
