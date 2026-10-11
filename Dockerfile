# Builds the student app, the dashboard and the API into one image. The API serves both apps,
# so the lab PCs only need the server's address on the campus LAN.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/tracking/package.json packages/tracking/
COPY packages/engine/package.json packages/engine/
COPY packages/case-sheet/package.json packages/case-sheet/
COPY apps/api/package.json apps/api/
COPY apps/sim/package.json apps/sim/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci
COPY . .
# Downloads the hand model once at build time; the running system needs no internet.
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/tracking/package.json packages/tracking/
COPY packages/engine/package.json packages/engine/
COPY packages/case-sheet/package.json packages/case-sheet/
COPY apps/api/package.json apps/api/
COPY apps/sim/package.json apps/sim/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --omit=dev --workspace @sim/api --include-workspace-root=false && npm cache clean --force
COPY packages ./packages
COPY content ./content
COPY apps/api ./apps/api
COPY --from=build /app/apps/sim/dist ./apps/sim/dist
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
ENV SIM_DIR=/app/apps/sim/dist DASHBOARD_DIR=/app/apps/dashboard/dist PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "apps/api/src/server.ts"]
