# Portfolio assistant API. Runs the Hono server on PORT (default 3001).
FROM node:22-slim
WORKDIR /app/server

# Dependencies first so a code change does not reinstall them.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# The API imports the exported knowledge file, which lives outside server/.
COPY server/ ./
COPY src/ /app/src/
COPY public/ /app/public/

# tsx runs the TypeScript sources directly, same as `npm start` does locally.
RUN npm i tsx@^4

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/index.ts"]
