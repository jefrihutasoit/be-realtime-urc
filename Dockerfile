# syntax=docker/dockerfile:1

# ---- Build stage: compile-check, bundle, minify and obfuscate our code into one file ----
# Dev tools (esbuild, javascript-obfuscator, typescript) live here only; the final image never gets them.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Produces dist/server.js (single obfuscated bundle, no comments, no source map, no folder structure),
# then removes the dev dependencies from node_modules.
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage: only the obfuscated bundle and the runtime dependencies ----
# No src/, no tsconfig, no build scripts and no source maps reach this image.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=256
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 4000 1883
CMD ["node", "dist/server.js"]
