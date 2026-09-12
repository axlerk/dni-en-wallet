# Imagen mínima para cualquier PaaS (Render, Fly.io, Railway, Koyeb...). Los certificados NO van en la imagen:
# se pasan como variables WWDR_PEM_B64 / SIGNER_CERT_PEM_B64 / SIGNER_KEY_PEM_B64 (ver .env.example).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["node", "server/index.mjs"]
