# Portfolio assistant API. Hono on PORT (default 3001).
# git is a runtime dependency, not a build one: the reindex job clones the
# repositories it indexes into REPO_CACHE_DIR.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server

# Dependencies first so a code change does not reinstall them. tsx is a dev
# dependency but runs the TypeScript sources in production too, exactly as
# `npm start` does locally, so devDependencies stay.
COPY server/package.json server/package-lock.json ./
RUN npm ci

# src/knowledge.json is committed, so no build step is needed here.
COPY server/ ./

# tools.ts imports the site map from the frontend source at runtime, so those
# files ship with the API even though nothing here builds the frontend.
COPY src/ /app/src/

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV REPO_CACHE_DIR=/app/server/.cache/repos
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/index.ts"]
