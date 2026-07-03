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
 * Estrae etichetta e testo di un articolo dall'HTML restituito dall'API.
 * Gestisce sia gli articoli "articolati" (classe AKN "article-num-akn") sia
 * quelli contenuti negli allegati/testi unici (classe "attachment-just-text",
 * dove il numero d'articolo è testo semplice, es. "Art. 3.").
 */
function extractArticolo(html: string, idArticolo?: number): { label: string; testo: string } | null {
  const hasAkn = html.includes("article-num-akn");
  const hasAtt = html.includes("attachment-just-text");
  if (!hasAkn && !hasAtt) return null;

  if (hasAkn) {
    const m = html.match(/article-num-akn[^>]*>([^<]+)</);
    const label = m ? m[1].trim() : (idArticolo != null ? `Art. ${idArticolo}` : "");
    // L'intestazione "Art. N" è già mostrata come label: rimuovila dal corpo.
    const bodyHtml = html.replace(/<h2[^>]*article-num-akn[^>]*>[\s\S]*?<\/h2>/gi, "");
    return { label, testo: htmlToText(bodyHtml) };
  }

  // Allegato / testo unico: il numero d'articolo è testo semplice.
  let testo = htmlToText(html);
  const m = testo.match(/Art(?:icolo)?\.?\s*\d+[\-A-Za-z]*/);
  const label = m ? m[0].replace(/\s+/g, " ").trim() : (idArticolo != null ? `Art. ${idArticolo}` : "Allegato");
  // Rimuovi il numero d'articolo se è a inizio testo (evita il doppione con la label).
  testo = testo.replace(new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.?\\s*"), "").trim();
  return { label, testo };
}

/**
 * Recupera un singolo articolo dell'atto tramite POST /atto/dettaglio-atto.
 * `idArticolo` = numero dell'articolo; `flag` = flagTipoArticolo
 * (0 = parte articolata, 1 = allegato / testo unico).
 */
async function fetchDettaglioArticolo(
  baseBody: Record<string, unknown>,
  idArticolo?: number,
  flag?: number,
): Promise<{ res: ArticoloResult; atto: any }> {
  const body: Record<string, unknown> = { ...baseBody };
  if (idArticolo != null) body.idArticolo = idArticolo;
  if (flag != null) body.flagTipoArticolo = flag;
  const { status, data } = await apiPostStatus("/atto/dettaglio-atto", body);
  if (status === 404) return { res: { kind: "notfound" }, atto: null };
  if (status !== 200 || !data) return { res: { kind: "error", status }, atto: null };

  const atto = data?.data?.atto ?? null;
  const ex = extractArticolo(atto?.articoloHtml ?? "", idArticolo);
  if (ex) return { res: { kind: "article", label: ex.label, testo: ex.testo }, atto };
  return { res: { kind: "empty" }, atto };
}

/**
 * Recupera un articolo provando prima la parte articolata (flag 0) e, se assente,
 * l'allegato / testo unico (flag 1). Necessario per i decreti che "approvano un
 * testo unico" (molti R.D. e i codici), dove gli articoli stanno nell'allegato.
 */
async function fetchArticoloAuto(
  baseBody: Record<string, unknown>,
  idArticolo: number,
): Promise<{ res: ArticoloResult; atto: any; fromAllegato: boolean }> {
  const r0 = await fetchDettaglioArticolo(baseBody, idArticolo, 0);
  if (r0.res.kind !== "notfound") return { ...r0, fromAllegato: false };
  const r1 = await fetchDettaglioArticolo(baseBody, idArticolo, 1);
  if (r1.res.kind === "article") return { ...r1, fromAllegato: true };
  return { ...r0, fromAllegato: false };
}

/**
 * Scorre gli articoli (1..cap) di una sezione dell'atto (flag) in piccoli batch,
 * fermandosi al primo articolo assente (404).
 */
async function walkArticoli(
  baseBody: Record<string, unknown>,
  flag: number,
  cap: number,
): Promise<{ articoli: Array<{ label: string; testo: string }>; ended: boolean; atto: any }> {
  const BATCH = 6;
  const articoli: Array<{ label: string; testo: string }> = [];
  let ended = false;
  let atto: any = null;
  for (let start = 1; start <= cap && !ended; start += BATCH) {
    const nums: number[] = [];
    for (let k = start; k < start + BATCH && k <= cap; k++) nums.push(k);
    const results = await Promise.all(nums.map((n) => fetchDettaglioArticolo(baseBody, n, flag)));
    for (const r of results) {
      if (r.atto && !atto) atto = r.atto;
      if (r.res.kind !== "article") { ended = true; break; }
      articoli.push({ label: r.res.label, testo: r.res.testo });
    }
  }
  return { articoli, ended, atto };
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

/**
 * Individua codiceRedazionale + dataGU di un atto (entrambi necessari a
 * /atto/dettaglio-atto) a partire da identificativi parziali:
 *  1) codice + dataGU espliciti;
 *  2) tipo_atto + numero + anno (risoluzione affidabile via ricerca avanzata);
 *  3) solo codice redazionale (ricerca testuale del codice, non sempre indicizzato).
 */
async function resolveAtto(p: {
  codice_redazionale?: string;
  data_gu?: string;
  tipo_atto?: string;
  numero?: number;
  anno?: number;
}): Promise<{ codiceRedazionale: string; dataGU: string } | { error: string }> {
  const stripZeros = (s: unknown) => String(s ?? "").replace(/^0+/, "");

  // 1. Codice + dataGU già disponibili
  if (p.codice_redazionale && p.data_gu) {
    return { codiceRedazionale: p.codice_redazionale, dataGU: p.data_gu };
  }

  // 2. tipo_atto + numero + anno
  if (p.tipo_atto && p.numero != null && p.anno != null) {
    const { status, data } = await apiPostStatus("/ricerca/avanzata", {
      denominazioneAtto: p.tipo_atto,
      numeroProvvedimento: p.numero,
      annoProvvedimento: p.anno,
      orderType: "recente",
      paginazione: { paginaCorrente: 1, numeroElementiPerPagina: 10 },
    });
    const lista: any[] = (status === 200 && data?.listaAtti) || [];
    let pick = lista[0];
    if (p.codice_redazionale) {
      pick = lista.find((a) => stripZeros(a?.codiceRedazionale) === stripZeros(p.codice_redazionale)) || pick;
    }
    if (pick?.codiceRedazionale && pick?.dataGU) {
      return { codiceRedazionale: pick.codiceRedazionale, dataGU: pick.dataGU };
    }
    return { error: `Nessun atto trovato per ${p.tipo_atto} n. ${p.numero}/${p.anno}. Verifica i dati oppure usa ricerca_avanzata/trova_atto_specifico.` };
  }

  // 3. Solo codice redazionale: prova a risolvere la dataGU via ricerca testuale
  if (p.codice_redazionale) {
    const { status, data } = await apiPostStatus("/ricerca/semplice", {
      testoRicerca: p.codice_redazionale,
      orderType: "recente",
      paginazione: { paginaCorrente: 1, numeroElementiPerPagina: 10 },
    });
    const lista: any[] = (status === 200 && data?.listaAtti) || [];
    const match = lista.find((a) => stripZeros(a?.codiceRedazionale) === stripZeros(p.codice_redazionale));
    if (match?.codiceRedazionale && match?.dataGU) {
      return { codiceRedazionale: match.codiceRedazionale, dataGU: match.dataGU };
    }
    return { error: `Impossibile risolvere automaticamente la data di Gazzetta Ufficiale per il codice "${p.codice_redazionale}". Fornisci anche 'data_gu' (campo dataGU dei risultati di ricerca) oppure identifica l'atto con 'tipo_atto' + 'numero' + 'anno'.` };
  }

  return { error: "Identifica l'atto con 'codice_redazionale' (più 'data_gu' se disponibile) oppure con 'tipo_atto' + 'numero' + 'anno'." };
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
  `Recupera il testo di un atto normativo dalla banca dati Normattiva. Identifica l'atto in uno di questi modi: (a) codice_redazionale + data_gu (dai risultati di ricerca_semplice/avanzata o trova_atto_specifico); (b) tipo_atto + numero + anno (es. 'REGIO DECRETO' 639 1910), senza bisogno di una ricerca preliminare; (c) solo codice_redazionale (la data GU viene risolta automaticamente). Senza 'articolo' restituisce l'intestazione e l'art. 1; usa 'articolo' per un articolo specifico (es. articolo=192), o 'testo_completo'=true per l'intero testo. Gestisce anche i testi unici e i codici approvati con decreto (es. codice penale, R.D. 639/1910), i cui articoli sono nell'allegato.`,
  {
    codice_redazionale: z.string().optional().describe("Codice redazionale dell'atto (es. '006G0171', '010U0639'), dai risultati di ricerca. In alternativa usa tipo_atto+numero+anno."),
    data_gu: z.string().optional().describe("Data di pubblicazione in Gazzetta Ufficiale (YYYY-MM-DD, campo 'dataGU' dei risultati). Se omessa viene risolta automaticamente dal codice o da tipo_atto+numero+anno."),
    tipo_atto: z.string().optional().describe("Tipo di atto per identificarlo senza codice (es. 'REGIO DECRETO', 'LEGGE', 'DECRETO LEGISLATIVO'). Da usare con 'numero' e 'anno'."),
    numero: z.number().int().optional().describe("Numero dell'atto (con tipo_atto e anno)."),
    anno: z.number().int().optional().describe("Anno dell'atto (con tipo_atto e numero)."),
    articolo: z.number().int().min(1).optional().describe("Numero dell'articolo da recuperare (es. 192). Se omesso, restituisce l'intestazione e l'art. 1."),
    data_vigenza: z.string().optional().describe("Data di vigenza (YYYY-MM-DD) per ottenere il testo vigente a quella data. Se omesso, versione vigente attuale."),
    testo_completo: z.boolean().default(false).describe("Se true, recupera tutti gli articoli dell'atto (fino a un massimo di 40). Ignorato se è specificato 'articolo'."),
  },
  async ({ codice_redazionale, data_gu, tipo_atto, numero, anno, articolo, data_vigenza, testo_completo }) => {
    const out = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
    const bad = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
    try {
      // Risolve codiceRedazionale + dataGU (entrambi necessari all'API) dai parametri forniti.
      const resolved = await resolveAtto({ codice_redazionale, data_gu, tipo_atto, numero, anno });
      if ("error" in resolved) return bad(resolved.error);
      const cr = resolved.codiceRedazionale;
      const dg = resolved.dataGU;

      const baseBody: Record<string, unknown> = {
        dataGU: dg,
        codiceRedazionale: cr,
      };
      if (data_vigenza) baseBody.dataVigenza = data_vigenza;
      const CAP = 40;

      // === Caso 1: articolo specifico (con fallback all'allegato/testo unico) ===
      if (articolo != null) {
        const r = await fetchArticoloAuto(baseBody, articolo);
        if (r.res.kind === "notfound") {
          return bad(`Articolo ${articolo} non trovato per l'atto ${cr} (dataGU ${dg}). L'atto potrebbe avere meno articoli, oppure codice_redazionale/data_gu non sono corretti (verifica con una ricerca).`);
        }
        if (r.res.kind === "error") {
          return bad(`Errore nel recupero dell'articolo ${articolo} (HTTP ${r.res.status}).`);
        }
        const intest = formatIntestazioneAtto(r.atto, cr, dg, data_vigenza);
        if (r.res.kind === "empty") {
          return out(`${intest}\n\nIl testo dell'articolo ${articolo} non è disponibile (atto molto recente o articolo privo di testo consolidato).`);
        }
        const nota = r.fromAllegato ? " *(dal testo unico allegato)*" : "";
        return out(`${intest}\n\n---\n**${r.res.label}**${nota}\n${r.res.testo}`);
      }

      // === Caso 2: testo completo ===
      if (testo_completo) {
        const main = await walkArticoli(baseBody, 0, CAP);
        if (main.articoli.length >= 2) {
          const intest = formatIntestazioneAtto(main.atto, cr, dg, data_vigenza);
          const parts = main.articoli.map((a) => `**${a.label}**\n${a.testo}`);
          let o = `${intest}\n\n${parts.join("\n\n---\n")}`;
          if (!main.ended) o += `\n\n---\n*Testo troncato ai primi ${CAP} articoli. Usa \`articolo=N\` per consultare gli articoli successivi.*`;
          return out(o);
        }
        // ≤1 articolo nella parte articolata: il contenuto vero potrebbe essere l'allegato/testo unico
        const alleg = await walkArticoli(baseBody, 1, CAP);
        const atto = alleg.atto || main.atto;
        if (alleg.articoli.length >= 1) {
          const intest = formatIntestazioneAtto(atto, cr, dg, data_vigenza);
          const parts = alleg.articoli.map((a) => `**${a.label}**\n${a.testo}`);
          let o = `${intest}\n\n*Testo unico allegato:*\n\n${parts.join("\n\n---\n")}`;
          if (!alleg.ended) o += `\n\n---\n*Testo troncato ai primi ${CAP} articoli. Usa \`articolo=N\` per gli articoli successivi.*`;
          return out(o);
        }
        if (main.articoli.length === 1) {
          const intest = formatIntestazioneAtto(main.atto, cr, dg, data_vigenza);
          return out(`${intest}\n\n---\n**${main.articoli[0].label}**\n${main.articoli[0].testo}`);
        }
        if (atto) {
          return out(`${formatIntestazioneAtto(atto, cr, dg, data_vigenza)}\n\nIl testo consolidato degli articoli non è ancora disponibile per questo atto.`);
        }
        return bad(`Atto non trovato. Verifica codice_redazionale ("${cr}") e data_gu ("${dg}"): entrambi vanno presi dai risultati di ricerca_semplice/avanzata o trova_atto_specifico.`);
      }

      // === Caso 3: default — intestazione + art. 1 (con rilevamento testo unico) ===
      const a1 = await fetchDettaglioArticolo(baseBody, 1, 0);
      if (a1.res.kind === "error") {
        return bad(`Errore nel recupero dell'atto (HTTP ${a1.res.status}).`);
      }
      if (a1.res.kind === "empty") {
        return out(`${formatIntestazioneAtto(a1.atto, cr, dg, data_vigenza)}\n\nIl testo consolidato degli articoli non è ancora disponibile per questo atto (probabilmente molto recente). È consultabile nella Gazzetta Ufficiale indicata.`);
      }

      // Se l'art. 1 è un "Articolo Unico" (o manca del tutto), il contenuto potrebbe essere nell'allegato.
      let soloArticoloUnico = false;
      if (a1.res.kind === "article") {
        const a2 = await fetchDettaglioArticolo(baseBody, 2, 0);
        soloArticoloUnico = a2.res.kind === "notfound";
      }
      if (a1.res.kind === "notfound" || soloArticoloUnico) {
        const alleg1 = await fetchDettaglioArticolo(baseBody, 1, 1);
        if (alleg1.res.kind === "article") {
          const intest = formatIntestazioneAtto(alleg1.atto || a1.atto, cr, dg, data_vigenza);
          return out(`${intest}\n\n*Atto che approva un testo unico: gli articoli sostanziali sono nell'allegato.*\n\n---\n**${alleg1.res.label}**\n${alleg1.res.testo}\n\n---\n*Usa \`articolo=N\` per un articolo (es. \`articolo=3\`), oppure \`testo_completo=true\` per l'intero testo.*`);
        }
        if (a1.res.kind === "notfound") {
          const bare = await fetchDettaglioArticolo(baseBody, undefined, 0);
          if (bare.atto) {
            return out(`${formatIntestazioneAtto(bare.atto, cr, dg, data_vigenza)}\n\n(Nessun testo di articolo disponibile per questo atto.)`);
          }
          return bad(`Atto non trovato. Verifica codice_redazionale ("${cr}") e data_gu ("${dg}"): entrambi vanno presi dai risultati di ricerca_semplice/avanzata o trova_atto_specifico.`);
        }
        // soloArticoloUnico ma senza allegato: prosegue mostrando l'Articolo Unico.
      }

      // Atto normale (o Articolo Unico senza allegato): intestazione + art. 1
      const a1art = a1.res.kind === "article" ? a1.res : null;
      if (!a1art) return bad("Errore nel recupero dell'atto.");
      const intest = formatIntestazioneAtto(a1.atto, cr, dg, data_vigenza);
      return out(`${intest}\n\n---\n**${a1art.label}**\n${a1art.testo}\n\n---\n*L'atto contiene più articoli. Usa \`articolo=N\` per un articolo specifico (es. \`articolo=2\`), oppure \`testo_completo=true\` per l'intero testo.*`);
    } catch (error) {
      return bad(`Errore nel recupero del dettaglio: ${error instanceof Error ? error.message : String(error)}`);
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
