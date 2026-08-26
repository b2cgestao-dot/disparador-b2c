# Imagem UNICA pra PaaS (Dokploy/Coolify/Railway): backend + front no mesmo container.
# O backend serve web/index.html em "/" (sem cache) e injeta SUPABASE_URL/ANON_KEY do ambiente.
# Build context = raiz do repo.  docker build -t disparador . && docker run -p 3000:3000 --env-file .env disparador
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 WEB_DIR=/app/web
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY web ./web
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "src/index.js"]
