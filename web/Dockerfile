# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY protocol/package.json protocol/
COPY agents/common/package.json agents/common/
COPY agents/worker/package.json agents/worker/
COPY agents/chatops/package.json agents/chatops/
COPY web/package.json web/
RUN npm ci
COPY protocol/ protocol/
COPY web/ web/
RUN npm run -w web build

FROM nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
