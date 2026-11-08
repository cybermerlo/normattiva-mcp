# Normattiva MCP Server

Server MCP (Model Context Protocol) per consultare la **banca dati normativa italiana** tramite le API Open Data di [Normattiva](https://dati.normattiva.it).

Questo server permette a **Claude** (via Claude Desktop, Cowork, o Claude Code) di interrogare direttamente Normattiva per recuperare testi normativi ufficiali dello Stato italiano, riducendo drasticamente il rischio di allucinazioni sulla normativa.

## Cosa può fare

- **Dettaglio atto**: recupera il testo di un atto (un singolo articolo, anche `-bis`/`-ter`/…, o l'intero testo), identificandolo per **nome comune** (es. `nome_codice="codice civile"`), per tipo+numero+anno (es. "R.D. 639/1910") oppure per codice redazionale
- **Corpi normativi**: elenco cablato e verificato di **~55 codici, testi unici e leggi fondamentali** (Costituzione, c.c., c.p., c.p.c., c.p.p., c.p.a., TUB, TUF, TUIR, TUEL, TU edilizia, ecc.) richiamabili per nome, con l'allegato giusto già selezionato
- **Ricerca semplice**: cerca atti normativi per parole chiave
- **Ricerca avanzata**: filtra per tipo di atto, date, vigenza, numero
- **Trova atto specifico**: trova una norma precisa (es. "D.Lgs. 152/2006")
- **Atti aggiornati**: monitora le modifiche normative recenti
- **Tipologie e collezioni**: elenca i tipi di atto e le raccolte predefinite

## Requisiti

- **Node.js 18+** (consigliato 20+)
- **npm** (incluso con Node.js)
- **Claude Desktop** con supporto MCP (o Claude Code / Cowork)

## Installazione

### 1. Installa Node.js (se non ce l'hai già)

Su macOS con Homebrew:
```bash
brew install node
```

Oppure scaricalo da [nodejs.org](https://nodejs.org).

### 2. Scarica e compila il server

```bash
# Entra nella cartella del progetto
cd normattiva-mcp

# Installa le dipendenze
npm install

# Compila il progetto
npm run build
```

### 3. Configura Claude Desktop

Apri il file di configurazione di Claude Desktop:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Aggiungi il server alla sezione `mcpServers`:

```json
{
  "mcpServers": {
    "normattiva": {
      "command": "node",
      "args": ["/PERCORSO/COMPLETO/normattiva-mcp/build/index.js"]
    }
  }
}
```

**IMPORTANTE**: Sostituisci `/PERCORSO/COMPLETO/` con il percorso reale dove hai salvato la cartella. Ad esempio:
```json
"args": ["/Users/tuonome/normattiva-mcp/build/index.js"]
```

### 4. Riavvia Claude Desktop

Chiudi e riapri l'app Claude Desktop. Il server Normattiva dovrebbe apparire tra i tool disponibili.

## Utilizzo

Una volta configurato, puoi chiedere a Claude cose come:

- *"Cerca su Normattiva le norme sulla gestione dei rifiuti"*
- *"Trovami il D.Lgs. 152/2006 su Normattiva"*
- *"Quali decreti legislativi sono stati emanati nel 2024 in materia di ambiente?"*
- *"Mostrami gli atti normativi aggiornati nell'ultimo mese"*
- *"Cerca su Normattiva l'art. 7 del D.Lgs. 267/2000"*

Claude utilizzerà automaticamente gli strumenti del server MCP per interrogare la banca dati ufficiale.

## Strumenti disponibili

| Strumento | Descrizione |
|-----------|-------------|
| `dettaglio_atto` | Testo di un atto o di un articolo (anche `-bis`/`-ter`); identificabile per `nome_codice`, tipo+numero+anno o codice redazionale |
| `aggiornamenti_articolo` | Atti che hanno introdotto o modificato un articolo (atto, data GU, disposizione, cosa cambia), dal sito normattiva.it |
| `corpi_normativi` | Elenco dei codici/testi unici/leggi fondamentali richiamabili con `nome_codice` |
| `ricerca_semplice` | Ricerca per parole chiave nel titolo e testo |
| `ricerca_avanzata` | Ricerca con filtri (tipo atto, date, vigenza, ecc.) |
| `trova_atto_specifico` | Trova un atto per tipo + numero + anno |
| `atti_aggiornati` | Atti modificati in un periodo |
| `tipi_atto` | Elenco tipologie di atti |
| `collezioni_predefinite` | Raccolte preconfezionate |

### Esempi di richieste dirette

```
dettaglio_atto(nome_codice="codice civile", articolo=2043)      → art. 2043 c.c.
dettaglio_atto(nome_codice="c.p.", articolo=609, estensione="bis") → art. 609-bis c.p.
dettaglio_atto(nome_codice="cpa", articolo=29)                  → art. 29 c.p.a.
dettaglio_atto(nome_codice="c.p.", articolo=452, estensione="bis", decimale=1) → art. 452-bis.1 c.p.
dettaglio_atto(nome_codice="c.p.", articolo=601, decimale=1)    → art. 601.1 c.p.
dettaglio_atto(nome_codice="231/2001", articolo=25, estensione="octies.2") → art. 25-octies.2 D.Lgs. 231/2001
dettaglio_atto(tipo_atto="DECRETO LEGISLATIVO", numero=47, anno=2026, articolo=9, parte=2) → seguito di un articolo lungo
aggiornamenti_articolo(nome_codice="231/2001", articolo=25, estensione="quinquies") → chi ha introdotto la lett. c-bis)
dettaglio_atto(tipo_atto="DECRETO LEGISLATIVO", numero=152, anno=2006, articolo=192)
```

## Codici tipo atto più comuni

| Codice | Tipo |
|--------|------|
| PLE | LEGGE |
| PLL | DECRETO LEGISLATIVO |
| PDL | DECRETO-LEGGE |
| DCT | DECRETO |
| PPR | DECRETO DEL PRESIDENTE DELLA REPUBBLICA |
| PCM_DPC | DECRETO DEL PRESIDENTE DEL CONSIGLIO DEI MINISTRI |
| PLC | LEGGE COSTITUZIONALE |
| COS | COSTITUZIONE |

## Note tecniche

- Le API di Normattiva sono gratuite e pubbliche
- L'endpoint di produzione è `https://api.normattiva.it`
- Il server usa il trasporto `stdio` (standard per MCP con Claude Desktop)
- Con `--http` (`node build/index.js --http`) il server parla **Streamable HTTP senza sessioni**,
  in un solo processo: è il modo usato sul server dello studio, dietro l'ingresso del plugin
  iCodici Legal (strumenti `normattiva_…`). Endpoint `/mcp/<MCP_URL_TOKEN>` (chiave di almeno 32
  caratteri; chiave sbagliata o assente → 404, mai 401), salute `/healthz`, porta `PORT`
  (predefinita 8000). Senza `MCP_URL_TOKEN` l'endpoint è `/mcp` e resta aperto: solo per le prove.
  Un header `MCP-Protocol-Version` che l'SDK non conosce (es. `2026-07-28` dei client Claude
  recenti) viene riportato all'ultima versione supportata. Test: `npm run test-http`, senza rete.
  Fino alla 1.4.1 il server in rete passava da supergateway, una sessione e un processo `node`
  per client: vedi la storia del Dockerfile.
- I log vengono scritti su `stderr` (non interferiscono con il protocollo MCP)
- `dettaglio_atto` gestisce anche i **testi unici e i codici approvati con decreto** (codice civile, penale, procedura civile/penale, c.p.a., TULPS, legge fallimentare, ecc.): i loro articoli stanno negli **allegati** dell'atto (`flagTipoArticolo` dell'API: 0 = corpo, N = allegato N-esimo) e vengono cercati automaticamente in corpo e allegati 1–3. Il **codice civile** è l'allegato 2 del R.D. 262/1942 (l'allegato 1 sono le preleggi); il **c.p.a.** è l'allegato 2 del D.Lgs. 104/2010.
- Gli articoli con estensione (`-bis`, `-ter`, … fino a `-vicies`) si recuperano con `articolo=N` + `estensione` (campo `sottoArticolo` dell'API: 2 = bis, 3 = ter, …).
- Gli **articoli decimali** (452-bis.1, 635-quater.1, 270-quinquies.3, 601.1 c.p.; 25-octies.2 D.Lgs. 231/2001, …) si recuperano con `decimale=N`, oppure con il decimale in coda all'estensione (`estensione="bis.1"`). L'API li individua col campo `sottoArticolo1`, non documentato: 10 = articolo base, 20 = `.1`, 30 = `.2`, … (la stessa numerazione dei link `caricaArticolo` del sito; i valori 1, 2, … danno 404). Verificato contro l'API l'8/11/2026.
- **La data di vigenza non produce versioni storiche.** `/atto/dettaglio-atto` accetta `dataVigenza` ma la ignora: restituisce sempre la versione attuale (verificato l'8/11/2026: art. 452-bis c.p. chiesto al 2010 → testo in vigore dal 02/06/2026). Il server confronta la data chiesta con il periodo di vigenza dell'articolo restituito (`articoloDataInizioVigenza`/`articoloDataFineVigenza`) e, se non coincide, lo dichiara nella risposta invece di far passare il testo attuale per quello storico.
- **Articoli più lunghi del tetto di dimensione** (es. art. 9 D.Lgs. 47/2026, ~55.000 caratteri) arrivano **divisi in parti**: la risposta dice «parte 1 di N» e `parte=2`, `3`, … dà il seguito. Il taglio cade preferibilmente all'inizio delle «Note all'art.» della GU, poi a fine riga (comma o lettera). `note=false` esclude quelle note (blocco `note-akn` dell'HTML).
- **`aggiornamenti_articolo` legge il sito, non l'API.** L'API Open Data non dice quale atto ha modificato un articolo; il sito sì, nella finestra «aggiornamenti all'articolo» (`/do/atto/vediAggiornamentiAllArticolo`). La finestra risponde solo se nella stessa sessione è stato aperto l'atto (`/atto/caricaDettaglioAtto`): il server tiene i cookie e riapre l'atto se la sessione scade. Zero righe valgono sia per un articolo mai modificato sia per uno inesistente, perciò l'esistenza si verifica prima con l'API. Le date sono di pubblicazione in GU dell'atto modificativo; per la decorrenza il tool indica la `dettaglio_atto` da chiamare sulla disposizione. Il numero dell'articolo modificativo si prende dal testo («con l'art. 5»): il link del sito a volte punta all'art. 1. Essendo HTML del sito, un cambio di grafica lo rompe: il tool lo dichiara e lo smoke test settimanale se ne accorge.

### Limiti di dimensione e di tempo

Un risultato troppo grande, o una chiamata troppo lunga, vengono scartati dal
client (o dal connettore) **per intero**: l'utente vede un errore generico invece
del contenuto. Il server previene entrambi i casi:

- **Tetto di dimensione (40.000 caratteri).** Oltre la soglia la risposta viene
  troncata sul confine dell'ultimo articolo completo, con una nota esplicita su
  come restringere la richiesta. Il tetto si regola con la variabile d'ambiente
  `NORMATTIVA_MAX_RISPOSTA_CHAR`.

  Il limite vero del client è in **token**, non in caratteri, e il testo
  giuridico italiano tokenizza molto peggio dell'inglese: su un client con
  limite di 25k token per risultato, 20.616 caratteri passano mentre 62.295
  vengono rifiutati — meno di ~2,6 caratteri per token. Da qui il default
  prudenziale: tarare questo valore su una stima ottimistica del rapporto
  caratteri/token riporta esattamente il problema che serve a evitare.
- **Budget di tempo (40 s per chiamata).** `testo_completo` incatena fino a 40
  richieste HTTP: allo scadere del budget il server restituisce il testo raccolto
  fino a quel momento, **dichiarandolo parziale**, invece di far scadere il
  connettore.
- **Paginazione di `atti_aggiornati` applicata dal server.** L'endpoint
  `/ricerca/aggiornati` di Normattiva ignora la paginazione richiesta e
  restituisce sempre l'intero periodo (una finestra di 7 mesi produce ~243.000
  caratteri): il taglio in pagine viene fatto qui.
- **Testo parziale sempre segnalato.** Se la scansione degli articoli si
  interrompe per un errore dell'API (tipicamente il blocco anti-bot HTTP 409) o
  per scadenza del tempo, l'output lo dichiara: un testo troncato non deve mai
  sembrare integrale.
- **Gli errori dell'API riportano il messaggio di Normattiva.** Es. `HTTP 400:
  Numero di atti superiore al limite consentito di 7000, raffinare la ricerca
  (codice 1502)` invece del solo codice di stato.

### Errori intermittenti di Normattiva (dal settembre 2026)

Dal 17/09/2026 `/atto/dettaglio-atto` risponde a intermittenza — su oltre metà
delle richieste, nei giorni peggiori — con un errore generico, a volte HTTP 404 e
a volte HTTP 500:

```json
{"message":"Errore generico della chiamata, riprovare più tardi","code":"1000"}
```

Tradurlo in "articolo non trovato, verifica il numero" porta un modello a
concludere che articoli esistenti non esistono. Il corpo del 404 però distingue
i casi (verificato sull'API il 24/10/2026): un articolo o un allegato che non
esiste ha un messaggio specifico che ripete la richiesta (`idArticolo:...`),
un codice redazionale con la data GU sbagliata dà `Atto non trovato`, e solo il
guasto ha il corpo generico. Quindi:

- **Ogni risposta è classificata una volta sola**: articolo assente (404
  specifico), atto non riconosciuto, errore temporaneo (corpo generico, 5xx,
  timeout, risposte 200 incomplete), blocco anti-bot (409/429), errore
  permanente (400, 500 con un messaggio specifico). Si ritentano solo gli errori
  temporanei: fino a 6 richieste per articolo (0,5 → 1 → 2 s, con jitter),
  annotate su `stderr`. Contro l'anti-bot un solo ritentativo, poi il server si
  ferma e invita ad aspettare: insistere prolunga il blocco.
- **"Non trovato" solo con una risposta certa**: il 404 specifico, oppure, per i
  codici principali (Costituzione, c.c., c.p., c.p.c., c.p.p.), un numero oltre
  l'ultimo articolo. Se Normattiva non risponde, il messaggio è "errore
  temporaneo" e, entro la numerazione nota, dice che l'articolo esiste.
- **Corpo e allegati in ordine**: si passa all'allegato solo se nel corpo
  l'articolo di sicuro non c'è; un errore nel corpo non fa restituire l'articolo
  con lo stesso numero di un allegato.
- **I 404 non vanno in cache** (solo le risposte 200 complete): altrimenti un
  falso "non trovato" resta attaccato all'articolo per tutta la sessione.
- **Date controllate prima della richiesta**: una data malformata riceve da
  Normattiva lo stesso errore generico del guasto. Il server accetta
  `AAAA-MM-GG` e converte `gg/mm/aaaa`; il resto è un errore di parametro.
- **`testo_completo`** chiude l'atto solo su un 404 specifico. Un articolo che
  non arriva nemmeno ritentando non tronca il testo: gli articoli successivi
  restano e il buco è dichiarato. Blocco anti-bot e budget di tempo fermano la
  scansione con l'avviso "PARZIALE", e il budget di 40 s vale anche per le
  singole richieste (timeout accorciato a quanto resta).
- **`tipo_atto`** viene riportato al valore esatto che l'API vuole (`legge` →
  `LEGGE`, `D.Lgs.` → `DECRETO LEGISLATIVO`, `R.D.L.` → `REGIO DECRETO-LEGGE`,
  `D.Lgt.` → `DECRETO LUOGOTENENZIALE`): scritto in minuscolo la ricerca non
  trovava nulla. I decreti ministeriali stanno quasi sempre come `DECRETO`: se
  `DECRETO MINISTERIALE` non trova nulla si ripiega lì, in tutti i tool di
  ricerca.

`npm run test-guasti` verifica tutto questo contro un finto Normattiva locale che
simula i guasti (deterministico, senza rete; gira anche in CI a ogni push).

## Licenza

Questo progetto è rilasciato come software libero. Le API di Normattiva sono un servizio pubblico dell'Istituto Poligrafico e Zecca dello Stato.
