# @Datalayer for Discord (plans/DISCORD.md §10, DC-008). Built from a clean
# export of this repository (git archive), never a working tree. The exact
# versions of package.json are installed; no lockfile is read (the monorepo
# keeps none). What runs is one esbuild bundle of the service and
# agent-runtimes' lib/portable (§4.2): the build stage fetches the pinned
# release's lib/portable only, bundles and gates it; the runtime stage
# installs the bundle's externals only.

FROM node:20.19-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts --no-audit --no-fund --no-package-lock
COPY scripts ./scripts
# After the install, which would remove it: agent-runtimes' lib/portable only.
RUN npm run fetch:agent-runtimes
COPY tsconfig.json ./
COPY src ./src
RUN npm run bundle

FROM node:20.19-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock \
  && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
