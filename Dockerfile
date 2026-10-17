FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    LINKEDIN_READ_ONLY=true \
    TOKEN_STORAGE_PATH=/home/node/.linkedin-ads-mcp/tokens.json
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY LICENSE ./LICENSE
RUN mkdir -p /home/node/.linkedin-ads-mcp && chown node:node /home/node/.linkedin-ads-mcp
USER node
ENTRYPOINT ["node", "dist/index.js"]
