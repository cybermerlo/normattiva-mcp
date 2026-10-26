# Dockerfile per il server MCP Normattiva, esposto in HTTP.
#
# Dal 2026-10-26 il server parla Streamable HTTP da sé (`--http`, vedi
# avviaHttp in src/index.ts), SENZA sessioni e in un solo processo. Prima lo
# esponeva supergateway in modalità stateful, che avviava un processo
# `node build/index.js` per ogni sessione MCP: senza --sessionTimeout restavano
# vivi per sempre (584 processi orfani, 5,4 GiB di RAM ad agosto 2026), la cache
# dei dati era separata per processo, e i client si ritrovavano con sessioni
# scadute. Senza sessioni nessuno di questi problemi può tornare.
#
# Le fix agli header/endpoint delle API di Normattiva sono nel sorgente
# (src/index.ts): NON serve alcuna patch in fase di build.

FROM node:20-alpine

WORKDIR /app

# Dipendenze del server MCP: `npm ci` installa ESATTAMENTE il package-lock
# (build riproducibile), mentre `npm install` può risolvere versioni diverse.
COPY package.json package-lock.json ./
RUN npm ci

# Sorgente + build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV PORT=8000
EXPOSE 8000

# Endpoint MCP: http://<host>:8000/mcp/<MCP_URL_TOKEN>  —  salute: /healthz
# MCP_URL_TOKEN (almeno 32 caratteri) arriva da Coolify, solo runtime: senza,
# l'endpoint è /mcp e chiunque lo raggiunga lo usa.
CMD ["node", "build/index.js", "--http"]
