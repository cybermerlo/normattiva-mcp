# Dockerfile per il server MCP Normattiva, esposto via HTTP con supergateway.
#
# Espone il server MCP (che parla stdio) tramite il transport Streamable HTTP
# di supergateway. Streamable HTTP in modalità "stateful" regge sessioni
# concorrenti multiple: la vecchia modalità SSE andava in crash alla seconda
# connessione ("Error: Already connected to a transport"), mandando il
# container in restart-loop e facendo sparire i tool ai connettori.
#
# Le fix agli header/endpoint delle API di Normattiva sono nel sorgente
# (src/index.ts): NON serve più alcuna patch sed in fase di build.

FROM node:20-alpine

WORKDIR /app

# Bridge stdio <-> Streamable HTTP.
# Versione PINNATA: con "supergateway" senza versione, una release con breaking
# change romperebbe il container al primo rebuild (build non riproducibile).
RUN npm install -g supergateway@3.4.3

# Dipendenze del server MCP: `npm ci` installa ESATTAMENTE il package-lock
# (build riproducibile), mentre `npm install` può risolvere versioni diverse.
COPY package.json package-lock.json ./
RUN npm ci

# Sorgente + build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

EXPOSE 8000

# Endpoint MCP: http://<host>:8000/mcp  —  healthcheck: /healthz
CMD ["supergateway", \
     "--stdio", "node build/index.js", \
     "--outputTransport", "streamableHttp", \
     "--stateful", \
     "--port", "8000", \
     "--healthEndpoint", "/healthz", \
     "--cors"]
