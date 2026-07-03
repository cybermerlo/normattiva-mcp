#!/usr/bin/env node

/**
 * Server MCP per Normattiva - Banca Dati Normativa Italiana
 * 
 * Questo server permette a Claude (via Cowork o Claude Desktop) di interrogare
 * direttamente le API Open Data di Normattiva per recuperare testi normativi
 * ufficiali, evitando allucinazioni sulla normativa italiana.
 * 
 * API di riferimento: https://dati.normattiva.it
 * Documentazione: https://dati.normattiva.it/assets/come_fare_per/API_Normattiva_OpenData.pdf
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ============================================================================
// CONFIGURAZIONE
// ============================================================================

const BASE_URL = "https://api.normattiva.it/t/normattiva.api";
const BASE_URL_PRE = "https://pre.api.normattiva.it/t/normattiva.api"; // ambiente test
const API_PREFIX = "/bff-opendata/v1/api/v1";

// Usa l'ambiente di produzione per default
const API_BASE = `${BASE_URL}${API_PREFIX}`;

// Header per le richieste POST (con body JSON).
const COMMON_HEADERS: Record<string, string> = {
  "Accept": "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "User-Agent": "NormattivaMCP/1.0",
};

// Header per le richieste GET: identici ai COMMON_HEADERS ma SENZA "Content-Type".
// Una GET non ha body, quindi inviare "Content-Type: application/json" è una
// firma anomala che l'anti-bot del Poligrafico e Zecca dello Stato blocca con
// HTTP 409 ("La pagina richiesta e' stata bloccata dai sistemi di protezione").
// Rimuovendo Content-Type sulle GET le richieste passano correttamente (200).
const GET_HEADERS: Record<string, string> = {
  "Accept": "application/json, text/plain, */*",
  "User-Agent": "NormattivaMCP/1.0",
};

// ============================================================================
// FUNZIONI HELPER
// ============================================================================

async function apiGet(endpoint: string): Promise<unknown> {
  const url = `${API_BASE}${endpoint}`;
  console.error(`[Normattiva MCP] GET ${url}`);
  
  const response = await fetch(url, {
    method: "GET",
    headers: GET_HEADERS,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Errore API Normattiva (${response.status}): ${errorText}`);
  }

  return response.json();
}

async function apiPost(endpoint: string, body: unknown): Promise<unknown> {
  const url = `${API_BASE}${endpoint}`;
  console.error(`[Normattiva MCP] POST ${url}`);
  console.error(`[Normattiva MCP] Body: ${JSON.stringify(body)}`);
  
  const response = await fetch(url, {
    method: "POST",
    headers: COMMON_HEADERS,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Errore API Normattiva (${response.status}): ${errorText}`);
  }

  // Alcune API restituiscono testo semplice (es. token), altre JSON
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

/**
 * Formatta la lista degli atti in un formato leggibile
 */
function formatListaAtti(data: any): string {
  if (!data?.listaAtti || data.listaAtti.length === 0) {
    return "Nessun atto trovato con i criteri specificati.";
  }

  let result = `**Trovati ${data.numeroAttiTrovati} atti** (pagina ${data.paginaCorrente} di ${data.numeroPagine})\n\n`;

  for (const atto of data.listaAtti) {
    result += `---\n`;
    result += `**${atto.descrizioneAtto}**\n`;
    result += `Titolo: ${atto.titoloAtto}\n`;
    result += `Tipo: ${atto.denominazioneAtto}\n`;
    result += `Data emanazione: ${atto.giornoProvvedimento}/${atto.meseProvvedimento}/${atto.annoProvvedimento}\n`;
    result += `GU n. ${atto.numeroGU} del ${atto.dataGUStr}`;
    if (atto.tipoSupplementoIt) {
      result += ` ${atto.tipoSupplementoIt}`;
    }
    result += `\n`;
    result += `Codice redazionale: ${atto.codiceRedazionale} — dataGU: ${atto.dataGU}\n`;
    result += `→ testo: dettaglio_atto(codice_redazionale="${atto.codiceRedazionale}", data_gu="${atto.dataGU}")\n`;
    result += `\n`;
  }

  // Aggiungi le facet se presenti
  if (data.facetMap) {
    result += `\n---\n**Filtri disponibili:**\n`;
    if (data.facetMap.codice_tipo_provvedimento) {
      result += `\nPer tipo di atto:\n`;
      for (const f of data.facetMap.codice_tipo_provvedimento) {
        result += `  - ${f.descrizione || f.codice}: ${f.valore} risultati\n`;
      }
    }
    if (data.facetMap.anno_provvedimento) {
      result += `\nPer anno:\n`;
      for (const f of data.facetMap.anno_provvedimento) {
        result += `  - ${f.descrizione}: ${f.valore} risultati\n`;
      }
    }
  }

  return result;
}

/**
 * Converte l'HTML (Akoma Ntoso) di un articolo in testo leggibile.
 */
function htmlToText(html: string): string {
  let s = html || "";
  // Tag a livello di blocco -> a capo
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\/\s*(p|div|h[1-6]|li|tr|article|section)\s*>/gi, "\n");
  // Rimuovi tutti i tag rimanenti (mantenendo il testo dei link)
  s = s.replace(/<[^>]+>/g, "");
  // Decodifica entità numeriche
  s = s.replace(/&#(\d+);/g, (_m, d) => { try { return String.fromCharCode(parseInt(d, 10)); } catch { return ""; } });
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => { try { return String.fromCharCode(parseInt(h, 16)); } catch { return ""; } });
  // Decodifica entità con nome più comuni nei testi normativi italiani
  const named: Record<string, string> = {
    "&agrave;": "à", "&egrave;": "è", "&eacute;": "é", "&igrave;": "ì", "&ograve;": "ò", "&ugrave;": "ù",
    "&Agrave;": "À", "&Egrave;": "È", "&Eacute;": "É", "&Igrave;": "Ì", "&Ograve;": "Ò", "&Ugrave;": "Ù",
    "&nbsp;": " ", "&laquo;": "«", "&raquo;": "»", "&sect;": "§", "&deg;": "°",
    "&quot;": "\"", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&",
  };
  for (const [k, v] of Object.entries(named)) s = s.split(k).join(v);
  // Normalizza gli spazi mantenendo la struttura in righe
  s = s.replace(/ /g, " ").replace(/\r/g, "");
  s = s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/**
 * POST che restituisce lo status HTTP senza lanciare eccezioni,
 * per poter distinguere "atto/articolo non trovato" (404) dagli altri esiti.
 */
async function apiPostStatus(endpoint: string, body: unknown): Promise<{ status: number; data: any }> {
  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    method: "POST",
    headers: COMMON_HEADERS,
    body: JSON.stringify(body),
  });
  let data: any = null;
  try {
    const ct = response.headers.get("content-type") || "";
    data = ct.includes("application/json") ? await response.json() : await response.text();
  } catch {
    data = null;
  }
  return { status: response.status, data };
}

type ArticoloResult =
  | { kind: "article"; label: string; testo: string }
  | { kind: "empty" }
  | { kind: "notfound" }
  | { kind: "error"; status: number };

/**
 * Recupera un singolo articolo (o l'intestazione) dell'atto tramite l'endpoint
 * POST /atto/dettaglio-atto. `idArticolo` corrisponde al numero dell'articolo.
 */
async function fetchDettaglioArticolo(
  baseBody: Record<string, unknown>,
  idArticolo?: number,
): Promise<{ res: ArticoloResult; atto: any }> {
  const body = idArticolo != null ? { ...baseBody, idArticolo } : { ...baseBody };
  const { status, data } = await apiPostStatus("/atto/dettaglio-atto", body);
  if (status === 404) return { res: { kind: "notfound" }, atto: null };
  if (status !== 200 || !data) return { res: { kind: "error", status }, atto: null };

  const atto = data?.data?.atto ?? null;
  const html: string = atto?.articoloHtml ?? "";
  // Un articolo con testo reale contiene l'intestazione AKN "article-num-akn".
  if (html.includes("article-num-akn")) {
    const m = html.match(/article-num-akn[^>]*>([^<]+)</);
    const label = m ? m[1].trim() : (idArticolo != null ? `Art. ${idArticolo}` : "");
    // Rimuovi l'intestazione "Art. N" dal corpo: è già mostrata come label in grassetto.
    const bodyHtml = html.replace(/<h2[^>]*article-num-akn[^>]*>[\s\S]*?<\/h2>/gi, "");
    return { res: { kind: "article", label, testo: htmlToText(bodyHtml) }, atto };
  }
  return { res: { kind: "empty" }, atto };
}

/**
 * Compone l'intestazione leggibile di un atto a partire dall'oggetto `atto`.
 */
function formatIntestazioneAtto(atto: any, codiceRedazionale: string, dataGU: string, dataVigenza?: string): string {
  let h = `**${atto?.titolo || codiceRedazionale}**\n`;
  if (atto?.sottoTitolo) h += `${String(atto.sottoTitolo).replace(/\r/g, "").trim()}\n`;
  if (atto?.numeroGU && atto?.giornoGU && atto?.meseGU && atto?.annoGU) {
    h += `GU n. ${atto.numeroGU} del ${String(atto.giornoGU).padStart(2, "0")}/${String(atto.meseGU).padStart(2, "0")}/${atto.annoGU}\n`;
  }
  h += `Codice redazionale: ${codiceRedazionale} — dataGU: ${dataGU}`;
  if (dataVigenza) h += ` — vigenza: ${dataVigenza}`;
  return h;
}

// ============================================================================
// SERVER MCP
// ============================================================================

const server = new McpServer({
  name: "normattiva",
  version: "1.0.0",
});

// --------------------------------------------------------------------------
// TOOL: ricerca_semplice
// --------------------------------------------------------------------------
server.tool(
  "ricerca_semplice",
  `Ricerca semplice nella banca dati Normattiva. Cerca atti normativi italiani per parole chiave nel titolo e nel testo. Usa questo strumento per trovare leggi, decreti, regolamenti italiani. Restituisce la lista degli atti trovati con i metadati principali.`,
  {
    testo: z.string().describe("Parole da cercare nel titolo e nel testo degli atti normativi (es. 'ambiente rifiuti', 'polizia locale', 'codice strada')"),
    ordine: z.enum(["recente", "vecchio"]).default("recente").describe("Ordine dei risultati: 'recente' (dal più recente) o 'vecchio' (dal più vecchio)"),
    pagina: z.number().int().min(1).default(1).describe("Numero di pagina dei risultati"),
    risultati_per_pagina: z.number().int().min(1).max(50).default(10).describe("Numero di risultati per pagina (max 50)"),
  },
  async ({ testo, ordine, pagina, risultati_per_pagina }) => {
    try {
      const body = {
        testoRicerca: testo,
        orderType: ordine,
        paginazione: {
          paginaCorrente: pagina,
          numeroElementiPerPagina: risultati_per_pagina,
        },
      };

      const data = await apiPost("/ricerca/semplice", body);
      const formatted = formatListaAtti(data);

      return {
        content: [{ type: "text", text: formatted }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Errore nella ricerca: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// --------------------------------------------------------------------------
// TOOL: ricerca_avanzata
// --------------------------------------------------------------------------
server.tool(
  "ricerca_avanzata",
  `Ricerca avanzata nella banca dati Normattiva con filtri specifici. Permette di cercare per tipo di atto (legge, decreto legislativo, decreto-legge, ecc.), date di emanazione/pubblicazione, vigenza, e parole chiave. Ideale per trovare un atto specifico quando si conoscono alcuni parametri.`,
  {
    testo_titolo: z.string().optional().describe("Parole da cercare nel titolo dell'atto"),
    testo_ricerca: z.string().optional().describe("Parole da cercare nel testo dell'atto"),
    tipo_atto: z.string().optional().describe("Tipo di atto (es. 'LEGGE', 'DECRETO LEGISLATIVO', 'DECRETO-LEGGE', 'DECRETO', 'DECRETO DEL PRESIDENTE DELLA REPUBBLICA', 'COSTITUZIONE'). Usare il valore esatto dalla tipologica."),
    data_inizio_emanazione: z.string().optional().describe("Data inizio emanazione nel formato YYYY-MM-DD"),
    data_fine_emanazione: z.string().optional().describe("Data fine emanazione nel formato YYYY-MM-DD"),
    data_inizio_pubblicazione: z.string().optional().describe("Data inizio pubblicazione GU nel formato YYYY-MM-DD"),
    data_fine_pubblicazione: z.string().optional().describe("Data fine pubblicazione GU nel formato YYYY-MM-DD"),
    data_vigenza: z.string().optional().describe("Data di vigenza di interesse nel formato YYYY-MM-DD (per ottenere il testo vigente a quella data)"),
    classe_provvedimento: z.enum(["1", "2", "3"]).optional().describe("Classe: '1' = senza aggiornamenti, '2' = aggiornato, '3' = abrogato"),
    anno_provvedimento: z.number().int().optional().describe("Anno di emanazione del provvedimento"),
    numero_provvedimento: z.number().int().optional().describe("Numero del provvedimento"),
    ordine: z.enum(["recente", "vecchio"]).default("recente").describe("Ordine dei risultati"),
    pagina: z.number().int().min(1).default(1).describe("Numero di pagina"),
    risultati_per_pagina: z.number().int().min(1).max(50).default(10).describe("Risultati per pagina"),
  },
  async (params) => {
    try {
      const body: Record<string, unknown> = {
        orderType: params.ordine,
        paginazione: {
          paginaCorrente: params.pagina,
          numeroElementiPerPagina: params.risultati_per_pagina,
        },
      };

      if (params.testo_titolo) body.titoloRicerca = params.testo_titolo;
      if (params.testo_ricerca) body.testoRicerca = params.testo_ricerca;
      if (params.tipo_atto) body.denominazioneAtto = params.tipo_atto;
      if (params.data_inizio_emanazione) body.dataInizioEmanazione = params.data_inizio_emanazione;
      if (params.data_fine_emanazione) body.dataFineEmanazione = params.data_fine_emanazione;
      if (params.data_inizio_pubblicazione) body.dataInizioPubProvvedimento = params.data_inizio_pubblicazione;
      if (params.data_fine_pubblicazione) body.dataFinePubProvvedimento = params.data_fine_pubblicazione;
      if (params.data_vigenza) body.vigenza = params.data_vigenza;
      if (params.classe_provvedimento) body.classeProvvedimento = params.classe_provvedimento;
      if (params.anno_provvedimento) body.annoProvvedimento = params.anno_provvedimento;
      if (params.numero_provvedimento) body.numeroProvvedimento = params.numero_provvedimento;

      const data = await apiPost("/ricerca/avanzata", body);
      const formatted = formatListaAtti(data);

      return {
        content: [{ type: "text", text: formatted }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Errore nella ricerca avanzata: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// --------------------------------------------------------------------------
// TOOL: trova_atto_specifico
// --------------------------------------------------------------------------
server.tool(
  "trova_atto_specifico",
  `Trova un atto normativo specifico quando conosci il tipo, il numero e l'anno. Ad esempio: "D.Lgs. 152/2006" diventa tipo='DECRETO LEGISLATIVO', numero=152, anno=2006. Questo è il modo più preciso per trovare una norma specifica.`,
  {
    tipo_atto: z.enum([
      "LEGGE",
      "DECRETO LEGISLATIVO",
      "DECRETO-LEGGE",
      "DECRETO",
      "DECRETO DEL PRESIDENTE DELLA REPUBBLICA",
      "DECRETO DEL PRESIDENTE DEL CONSIGLIO DEI MINISTRI",
      "LEGGE COSTITUZIONALE",
      "COSTITUZIONE",
      "REGIO DECRETO",
      "REGOLAMENTO",
      "ORDINANZA",
    ]).describe("Tipo di atto normativo"),
    numero: z.number().int().describe("Numero dell'atto"),
    anno: z.number().int().describe("Anno di emanazione"),
    data_vigenza: z.string().optional().describe("Data di vigenza (YYYY-MM-DD) per ottenere la versione vigente a quella data. Se omesso, restituisce la versione più recente."),
  },
  async ({ tipo_atto, numero, anno, data_vigenza }) => {
    try {
      const body: Record<string, unknown> = {
        denominazioneAtto: tipo_atto,
        annoProvvedimento: anno,
        numeroProvvedimento: numero,
        orderType: "recente",
        paginazione: {
          paginaCorrente: 1,
          numeroElementiPerPagina: 5,
        },
      };

      if (data_vigenza) {
        body.vigenza = data_vigenza;
      }

      const data = await apiPost("/ricerca/avanzata", body);
      const formatted = formatListaAtti(data);

      return {
        content: [{ type: "text", text: formatted }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Errore nella ricerca dell'atto: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// --------------------------------------------------------------------------
// TOOL: dettaglio_atto
// --------------------------------------------------------------------------
server.tool(
  "dettaglio_atto",
  `Recupera il testo di un atto normativo dalla banca dati Normattiva. Richiede il codice redazionale E la data di pubblicazione in Gazzetta Ufficiale (data_gu, formato YYYY-MM-DD): entrambi si ottengono dai risultati di ricerca_semplice, ricerca_avanzata o trova_atto_specifico. Senza il parametro 'articolo' restituisce l'intestazione e l'art. 1; usa 'articolo' per un articolo specifico (es. articolo=192), oppure 'testo_completo'=true per l'intero testo dell'atto.`,
  {
    codice_redazionale: z.string().describe("Codice redazionale dell'atto (es. '006G0171', '26G00130'). Si ottiene dai risultati della ricerca."),
    data_gu: z.string().describe("Data di pubblicazione in Gazzetta Ufficiale, formato YYYY-MM-DD (campo 'dataGU' dei risultati della ricerca, es. '2006-04-14'). Obbligatoria."),
    articolo: z.number().int().min(1).optional().describe("Numero dell'articolo da recuperare (es. 192). Se omesso, restituisce l'intestazione e l'art. 1."),
    data_vigenza: z.string().optional().describe("Data di vigenza (YYYY-MM-DD) per ottenere il testo vigente a quella data. Se omesso, versione vigente attuale."),
    testo_completo: z.boolean().default(false).describe("Se true, recupera tutti gli articoli dell'atto (fino a un massimo di 40). Ignorato se è specificato 'articolo'."),
  },
  async ({ codice_redazionale, data_gu, articolo, data_vigenza, testo_completo }) => {
    try {
      const baseBody: Record<string, unknown> = {
        dataGU: data_gu,
        codiceRedazionale: codice_redazionale,
      };
      if (data_vigenza) baseBody.dataVigenza = data_vigenza;

      // --- Caso 1: articolo specifico ---
      if (articolo != null) {
        const { res, atto } = await fetchDettaglioArticolo(baseBody, articolo);
        if (res.kind === "notfound") {
          return {
            content: [{ type: "text", text: `Articolo ${articolo} non trovato per l'atto ${codice_redazionale} (dataGU ${data_gu}). L'atto potrebbe avere meno articoli, oppure codice_redazionale/data_gu non sono corretti (verifica con una ricerca).` }],
            isError: true,
          };
        }
        if (res.kind === "error") {
          return { content: [{ type: "text", text: `Errore nel recupero dell'articolo ${articolo} (HTTP ${res.status}).` }], isError: true };
        }
        const intest = formatIntestazioneAtto(atto, codice_redazionale, data_gu, data_vigenza);
        if (res.kind === "empty") {
          return { content: [{ type: "text", text: `${intest}\n\nIl testo dell'articolo ${articolo} non è disponibile (atto molto recente o articolo privo di testo consolidato).` }] };
        }
        return { content: [{ type: "text", text: `${intest}\n\n---\n**${res.label}**\n${res.testo}` }] };
      }

      // --- Caso 2/3: intero atto o intestazione + art. 1 ---
      const first = await fetchDettaglioArticolo(baseBody, 1);
      if (first.res.kind === "notfound") {
        // Prova senza idArticolo: se l'atto esiste, mostra almeno l'intestazione
        const bare = await fetchDettaglioArticolo(baseBody, undefined);
        if (bare.atto) {
          return { content: [{ type: "text", text: `${formatIntestazioneAtto(bare.atto, codice_redazionale, data_gu, data_vigenza)}\n\n(Nessun testo di articolo disponibile per questo atto.)` }] };
        }
        return {
          content: [{ type: "text", text: `Atto non trovato. Verifica codice_redazionale ("${codice_redazionale}") e data_gu ("${data_gu}"): entrambi vanno presi dai risultati di ricerca_semplice/avanzata o trova_atto_specifico.` }],
          isError: true,
        };
      }
      if (first.res.kind === "error") {
        return { content: [{ type: "text", text: `Errore nel recupero dell'atto (HTTP ${first.res.status}).` }], isError: true };
      }

      const intest = formatIntestazioneAtto(first.atto, codice_redazionale, data_gu, data_vigenza);
      if (first.res.kind === "empty") {
        return { content: [{ type: "text", text: `${intest}\n\nIl testo consolidato degli articoli non è ancora disponibile per questo atto (probabilmente molto recente). È consultabile nella Gazzetta Ufficiale indicata.` }] };
      }

      // Abbiamo il testo dell'art. 1
      if (!testo_completo) {
        return {
          content: [{ type: "text", text: `${intest}\n\n---\n**${first.res.label}**\n${first.res.testo}\n\n---\n*L'atto contiene più articoli. Usa \`articolo=N\` per un articolo specifico (es. \`articolo=2\`), oppure \`testo_completo=true\` per l'intero testo.*` }],
        };
      }

      // --- Testo completo: scorre gli articoli in piccoli batch fino alla fine (404) ---
      const CAP = 40;
      const BATCH = 6;
      const parts: string[] = [`**${first.res.label}**\n${first.res.testo}`];
      let ended = false;
      for (let start = 2; start <= CAP && !ended; start += BATCH) {
        const nums: number[] = [];
        for (let k = start; k < start + BATCH && k <= CAP; k++) nums.push(k);
        const results = await Promise.all(nums.map((n) => fetchDettaglioArticolo(baseBody, n)));
        for (let i = 0; i < results.length; i++) {
          const r = results[i].res;
          if (r.kind !== "article") { ended = true; break; }
          parts.push(`**${r.label}**\n${r.testo}`);
        }
      }
      let out = `${intest}\n\n${parts.join("\n\n---\n")}`;
      if (!ended) out += `\n\n---\n*Testo troncato ai primi ${CAP} articoli. Usa \`articolo=N\` per consultare gli articoli successivi.*`;
      return { content: [{ type: "text", text: out }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Errore nel recupero del dettaglio: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// --------------------------------------------------------------------------
// TOOL: atti_aggiornati
// --------------------------------------------------------------------------
server.tool(
  "atti_aggiornati",
  `Recupera la lista degli atti normativi aggiornati (modificati) in un determinato periodo. Utile per monitorare le novità normative e le modifiche recenti alla legislazione. L'intervallo non può superare i 12 mesi e i risultati sono limitati a 7000 atti.`,
  {
    data_inizio: z.string().describe("Data inizio periodo nel formato YYYY-MM-DD"),
    data_fine: z.string().describe("Data fine periodo nel formato YYYY-MM-DD (l'intervallo massimo consentito è 12 mesi)"),
    pagina: z.number().int().min(1).default(1).describe("Numero di pagina"),
    risultati_per_pagina: z.number().int().min(1).max(50).default(10).describe("Risultati per pagina"),
  },
  async ({ data_inizio, data_fine, pagina, risultati_per_pagina }) => {
    try {
      // L'API richiede i campi dataInizioAggiornamento/dataFineAggiornamento come
      // timestamp ISO. Convertiamo le date (YYYY-MM-DD) coprendo l'intera giornata.
      const toIso = (d: string, fineGiornata: boolean) =>
        d.includes("T") ? d : `${d}T${fineGiornata ? "23:59:59.999" : "00:00:00.000"}Z`;
      const body = {
        dataInizioAggiornamento: toIso(data_inizio, false),
        dataFineAggiornamento: toIso(data_fine, true),
        paginazione: {
          paginaCorrente: pagina,
          numeroElementiPerPagina: risultati_per_pagina,
        },
      };

      const data = await apiPost("/ricerca/aggiornati", body);
      
      if (typeof data === "string") {
        return { content: [{ type: "text", text: data }] };
      }
      
      // Proviamo a formattare come lista atti se possibile
      try {
        const formatted = formatListaAtti(data);
        return { content: [{ type: "text", text: formatted }] };
      } catch {
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `Errore nel recupero atti aggiornati: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// --------------------------------------------------------------------------
// TOOL: tipi_atto
// --------------------------------------------------------------------------
server.tool(
  "tipi_atto",
  `Recupera l'elenco completo delle tipologie di atti normativi disponibili nella banca dati Normattiva (leggi, decreti, ecc.). Utile per conoscere i valori esatti da usare nelle ricerche avanzate.`,
  {},
  async () => {
    try {
      const data = await apiGet("/tipologiche/denominazione-atto") as Array<{ label: string; value: string }>;
      
      let result = "**Tipologie di atti disponibili su Normattiva:**\n\n";
      result += "| Codice | Denominazione |\n|--------|---------------|\n";
      for (const tipo of data) {
        result += `| ${tipo.label} | ${tipo.value} |\n`;
      }

      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Errore nel recupero tipologie: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// --------------------------------------------------------------------------
// TOOL: collezioni_predefinite
// --------------------------------------------------------------------------
server.tool(
  "collezioni_predefinite",
  `Recupera le collezioni predefinite di atti disponibili su Normattiva (es. atti vigenti, atti della Repubblica, atti abrogati). Utile per avere una panoramica delle raccolte già pronte.`,
  {},
  async () => {
    try {
      const data = await apiGet("/collections/collection-predefinite") as Array<{ nomeCollezione: string; numeroAtti: number }>;
      
      let result = "**Collezioni predefinite disponibili:**\n\n";
      for (const col of data) {
        result += `- **${col.nomeCollezione}**: ${col.numeroAtti} atti\n`;
      }

      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Errore nel recupero collezioni: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// ============================================================================
// AVVIO SERVER
// ============================================================================

async function main() {
  console.error("[Normattiva MCP] Avvio server...");
  console.error(`[Normattiva MCP] Endpoint API: ${API_BASE}`);
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error("[Normattiva MCP] Server connesso e in ascolto.");
}

main().catch((error) => {
  console.error("[Normattiva MCP] Errore fatale:", error);
  process.exit(1);
});
