# Node 25 runs TypeScript directly (type stripping), so there is no build step.
FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:25-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# The trip estimator places ZIP3s with the control tower's centroid table.
COPY control-tower/lib/zip3-centroids.json ./control-tower/lib/
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
