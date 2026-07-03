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

/**
 * fetch con un retry sui soli errori transitori (rete, 502/503/504).
 * Gli status "semantici" (404 = non trovato, 500 = parametri errati)
 * non vengono ritentati.
 */
async function fetchRetry(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, init);
      if (![502, 503, 504].includes(res.status) || attempt === 1) return res;
    } catch (e) {
      lastErr = e;
      if (attempt === 1) throw e;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function apiGet(endpoint: string): Promise<unknown> {
  const url = `${API_BASE}${endpoint}`;
  console.error(`[Normattiva MCP] GET ${url}`);

  const response = await fetchRetry(url, {
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

  const response = await fetchRetry(url, {
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
  const response = await fetchRetry(url, {
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
 * (0 = parte articolata, N = allegato N-esimo); `sottoArticolo` seleziona
 * l'estensione (2 = bis, 3 = ter, ...).
 */
async function fetchDettaglioArticolo(
  baseBody: Record<string, unknown>,
  idArticolo?: number,
  flag?: number,
  sottoArticolo?: number,
): Promise<{ res: ArticoloResult; atto: any }> {
  const body: Record<string, unknown> = { ...baseBody };
  if (idArticolo != null) body.idArticolo = idArticolo;
  if (flag != null) body.flagTipoArticolo = flag;
  if (sottoArticolo != null) body.sottoArticolo = sottoArticolo;
  const { status, data } = await apiPostStatus("/atto/dettaglio-atto", body);
  if (status === 404) return { res: { kind: "notfound" }, atto: null };
  if (status !== 200 || !data) return { res: { kind: "error", status }, atto: null };

  const atto = data?.data?.atto ?? null;
  const ex = extractArticolo(atto?.articoloHtml ?? "", idArticolo);
  if (ex) return { res: { kind: "article", label: ex.label, testo: ex.testo }, atto };
  return { res: { kind: "empty" }, atto };
}

/**
 * Recupera un articolo cercandolo nel corpo dell'atto (flag 0) e poi, se assente,
 * negli allegati (flag 1..3). Necessario per i decreti che "approvano" codici e
 * testi unici, dove gli articoli sostanziali stanno in un allegato (es. codice
 * civile = allegato 2 del R.D. 262/1942, c.p.a. = allegato 2 del D.Lgs. 104/2010).
 * Con `flagFisso` la ricerca è limitata a quella sola sezione.
 */
async function fetchArticoloAuto(
  baseBody: Record<string, unknown>,
  idArticolo: number,
  sottoArticolo?: number,
  flagFisso?: number,
): Promise<{ res: ArticoloResult; atto: any; flagUsato: number }> {
  const flags = flagFisso != null ? [flagFisso] : [0, 1, 2, 3];
  let ultimo: { res: ArticoloResult; atto: any } = { res: { kind: "notfound" }, atto: null };
  for (const f of flags) {
    const r = await fetchDettaglioArticolo(baseBody, idArticolo, f, sottoArticolo);
    if (r.res.kind === "article" || r.res.kind === "error") return { ...r, flagUsato: f };
    // "empty" nel corpo (atto recente senza testo consolidato): inutile scandagliare gli allegati.
    if (r.res.kind === "empty" && f === 0) return { ...r, flagUsato: f };
    ultimo = r;
  }
  return { ...ultimo, flagUsato: flags[flags.length - 1] };
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
// ESTENSIONI DEGLI ARTICOLI (-bis, -ter, ...)
// ============================================================================

// L'API individua le estensioni con il campo sottoArticolo: 2 = bis, 3 = ter, ecc.
const SOTTO_ARTICOLO: Record<string, number> = {
  bis: 2, ter: 3, quater: 4, quinquies: 5, sexies: 6, septies: 7, octies: 8,
  novies: 9, decies: 10, undecies: 11, duodecies: 12, terdecies: 13,
  quaterdecies: 14, quinquiesdecies: 15, quindecies: 15, sexiesdecies: 16,
  septiesdecies: 17, octiesdecies: 18, duodevicies: 18, noviesdecies: 19,
  undevicies: 19, vicies: 20,
};

function normalizzaEstensione(e: string): string {
  return e.toLowerCase().trim().replace(/^-+/, "").replace(/\.+$/, "");
}

// ============================================================================
// CORPI NORMATIVI PRINCIPALI (codici, testi unici, leggi fondamentali)
// ============================================================================

type CorpoNormativo = {
  nome: string;         // denominazione leggibile
  chiavi: string[];     // alias accettati per nome_codice (confronto normalizzato)
  codice: string;       // codice redazionale dell'atto
  dataGU: string;       // data di pubblicazione in GU
  flag: number;         // flagTipoArticolo dove vivono gli articoli (0 = corpo dell'atto, N = allegato N-esimo)
  riferimento: string;  // citazione dell'atto
  nota?: string;
};

// Ogni voce è stata verificata empiricamente contro le API (codice, dataGU e flag).
const CORPI_NORMATIVI: CorpoNormativo[] = [
  { nome: "Costituzione", chiavi: ["cost", "costituzione", "costituzione italiana", "carta costituzionale"], codice: "047U0001", dataGU: "1947-12-27", flag: 0, riferimento: "Costituzione della Repubblica Italiana" },
  { nome: "Preleggi (disposizioni sulla legge in generale)", chiavi: ["preleggi", "disposizioni sulla legge in generale", "disposizioni preliminari codice civile"], codice: "042U0262", dataGU: "1942-04-04", flag: 1, riferimento: "R.D. 16 marzo 1942, n. 262 (allegato 1)" },
  { nome: "Codice civile", chiavi: ["cc", "cod civ", "codice civile"], codice: "042U0262", dataGU: "1942-04-04", flag: 2, riferimento: "R.D. 16 marzo 1942, n. 262 (allegato 2)" },
  { nome: "Disposizioni di attuazione del codice civile", chiavi: ["disp att cc", "disposizioni attuazione codice civile", "attuazione codice civile"], codice: "042U0318", dataGU: "1942-04-17", flag: 1, riferimento: "R.D. 30 marzo 1942, n. 318" },
  { nome: "Codice penale", chiavi: ["cp", "cod pen", "codice penale"], codice: "030U1398", dataGU: "1930-10-26", flag: 1, riferimento: "R.D. 19 ottobre 1930, n. 1398" },
  { nome: "Codice di procedura civile", chiavi: ["cpc", "codice procedura civile", "codice di procedura civile"], codice: "040U1443", dataGU: "1940-10-28", flag: 1, riferimento: "R.D. 28 ottobre 1940, n. 1443" },
  { nome: "Codice di procedura penale", chiavi: ["cpp", "codice procedura penale", "codice di procedura penale"], codice: "088G0492", dataGU: "1988-10-24", flag: 0, riferimento: "D.P.R. 22 settembre 1988, n. 447" },
  { nome: "Disposizioni di attuazione del c.p.p.", chiavi: ["disp att cpp", "disposizioni attuazione codice procedura penale"], codice: "089G0340", dataGU: "1989-08-05", flag: 1, riferimento: "D.Lgs. 28 luglio 1989, n. 271" },
  { nome: "Codice del processo amministrativo", chiavi: ["cpa", "codice processo amministrativo", "processo amministrativo"], codice: "010G0127", dataGU: "2010-07-07", flag: 2, riferimento: "D.Lgs. 2 luglio 2010, n. 104 (allegato 1)" },
  { nome: "Codice della strada", chiavi: ["cds", "codice strada", "codice della strada"], codice: "092G0306", dataGU: "1992-05-18", flag: 0, riferimento: "D.Lgs. 30 aprile 1992, n. 285" },
  { nome: "Codice dell'ambiente (norme in materia ambientale)", chiavi: ["codice ambiente", "testo unico ambiente", "norme in materia ambientale"], codice: "006G0171", dataGU: "2006-04-14", flag: 0, riferimento: "D.Lgs. 3 aprile 2006, n. 152" },
  { nome: "Codice del consumo", chiavi: ["codice consumo", "codice del consumo"], codice: "005G0232", dataGU: "2005-10-08", flag: 0, riferimento: "D.Lgs. 6 settembre 2005, n. 206" },
  { nome: "Codice privacy (protezione dati personali)", chiavi: ["codice privacy", "codice protezione dati", "codice dati personali"], codice: "003G0218", dataGU: "2003-07-29", flag: 0, riferimento: "D.Lgs. 30 giugno 2003, n. 196" },
  { nome: "Codice dei contratti pubblici (appalti) 2023", chiavi: ["codice appalti", "codice contratti pubblici", "codice appalti 2023"], codice: "23G00044", dataGU: "2023-03-31", flag: 0, riferimento: "D.Lgs. 31 marzo 2023, n. 36" },
  { nome: "Codice dei contratti pubblici 2016 (abrogato)", chiavi: ["codice appalti 2016", "codice contratti 2016"], codice: "16G00062", dataGU: "2016-04-19", flag: 0, riferimento: "D.Lgs. 18 aprile 2016, n. 50", nota: "abrogato dal D.Lgs. 36/2023" },
  { nome: "Codice della crisi d'impresa e dell'insolvenza", chiavi: ["ccii", "codice crisi", "codice crisi impresa", "crisi di impresa"], codice: "19G00007", dataGU: "2019-02-14", flag: 0, riferimento: "D.Lgs. 12 gennaio 2019, n. 14" },
  { nome: "Codice dei beni culturali e del paesaggio", chiavi: ["codice beni culturali", "codice urbani", "beni culturali"], codice: "004G0066", dataGU: "2004-02-24", flag: 0, riferimento: "D.Lgs. 22 gennaio 2004, n. 42" },
  { nome: "Codice delle assicurazioni private", chiavi: ["codice assicurazioni", "assicurazioni private"], codice: "005G0233", dataGU: "2005-10-13", flag: 0, riferimento: "D.Lgs. 7 settembre 2005, n. 209" },
  { nome: "Codice dell'amministrazione digitale (CAD)", chiavi: ["cad", "codice amministrazione digitale"], codice: "005G0104", dataGU: "2005-05-16", flag: 0, riferimento: "D.Lgs. 7 marzo 2005, n. 82" },
  { nome: "Codice della proprietà industriale", chiavi: ["cpi", "codice proprieta industriale", "proprieta industriale"], codice: "005G0055", dataGU: "2005-03-04", flag: 0, riferimento: "D.Lgs. 10 febbraio 2005, n. 30" },
  { nome: "Codice antimafia", chiavi: ["codice antimafia", "antimafia"], codice: "011G0201", dataGU: "2011-09-28", flag: 0, riferimento: "D.Lgs. 6 settembre 2011, n. 159" },
  { nome: "Codice del Terzo settore", chiavi: ["cts", "codice terzo settore", "terzo settore"], codice: "17G00128", dataGU: "2017-08-02", flag: 0, riferimento: "D.Lgs. 3 luglio 2017, n. 117" },
  { nome: "Codice di giustizia contabile", chiavi: ["cgc", "codice giustizia contabile", "giustizia contabile"], codice: "16G00187", dataGU: "2016-09-07", flag: 1, riferimento: "D.Lgs. 26 agosto 2016, n. 174 (allegato 1)" },
  { nome: "Codice delle pari opportunità", chiavi: ["codice pari opportunita", "pari opportunita"], codice: "006G0216", dataGU: "2006-05-31", flag: 0, riferimento: "D.Lgs. 11 aprile 2006, n. 198" },
  { nome: "Codice dell'ordinamento militare", chiavi: ["com", "codice ordinamento militare", "ordinamento militare"], codice: "010G0089", dataGU: "2010-05-08", flag: 0, riferimento: "D.Lgs. 15 marzo 2010, n. 66" },
  { nome: "Codice della protezione civile", chiavi: ["codice protezione civile", "protezione civile"], codice: "18G00011", dataGU: "2018-01-22", flag: 0, riferimento: "D.Lgs. 2 gennaio 2018, n. 1" },
  { nome: "Codice delle comunicazioni elettroniche", chiavi: ["cce", "codice comunicazioni elettroniche", "comunicazioni elettroniche"], codice: "003G0280", dataGU: "2003-09-15", flag: 0, riferimento: "D.Lgs. 1 agosto 2003, n. 259" },
  { nome: "Codice del turismo", chiavi: ["codice turismo", "turismo"], codice: "011G0123", dataGU: "2011-06-06", flag: 1, riferimento: "D.Lgs. 23 maggio 2011, n. 79 (allegato 1)" },
  { nome: "Codice della nautica da diporto", chiavi: ["codice nautica", "nautica da diporto"], codice: "005G0200", dataGU: "2005-08-31", flag: 0, riferimento: "D.Lgs. 18 luglio 2005, n. 171" },
  { nome: "Testo unico edilizia", chiavi: ["tu edilizia", "testo unico edilizia", "dpr 380"], codice: "001G0429", dataGU: "2001-10-20", flag: 0, riferimento: "D.P.R. 6 giugno 2001, n. 380" },
  { nome: "Testo unico enti locali (TUEL)", chiavi: ["tuel", "testo unico enti locali", "enti locali"], codice: "000G0304", dataGU: "2000-09-28", flag: 0, riferimento: "D.Lgs. 18 agosto 2000, n. 267" },
  { nome: "Testo unico immigrazione", chiavi: ["tui", "testo unico immigrazione", "immigrazione"], codice: "098G0348", dataGU: "1998-08-18", flag: 0, riferimento: "D.Lgs. 25 luglio 1998, n. 286" },
  { nome: "Testo unico leggi di pubblica sicurezza (TULPS)", chiavi: ["tulps", "testo unico pubblica sicurezza", "pubblica sicurezza"], codice: "031U0773", dataGU: "1931-06-26", flag: 1, riferimento: "R.D. 18 giugno 1931, n. 773" },
  { nome: "Testo unico bancario (TUB)", chiavi: ["tub", "testo unico bancario"], codice: "093G0428", dataGU: "1993-09-30", flag: 0, riferimento: "D.Lgs. 1 settembre 1993, n. 385" },
  { nome: "Testo unico della finanza (TUF)", chiavi: ["tuf", "testo unico finanza"], codice: "098G0073", dataGU: "1998-03-26", flag: 0, riferimento: "D.Lgs. 24 febbraio 1998, n. 58" },
  { nome: "Testo unico imposte sui redditi (TUIR)", chiavi: ["tuir", "testo unico imposte redditi"], codice: "086U0917", dataGU: "1986-12-31", flag: 0, riferimento: "D.P.R. 22 dicembre 1986, n. 917" },
  { nome: "Decreto IVA", chiavi: ["decreto iva", "dpr 633", "testo unico iva", "iva"], codice: "072U0633", dataGU: "1972-11-11", flag: 0, riferimento: "D.P.R. 26 ottobre 1972, n. 633" },
  { nome: "Testo unico imposta di registro", chiavi: ["testo unico registro", "imposta di registro", "dpr 131"], codice: "086U0131", dataGU: "1986-04-30", flag: 0, riferimento: "D.P.R. 26 aprile 1986, n. 131" },
  { nome: "Testo unico accise", chiavi: ["testo unico accise", "accise"], codice: "095G0523", dataGU: "1995-11-29", flag: 0, riferimento: "D.Lgs. 26 ottobre 1995, n. 504" },
  { nome: "Testo unico spese di giustizia", chiavi: ["tusg", "testo unico spese di giustizia", "spese di giustizia", "dpr 115"], codice: "002G0139", dataGU: "2002-06-15", flag: 0, riferimento: "D.P.R. 30 maggio 2002, n. 115" },
  { nome: "Testo unico pubblico impiego", chiavi: ["tupi", "testo unico pubblico impiego", "pubblico impiego", "dlgs 165"], codice: "001G0219", dataGU: "2001-05-09", flag: 0, riferimento: "D.Lgs. 30 marzo 2001, n. 165" },
  { nome: "Testo unico sicurezza sul lavoro", chiavi: ["tusl", "testo unico sicurezza lavoro", "sicurezza sul lavoro", "dlgs 81"], codice: "008G0104", dataGU: "2008-04-30", flag: 0, riferimento: "D.Lgs. 9 aprile 2008, n. 81" },
  { nome: "Testo unico stupefacenti", chiavi: ["testo unico stupefacenti", "stupefacenti", "dpr 309"], codice: "090G0363", dataGU: "1990-10-31", flag: 0, riferimento: "D.P.R. 9 ottobre 1990, n. 309" },
  { nome: "Testo unico documentazione amministrativa", chiavi: ["testo unico documentazione amministrativa", "documentazione amministrativa", "dpr 445"], codice: "001G0049", dataGU: "2001-02-20", flag: 0, riferimento: "D.P.R. 28 dicembre 2000, n. 445" },
  { nome: "Testo unico espropriazioni", chiavi: ["testo unico espropri", "espropriazioni", "dpr 327"], codice: "001G0372", dataGU: "2001-08-16", flag: 0, riferimento: "D.P.R. 8 giugno 2001, n. 327" },
  { nome: "Testo unico società a partecipazione pubblica", chiavi: ["tusp", "societa partecipate", "partecipate pubbliche"], codice: "16G00188", dataGU: "2016-09-08", flag: 0, riferimento: "D.Lgs. 19 agosto 2016, n. 175" },
  { nome: "Testo unico successioni e donazioni", chiavi: ["testo unico successioni", "imposta successioni", "successioni e donazioni"], codice: "090G0384", dataGU: "1990-11-27", flag: 1, riferimento: "D.Lgs. 31 ottobre 1990, n. 346 (testo unico allegato)" },
  { nome: "Processo tributario", chiavi: ["processo tributario", "contenzioso tributario", "dlgs 546"], codice: "093G0007", dataGU: "1993-01-13", flag: 0, riferimento: "D.Lgs. 31 dicembre 1992, n. 546" },
  { nome: "Legge fallimentare", chiavi: ["legge fallimentare", "l fall", "rd 267", "fallimento"], codice: "042U0267", dataGU: "1942-04-06", flag: 1, riferimento: "R.D. 16 marzo 1942, n. 267", nota: "per le procedure aperte dal 15/7/2022 si applica il Codice della crisi (D.Lgs. 14/2019)" },
  { nome: "Riscossione entrate patrimoniali (ingiunzione fiscale)", chiavi: ["ingiunzione fiscale", "rd 639", "riscossione entrate patrimoniali"], codice: "010U0639", dataGU: "1910-09-30", flag: 1, riferimento: "R.D. 14 aprile 1910, n. 639" },
  { nome: "Statuto dei lavoratori", chiavi: ["statuto lavoratori", "statuto dei lavoratori", "legge 300"], codice: "070U0300", dataGU: "1970-05-27", flag: 0, riferimento: "L. 20 maggio 1970, n. 300" },
  { nome: "Procedimento amministrativo (L. 241/1990)", chiavi: ["legge 241", "procedimento amministrativo", "241/1990"], codice: "090G0294", dataGU: "1990-08-18", flag: 0, riferimento: "L. 7 agosto 1990, n. 241" },
  { nome: "Sanzioni amministrative (L. 689/1981)", chiavi: ["legge 689", "sanzioni amministrative", "depenalizzazione", "689/1981"], codice: "081U0689", dataGU: "1981-11-30", flag: 0, riferimento: "L. 24 novembre 1981, n. 689" },
  { nome: "Ordinamento penitenziario", chiavi: ["ordinamento penitenziario", "legge 354"], codice: "075U0354", dataGU: "1975-08-09", flag: 0, riferimento: "L. 26 luglio 1975, n. 354" },
  { nome: "Locazioni di immobili urbani (L. 392/1978)", chiavi: ["legge 392", "equo canone", "locazioni urbane"], codice: "078U0392", dataGU: "1978-07-29", flag: 0, riferimento: "L. 27 luglio 1978, n. 392" },
  { nome: "Responsabilità amministrativa degli enti (D.Lgs. 231/2001)", chiavi: ["dlgs 231", "231", "responsabilita enti", "231/2001"], codice: "001G0293", dataGU: "2001-06-19", flag: 0, riferimento: "D.Lgs. 8 giugno 2001, n. 231" },
];

function compatta(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
}

/**
 * Trova il corpo normativo corrispondente a un nome comune (es. "codice civile",
 * "c.p.", "TU edilizia"). Restituisce la voce oppure un errore con suggerimenti.
 */
function trovaCorpoNormativo(nome: string): { corpo: CorpoNormativo } | { error: string } {
  const q = compatta(nome);
  if (!q) return { error: "Nome del codice vuoto. Usa il tool corpi_normativi per l'elenco." };

  const esatti = CORPI_NORMATIVI.filter((c) => compatta(c.nome) === q || c.chiavi.some((k) => compatta(k) === q));
  if (esatti.length >= 1) return { corpo: esatti[0] };

  if (q.length >= 5) {
    const parziali = CORPI_NORMATIVI.filter((c) => compatta(c.nome).includes(q) || c.chiavi.some((k) => compatta(k).includes(q)));
    if (parziali.length === 1) return { corpo: parziali[0] };
    if (parziali.length > 1) {
      return { error: `Più corpi normativi corrispondono a "${nome}": ${parziali.map((c) => c.nome).join("; ")}. Specifica meglio il nome (vedi tool corpi_normativi).` };
    }
  }
  return { error: `Corpo normativo "${nome}" non riconosciuto. Usa il tool corpi_normativi per l'elenco dei nomi supportati, oppure identifica l'atto con tipo_atto + numero + anno.` };
}

// ============================================================================
// SERVER MCP
// ============================================================================

const server = new McpServer(
  {
    name: "normattiva",
    version: "1.1.0",
  },
  {
    instructions: `Server MCP per la normativa italiana (banca dati ufficiale Normattiva). I testi restituiti sono nella versione vigente (multivigente), salvo diversa data_vigenza.

Come scegliere lo strumento:
1. Articolo di un codice/testo unico noto (es. art. 2043 c.c., art. 575 c.p., art. 29 c.p.a., art. 36 TU pubblico impiego): dettaglio_atto con nome_codice (+articolo, eventualmente estensione='bis'/'ter'/...). L'elenco dei nomi supportati è nel tool corpi_normativi.
2. Atto identificato da una citazione (es. D.Lgs. 152/2006, L. 241/1990): dettaglio_atto con tipo_atto + numero + anno (+articolo). Nessuna ricerca preliminare necessaria.
3. Ricerca tematica o atto non identificato: ricerca_semplice o ricerca_avanzata, poi dettaglio_atto con codice_redazionale + data_gu presi dai risultati.
4. Novità e modifiche normative in un periodo: atti_aggiornati.
I codici e i testi unici approvati con decreto (codice civile, penale, ecc.) hanno gli articoli negli allegati dell'atto: dettaglio_atto li gestisce automaticamente (nome_codice seleziona già l'allegato giusto).`,
  }
);

// --------------------------------------------------------------------------
// TOOL: ricerca_semplice
// --------------------------------------------------------------------------
server.tool(
  "ricerca_semplice",
  `Ricerca semplice nella banca dati Normattiva: cerca atti normativi italiani per parole chiave nel titolo e nel testo. Usala per esplorazioni tematiche o quando l'atto non è identificato. Se l'atto è già noto NON serve la ricerca: usa direttamente dettaglio_atto (nome_codice per i codici/testi unici, oppure tipo_atto+numero+anno). Restituisce la lista degli atti trovati con i riferimenti pronti per dettaglio_atto.`,
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
  `Trova i metadati di un atto normativo specifico quando conosci tipo, numero e anno (es. "D.Lgs. 152/2006" -> tipo='DECRETO LEGISLATIVO', numero=152, anno=2006). Restituisce i riferimenti (codice redazionale, data GU). Se ti serve direttamente il TESTO dell'atto o di un articolo, salta questo passaggio e usa subito dettaglio_atto con gli stessi tipo_atto+numero+anno.`,
  {
    tipo_atto: z.string().describe("Tipo di atto: i valori più comuni sono 'LEGGE', 'DECRETO LEGISLATIVO', 'DECRETO-LEGGE', 'DECRETO DEL PRESIDENTE DELLA REPUBBLICA', 'DECRETO DEL PRESIDENTE DEL CONSIGLIO DEI MINISTRI', 'LEGGE COSTITUZIONALE', 'COSTITUZIONE', 'REGIO DECRETO', 'REGIO DECRETO-LEGGE', 'DECRETO MINISTERIALE', 'REGOLAMENTO', 'ORDINANZA'. L'elenco completo è nel tool tipi_atto."),
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
  `Recupera il testo di un atto normativo dalla banca dati Normattiva (versione vigente). Identifica l'atto in uno di questi modi, in ordine di preferenza: (a) nome_codice per codici, testi unici e leggi fondamentali (es. nome_codice='codice civile' articolo=2043; nome_codice='c.p.' articolo=575): seleziona automaticamente l'atto e l'allegato giusti — elenco dei nomi nel tool corpi_normativi; (b) tipo_atto + numero + anno (es. 'DECRETO LEGISLATIVO' 152 2006), senza ricerca preliminare; (c) codice_redazionale + data_gu dai risultati di ricerca; (d) solo codice_redazionale (data GU risolta automaticamente). Per gli articoli con estensione usa 'estensione' (es. articolo=609, estensione='bis'). Senza 'articolo' restituisce l'intestazione e l'art. 1; 'testo_completo'=true recupera l'intero testo (max 40 articoli). I testi unici/codici approvati con decreto hanno gli articoli negli allegati: vengono cercati automaticamente anche lì.`,
  {
    nome_codice: z.string().optional().describe("Nome comune di un codice/testo unico/legge fondamentale (es. 'codice civile', 'c.p.', 'c.p.a.', 'TU edilizia', 'TUB', 'legge 241'). Identifica direttamente l'atto e l'allegato corretti. Elenco completo nel tool corpi_normativi."),
    codice_redazionale: z.string().optional().describe("Codice redazionale dell'atto (es. '006G0171', '010U0639'), dai risultati di ricerca. In alternativa usa nome_codice oppure tipo_atto+numero+anno."),
    data_gu: z.string().optional().describe("Data di pubblicazione in Gazzetta Ufficiale (YYYY-MM-DD, campo 'dataGU' dei risultati). Se omessa viene risolta automaticamente."),
    tipo_atto: z.string().optional().describe("Tipo di atto per identificarlo senza codice (es. 'LEGGE', 'DECRETO LEGISLATIVO', 'REGIO DECRETO', 'DECRETO DEL PRESIDENTE DELLA REPUBBLICA'). Da usare con 'numero' e 'anno'."),
    numero: z.number().int().optional().describe("Numero dell'atto (con tipo_atto e anno)."),
    anno: z.number().int().optional().describe("Anno dell'atto (con tipo_atto e numero)."),
    articolo: z.number().int().min(1).optional().describe("Numero dell'articolo da recuperare (es. 192). Se omesso, restituisce l'intestazione e l'art. 1."),
    estensione: z.string().optional().describe("Estensione dell'articolo: 'bis', 'ter', 'quater', ... fino a 'vicies' (es. articolo=609 + estensione='bis' per l'art. 609-bis). Richiede 'articolo'."),
    allegato: z.number().int().min(0).optional().describe("Sezione dell'atto in cui cercare: 0 = corpo dell'atto, 1..N = allegato N-esimo. Normalmente NON serve: corpo e allegati vengono esplorati automaticamente (e nome_codice imposta già la sezione giusta)."),
    data_vigenza: z.string().optional().describe("Data di vigenza (YYYY-MM-DD) per ottenere il testo vigente a quella data. Se omesso, versione vigente attuale."),
    testo_completo: z.boolean().default(false).describe("Se true, recupera tutti gli articoli dell'atto (fino a un massimo di 40). Ignorato se è specificato 'articolo'."),
  },
  async ({ nome_codice, codice_redazionale, data_gu, tipo_atto, numero, anno, articolo, estensione, allegato, data_vigenza, testo_completo }) => {
    const out = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
    const bad = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
    try {
      // Identificazione dell'atto: nome_codice (mappa cablata) oppure resolveAtto.
      let cr: string;
      let dg: string;
      let flagFisso: number | undefined = allegato != null ? allegato : undefined;
      let corpoNome: string | undefined;
      let corpoNota: string | undefined;

      if (nome_codice) {
        const m = trovaCorpoNormativo(nome_codice);
        if ("error" in m) return bad(m.error);
        cr = m.corpo.codice;
        dg = m.corpo.dataGU;
        corpoNome = `${m.corpo.nome} — ${m.corpo.riferimento}`;
        corpoNota = m.corpo.nota;
        if (flagFisso == null) flagFisso = m.corpo.flag;
      } else {
        const resolved = await resolveAtto({ codice_redazionale, data_gu, tipo_atto, numero, anno });
        if ("error" in resolved) return bad(resolved.error);
        cr = resolved.codiceRedazionale;
        dg = resolved.dataGU;
      }

      // Estensione dell'articolo (-bis, -ter, ...) -> campo sottoArticolo dell'API.
      let sottoArt: number | undefined;
      if (estensione) {
        if (articolo == null) return bad("'estensione' richiede anche 'articolo' (es. articolo=609, estensione='bis').");
        const s = SOTTO_ARTICOLO[normalizzaEstensione(estensione)];
        if (!s) return bad(`Estensione '${estensione}' non riconosciuta. Valori supportati: ${Object.keys(SOTTO_ARTICOLO).join(", ")}.`);
        sottoArt = s;
      }

      const baseBody: Record<string, unknown> = {
        dataGU: dg,
        codiceRedazionale: cr,
      };
      if (data_vigenza) baseBody.dataVigenza = data_vigenza;
      const CAP = 40;
      const etichettaArt = articolo != null ? `${articolo}${estensione ? `-${normalizzaEstensione(estensione)}` : ""}` : "";
      const conCorpo = (intest: string) =>
        corpoNome ? `[${corpoNome}]${corpoNota ? `\n(Nota: ${corpoNota})` : ""}\n${intest}` : intest;

      // === Caso 1: articolo specifico (ricerca automatica in corpo e allegati) ===
      if (articolo != null) {
        const r = await fetchArticoloAuto(baseBody, articolo, sottoArt, flagFisso);
        if (r.res.kind === "notfound") {
          const dove = corpoNome ? `in "${corpoNome}"` : `per l'atto ${cr} (dataGU ${dg})`;
          return bad(`Articolo ${etichettaArt} non trovato ${dove}. Verifica il numero e l'eventuale estensione; per gli atti generici controlla codice_redazionale/data_gu con una ricerca.`);
        }
        if (r.res.kind === "error") {
          return bad(`Errore nel recupero dell'articolo ${etichettaArt} (HTTP ${r.res.status}).`);
        }
        const intest = conCorpo(formatIntestazioneAtto(r.atto, cr, dg, data_vigenza));
        if (r.res.kind === "empty") {
          return out(`${intest}\n\nIl testo dell'articolo ${etichettaArt} non è disponibile (atto molto recente o articolo privo di testo consolidato).`);
        }
        const nota = flagFisso == null && r.flagUsato > 0 ? ` *(dall'allegato ${r.flagUsato})*` : "";
        return out(`${intest}\n\n---\n**${r.res.label}**${nota}\n${r.res.testo}`);
      }

      // === Caso 2: testo completo ===
      if (testo_completo) {
        // Sezione fissata (nome_codice o allegato esplicito): scorri solo quella.
        if (flagFisso != null) {
          const w = await walkArticoli(baseBody, flagFisso, CAP);
          if (w.articoli.length === 0) {
            if (w.atto) return out(`${conCorpo(formatIntestazioneAtto(w.atto, cr, dg, data_vigenza))}\n\nNessun articolo trovato nella sezione richiesta (allegato ${flagFisso}).`);
            return bad(`Nessun contenuto trovato nella sezione richiesta (allegato ${flagFisso}) per l'atto ${cr} (dataGU ${dg}).`);
          }
          const intest = conCorpo(formatIntestazioneAtto(w.atto, cr, dg, data_vigenza));
          const parts = w.articoli.map((a) => `**${a.label}**\n${a.testo}`);
          let o = `${intest}\n\n${parts.join("\n\n---\n")}`;
          if (!w.ended) o += `\n\n---\n*Testo troncato ai primi ${CAP} articoli. Usa \`articolo=N\` per i successivi.*`;
          o += `\n*Gli articoli con estensione (-bis, -ter, ...) non compaiono nello scorrimento: recuperali con articolo=N + estensione.*`;
          return out(o);
        }
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
          // Segnala eventuali allegati ulteriori (es. codice civile = allegato 2 del R.D. 262/1942).
          const succ = await fetchDettaglioArticolo(baseBody, 1, 2);
          if (succ.res.kind === "article") o += `\n*L'atto contiene ulteriori allegati: usa \`allegato=2\` (o superiore) per consultarli.*`;
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
      // Sezione fissata (nome_codice o allegato esplicito): mostra l'art. 1 di quella sezione.
      if (flagFisso != null) {
        const a1f = await fetchDettaglioArticolo(baseBody, 1, flagFisso);
        if (a1f.res.kind === "article") {
          const intest = conCorpo(formatIntestazioneAtto(a1f.atto, cr, dg, data_vigenza));
          return out(`${intest}\n\n---\n**${a1f.res.label}**\n${a1f.res.testo}\n\n---\n*Usa \`articolo=N\` (con eventuale \`estensione\`) per un articolo specifico, oppure \`testo_completo=true\` per l'intero testo.*`);
        }
        if (a1f.res.kind === "error") return bad(`Errore nel recupero dell'atto (HTTP ${a1f.res.status}).`);
        if (a1f.res.kind === "empty" && a1f.atto) {
          return out(`${conCorpo(formatIntestazioneAtto(a1f.atto, cr, dg, data_vigenza))}\n\nIl testo consolidato non è disponibile per questa sezione.`);
        }
        return bad(`Nessun articolo trovato nella sezione richiesta (allegato ${flagFisso}) per l'atto ${cr} (dataGU ${dg}).`);
      }
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
// TOOL: corpi_normativi
// --------------------------------------------------------------------------
server.tool(
  "corpi_normativi",
  `Elenco dei principali corpi normativi italiani (Costituzione, codici, testi unici, leggi fondamentali) interrogabili direttamente con dettaglio_atto tramite il parametro nome_codice — es. dettaglio_atto(nome_codice='codice civile', articolo=2043). Usa questo strumento quando l'utente cita un codice o testo unico (c.c., c.p., c.p.c., c.p.p., c.p.a., TU edilizia, TUB, TUF, TUEL, ecc.) e vuoi scoprire il valore esatto di nome_codice, oppure per sapere quali corpi sono disponibili.`,
  {
    filtro: z.string().optional().describe("Filtro testuale sul nome (es. 'penale', 'edilizia', 'tributario'). Se omesso, elenca tutto."),
  },
  async ({ filtro }) => {
    const q = filtro ? compatta(filtro) : "";
    const voci = CORPI_NORMATIVI.filter((c) =>
      !q || compatta(c.nome).includes(q) || c.chiavi.some((k) => compatta(k).includes(q)) || compatta(c.riferimento).includes(q)
    );
    if (voci.length === 0) {
      return { content: [{ type: "text", text: `Nessun corpo normativo corrisponde a "${filtro}". Prova senza filtro, oppure identifica l'atto con tipo_atto + numero + anno.` }] };
    }
    let testo = `**Corpi normativi interrogabili con dettaglio_atto(nome_codice=...)** — ${voci.length} voci\n\n`;
    testo += `| nome_codice | Atto | Alias |\n|---|---|---|\n`;
    for (const c of voci) {
      const nota = c.nota ? ` — ⚠ ${c.nota}` : "";
      testo += `| ${c.nome} | ${c.riferimento}${nota} | ${c.chiavi.slice(0, 3).join(", ")} |\n`;
    }
    testo += `\nEsempio: \`dettaglio_atto(nome_codice="codice civile", articolo=2043)\` — estensioni: \`articolo=609, estensione="bis"\`.`;
    return { content: [{ type: "text", text: testo }] };
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

      // L'API restituisce voci duplicate (stessa collezione ripetuta con conteggi
      // leggermente diversi): dedup per nome tenendo il conteggio più alto.
      const uniche = new Map<string, number>();
      for (const col of data) {
        const prev = uniche.get(col.nomeCollezione);
        if (prev == null || col.numeroAtti > prev) uniche.set(col.nomeCollezione, col.numeroAtti);
      }

      let result = "**Collezioni predefinite disponibili:**\n\n";
      for (const [nome, numeroAtti] of [...uniche.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        result += `- **${nome}**: ${numeroAtti} atti\n`;
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
