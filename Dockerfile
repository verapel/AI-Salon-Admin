# Production image: builds client + server, serves both from Express
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY client/package.json client/package-lock.json* ./client/
COPY server/package.json server/package-lock.json* ./server/

RUN npm install --prefix client && npm install --prefix server

COPY client ./client
COPY server ./server

RUN npm run build --prefix client && npm run build --prefix server

FROM node:20-alpine
WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder /app/server/package.json ./
COPY --from=builder /app/server/dist ./dist
COPY --from=builder /app/server/node_modules ./node_modules
COPY --from=builder /app/client/dist ../client/dist

EXPOSE 3001

CMD ["node", "dist/index.js"]
