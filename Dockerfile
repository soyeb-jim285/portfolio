# Portfolio site: build the Astro output, then serve it as static files.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG PUBLIC_API_URL
ARG PUBLIC_FORM_ENDPOINT
ARG PUBLIC_TURNSTILE_SITE_KEY
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
