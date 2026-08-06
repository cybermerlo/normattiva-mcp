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
#
# --sessionTimeout è OBBLIGATORIO in modalità stateful, non è un'ottimizzazione.
# Senza, come dice la doc dell'opzione, "the session will only be deleted when
# client transport explicitly terminates the session": supergateway avvia un
# processo `node build/index.js` per OGNI sessione MCP e, se il client sparisce
# senza chiuderla (Claude Desktop chiuso, PC sospeso, rete caduta), quel
# processo resta vivo per sempre.
# Misurato sul server il 2026-08-06: 584 processi orfani accumulati in 33 giorni
# di uptime = 5,4 GiB di RAM + 6,2 GiB di swap (il 90% dello swap della
# macchina), al punto da spingere in swap SQL Server del gestionale.
#
# 1.800.000 ms = 30 minuti di inattività. Il timer parte solo quando la sessione
# non ha richieste in volo né stream aperti, e viene ANNULLATO appena il client
# torna: una sessione realmente in uso non viene mai chiusa, nemmeno dopo ore.
# 30 minuti sono quindi prudenti per l'uso interattivo da Claude Desktop e
# bastano a far raccogliere le sessioni abbandonate in tempi utili.
CMD ["supergateway", \
     "--stdio", "node build/index.js", \
     "--outputTransport", "streamableHttp", \
     "--stateful", \
     "--sessionTimeout", "1800000", \
     "--port", "8000", \
     "--healthEndpoint", "/healthz", \
     "--cors"]
