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
- I log vengono scritti su `stderr` (non interferiscono con il protocollo MCP)
- `dettaglio_atto` gestisce anche i **testi unici e i codici approvati con decreto** (codice civile, penale, procedura civile/penale, c.p.a., TULPS, legge fallimentare, ecc.): i loro articoli stanno negli **allegati** dell'atto (`flagTipoArticolo` dell'API: 0 = corpo, N = allegato N-esimo) e vengono cercati automaticamente in corpo e allegati 1–3. Il **codice civile** è l'allegato 2 del R.D. 262/1942 (l'allegato 1 sono le preleggi); il **c.p.a.** è l'allegato 2 del D.Lgs. 104/2010.
- Gli articoli con estensione (`-bis`, `-ter`, … fino a `-vicies`) si recuperano con `articolo=N` + `estensione` (campo `sottoArticolo` dell'API: 2 = bis, 3 = ter, …).

## Licenza

Questo progetto è rilasciato come software libero. Le API di Normattiva sono un servizio pubblico dell'Istituto Poligrafico e Zecca dello Stato.
