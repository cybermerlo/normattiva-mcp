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
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

// ============================================================================
// CONFIGURAZIONE
// ============================================================================

const BASE_URL = "https://api.normattiva.it/t/normattiva.api";
const BASE_URL_PRE = "https://pre.api.normattiva.it/t/normattiva.api"; // ambiente test
const API_PREFIX = "/bff-opendata/v1/api/v1";

// Usa l'ambiente di produzione per default. NORMATTIVA_API_BASE serve SOLO ai
// test in locale (scripts/test-guasti.mjs punta il server a un finto Normattiva
// che simula i guasti): in produzione non va impostata.
const API_BASE = process.env.NORMATTIVA_API_BASE || `${BASE_URL}${API_PREFIX}`;

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

// Timeout per singola richiesta HTTP: senza, una connessione appesa verso
// Normattiva blocca il tool fino al timeout del connettore (errore opaco lato
// Claude). 30s lascia margine anche alle risposte lente dell'API.
const FETCH_TIMEOUT_MS = 30_000;

// Budget complessivo di una singola chiamata al tool. Il timeout sopra vale per
// UNA richiesta HTTP, ma `testo_completo` ne incatena fino a 40: senza un tetto
// complessivo la chiamata dura quanto la somma (misurati 31-49s su L. 241/1990),
// supera il timeout del connettore e l'utente vede un errore opaco invece del
// testo. Meglio restituire un risultato parziale ed etichettato, in tempo utile.
// Dentro il budget anche il timeout di ogni richiesta si accorcia a quanto resta
// (vedi apiPostStatus). NORMATTIVA_BUDGET_MS serve solo ai test in locale.
const BUDGET_TOOL_MS = (() => {
  const v = Number(process.env.NORMATTIVA_BUDGET_MS);
  return Number.isFinite(v) && v >= 1_000 ? v : 40_000;
})();

// Tetto alla dimensione di un singolo risultato. Oltre il limite di token del
// client la risposta viene rifiutata in blocco (di nuovo: errore opaco, zero
// contenuto). Troncare qui, dicendolo, degrada molto meglio.
//
// Il tetto è in caratteri perché è ciò che possiamo contare, ma il limite vero
// del client è in token, e il rapporto NON è quello dell'inglese: il testo
// giuridico italiano (accentate, sigle, richiami, righe corte) tokenizza molto
// peggio. Misure attraverso un client con limite di 25k token per risultato:
// 20.616 caratteri accettati, 62.295 e 65.751 RIFIUTATI — cioè meno di ~2,6
// caratteri per token. Il default resta quindi ben sotto la soglia nota di
// rifiuto, e si regola con NORMATTIVA_MAX_RISPOSTA_CHAR per client con limiti
// diversi (l'errore da evitare è tarare questo valore su una stima ottimistica).
const MAX_RISPOSTA_CHAR = (() => {
  const v = Number(process.env.NORMATTIVA_MAX_RISPOSTA_CHAR);
  return Number.isFinite(v) && v >= 2_000 ? Math.floor(v) : 40_000;
})();

/**
 * Tronca una risposta troppo grande spiegando come restringerla, invece di
 * lasciare che il client la rifiuti per intero.
 */
function limitaTesto(testo: string, comeRestringere: string): string {
  if (testo.length <= MAX_RISPOSTA_CHAR) return testo;
  const tagliato = testo.slice(0, MAX_RISPOSTA_CHAR);
  // Chiudi preferibilmente sull'ultimo separatore fra articoli, così l'ultimo
  // articolo mostrato è completo e non resta un'intestazione senza testo;
  // in mancanza, ripiega sull'ultimo a capo per non spezzare una riga a metà.
  const separatore = tagliato.lastIndexOf("\n\n---\n");
  const confine = separatore > MAX_RISPOSTA_CHAR * 0.8 ? separatore : tagliato.lastIndexOf("\n");
  const corpo = confine > MAX_RISPOSTA_CHAR * 0.8 ? tagliato.slice(0, confine) : tagliato;
  return `${corpo}\n\n---\n*⚠️ Risposta TRONCATA: superava il limite di dimensione di un singolo risultato (${MAX_RISPOSTA_CHAR} caratteri). Quanto sopra è parziale. ${comeRestringere}*`;
}

/**
 * Messaggio leggibile per gli status HTTP ricorrenti dell'API Normattiva,
 * così Claude (e l'utente) sanno cosa fare invece di vedere un codice nudo.
 */
function spiegaHttp(status: number): string {
  if (status === 409 || status === 429) {
    return `HTTP ${status}: richiesta bloccata temporaneamente dai sistemi di protezione di Normattiva (anti-bot/rate limit). Attendi qualche secondo e riprova, evitando richieste massive ravvicinate.`;
  }
  if (status === 404) return "HTTP 404: risorsa non trovata su Normattiva.";
  if (status >= 500) return `HTTP ${status}: errore temporaneo dei server Normattiva. Riprova tra qualche istante.`;
  return `HTTP ${status}`;
}

/**
 * Estrae il messaggio d'errore che l'API mette nel corpo della risposta.
 * Senza questo si perde l'unica spiegazione utile: un HTTP 400 nudo non dice
 * nulla, mentre il corpo riporta ad es. "Numero di atti superiore al limite
 * consentito di 7000, raffinare la ricerca" — che indica esattamente il rimedio.
 */
function messaggioApi(corpo: string): string {
  if (!corpo) return "";
  try {
    const j = JSON.parse(corpo);
    const m = j?.message ?? j?.error ?? j?.descrizione;
    if (typeof m === "string" && m.trim()) {
      return j?.code ? `${m.trim()} (codice ${j.code})` : m.trim();
    }
  } catch {
    // Corpo non JSON: usiamo comunque le prime righe, meglio di niente.
  }
  return corpo.slice(0, 200).replace(/\s+/g, " ").trim();
}

/**
 * fetch con timeout (AbortController) e un retry sugli errori transitori:
 * rete, timeout, 502/503/504 e 409/429 (l'anti-bot del Poligrafico risponde
 * 409 anche a burst legittimi: una breve pausa di solito basta).
 * Gli status "semantici" (404 = non trovato, 500 = parametri errati)
 * non vengono ritentati.
 */
async function fetchRetry(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if ([409, 429].includes(res.status) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (![502, 503, 504].includes(res.status) || attempt === 1) return res;
    } catch (e) {
      lastErr = e;
      if (attempt === 1) {
        if ((e as Error)?.name === "AbortError") {
          throw new Error(`Nessuna risposta da Normattiva entro ${FETCH_TIMEOUT_MS / 1000}s (timeout). Riprova tra qualche istante.`);
        }
        throw e;
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  if (lastErr instanceof Error && lastErr.name === "AbortError") {
    throw new Error(`Nessuna risposta da Normattiva entro ${FETCH_TIMEOUT_MS / 1000}s (timeout). Riprova tra qualche istante.`);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ============================================================================
// CACHE (LRU + TTL)
// ============================================================================
// I testi vigenti cambiano di rado: ricolpire Normattiva a ogni richiesta
// aggiunge latenza e, sotto burst (testo_completo, più utenti sullo stesso
// server), rischia il blocco anti-bot dell'IP. Cache in-memory con TTL per
// endpoint e tetto di voci: il processo resta vivo tra le richieste (stdio
// come dietro supergateway), quindi la cache paga da subito.

const CACHE_MAX = 500;
const cache = new Map<string, { exp: number; val: unknown }>();

function cacheTtlFor(endpoint: string): number {
  if (endpoint.startsWith("/atto/dettaglio-atto")) return 6 * 3_600_000;    // 6 ore
  if (endpoint.startsWith("/tipologiche") || endpoint.startsWith("/collections")) return 24 * 3_600_000;
  if (endpoint.startsWith("/ricerca")) return 30 * 60_000;                  // 30 minuti
  return 0;
}

function cacheGet(key: string): unknown {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) {
    cache.delete(key);
    return undefined;
  }
  // Rinfresca la posizione LRU (Map preserva l'ordine di inserimento).
  cache.delete(key);
  cache.set(key, e);
  return e.val;
}

function cacheSet(key: string, val: unknown, ttl: number): void {
  if (ttl <= 0) return;
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { exp: Date.now() + ttl, val });
}

async function apiGet(endpoint: string): Promise<unknown> {
  const key = `GET ${endpoint}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  const url = `${API_BASE}${endpoint}`;
  console.error(`[Normattiva MCP] GET ${url}`);

  const response = await fetchRetry(url, {
    method: "GET",
    headers: GET_HEADERS,
  });

  if (!response.ok) {
    const dettaglio = messaggioApi(await response.text().catch(() => ""));
    throw new Error(`Errore API Normattiva — ${spiegaHttp(response.status)}${dettaglio ? `: ${dettaglio}` : ""}`);
  }

  const data = await response.json();
  cacheSet(key, data, cacheTtlFor(endpoint));
  return data;
}

async function apiPost(endpoint: string, body: unknown): Promise<unknown> {
  const key = `POST ${endpoint} ${JSON.stringify(body)}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  const url = `${API_BASE}${endpoint}`;
  console.error(`[Normattiva MCP] POST ${url}`);
  console.error(`[Normattiva MCP] Body: ${JSON.stringify(body)}`);

  const response = await fetchRetry(url, {
    method: "POST",
    headers: COMMON_HEADERS,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const dettaglio = messaggioApi(await response.text().catch(() => ""));
    throw new Error(`Errore API Normattiva — ${spiegaHttp(response.status)}${dettaglio ? `: ${dettaglio}` : ""}`);
  }

  // Alcune API restituiscono testo semplice (es. token), altre JSON
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  cacheSet(key, data, cacheTtlFor(endpoint));
  return data;
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

  // Aggiungi le facet se presenti. Sono un ausilio alla navigazione, non il
  // contenuto: su una ricerca ampia la sola faccetta per anno arriva a 60+ righe
  // (più lunga dei risultati stessi), quindi mostriamo solo le più consistenti.
  if (data.facetMap) {
    const FACET_MAX = 12;
    const blocco = (titolo: string, voci: any[] | undefined, etichetta: (f: any) => string) => {
      if (!voci?.length) return "";
      let s = `\n${titolo}:\n`;
      for (const f of voci.slice(0, FACET_MAX)) s += `  - ${etichetta(f)}: ${f.valore} risultati\n`;
      if (voci.length > FACET_MAX) s += `  - (altre ${voci.length - FACET_MAX} voci non elencate)\n`;
      return s;
    };
    const facet =
      blocco("Per tipo di atto", data.facetMap.codice_tipo_provvedimento, (f) => f.descrizione || f.codice) +
      blocco("Per anno", data.facetMap.anno_provvedimento, (f) => f.descrizione);
    if (facet) result += `\n---\n**Filtri disponibili:**\n${facet}`;
  }

  return result;
}

/**
 * Impagina lato server una risposta già completa.
 *
 * Serve per /ricerca/aggiornati, che IGNORA la paginazione richiesta e
 * restituisce sempre l'intero elenco del periodo (verificato: 170 atti in
 * risposta a numeroElementiPerPagina=5, con numeroPagine=1). Senza questo taglio
 * una finestra di pochi mesi produce centinaia di migliaia di caratteri — 243k
 * su 7 mesi — che sforano il limite di dimensione di un risultato e fanno
 * fallire l'intera chiamata.
 *
 * Se un domani l'endpoint rispettasse la paginazione, la lista arriverebbe già
 * corta e la funzione non farebbe nulla.
 */
function impaginaLocalmente(data: any, pagina: number, perPagina: number): any {
  const lista: any[] = Array.isArray(data?.listaAtti) ? data.listaAtti : [];
  // L'API ha impaginato davvero solo se dichiara più di una pagina: in quel caso
  // la lista è già la fetta giusta e ritagliarla di nuovo la falserebbe.
  // Il test NON può essere "lista più corta di una pagina": con pochi risultati
  // la risposta non impaginata è corta lo stesso, e una pagina fuori intervallo
  // finirebbe per restituire in silenzio la prima.
  if ((data?.numeroPagine ?? 1) > 1) return data;

  const numeroPagine = Math.max(1, Math.ceil(lista.length / perPagina));
  const inizio = (pagina - 1) * perPagina;
  return {
    ...data,
    listaAtti: lista.slice(inizio, inizio + perPagina),
    numeroAttiTrovati: data?.numeroAttiTrovati ?? lista.length,
    paginaCorrente: pagina,
    numeroPagine,
  };
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
  s = s.replace(/&#(\d+);/g, (_m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ""; } });
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } });
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

// ============================================================================
// ESITI DELL'API: CLASSIFICAZIONE E RITENTATIVI
// ============================================================================
//
// ⚠️ Dal 2026-09-17 l'endpoint /atto/dettaglio-atto sbaglia a intermittenza su
// oltre metà delle richieste (misurato sul server il 18/09: 53% HTTP 404 + 7%
// HTTP 500, contro il 5% di errori della settimana prima). In entrambi i casi il
// corpo è lo stesso:
//     {"message":"Errore generico della chiamata, riprovare più tardi","code":"1000"}
// e arriva in ~6 ms lato server (una risposta vera ne richiede ~120). Per lo
// stesso articolo lo status (404 o 500) cambia a caso da una chiamata all'altra.
// Il server traduceva quel 404 in "Articolo N non trovato... Verifica il numero"
// (e lo teneva in cache per 6 ore): un modello concludeva che articoli come il
// 1218 o il 2697 c.c. non esistono.
//
// Il corpo del 404 però distingue i casi (verificato sull'API il 2026-10-24):
//  - articolo o allegato inesistente: un messaggio che ripete la richiesta, es.
//    {"message":"dataPubblicazioneGazzetta:... idArticolo:2999 ... flagTipoArticolo:2","code":null};
//  - codice redazionale e data GU che non individuano un atto (es. la data
//    dell'atto al posto di quella della Gazzetta): {"message":"Atto non trovato"};
//  - il guasto: il corpo generico qui sopra, che non dice nulla sull'articolo.
// Lo stesso corpo generico arriva, con HTTP 500, anche per una data malformata
// (es. dataVigenza "2020/01/01"): per questo le date si controllano prima, negli
// schemi dei tool (vedi dataApi). Ogni risposta si classifica una volta sola,
// qui, e si ritenta solo ciò che ritentando può cambiare.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Base del backoff esponenziale: 0,5 s → 1 → 2 (tetto), ±25% di jitter. Gli
// errori del guasto sono indipendenti da una richiesta all'altra: attese più
// lunghe non li fanno sparire prima, consumano solo il budget di tempo.
// NORMATTIVA_BACKOFF_MS serve solo ai test in locale, per non aspettare.
const BACKOFF_BASE_MS = (() => {
  const v = Number(process.env.NORMATTIVA_BACKOFF_MS);
  return Number.isFinite(v) && v >= 1 ? v : 500;
})();

/** Pausa prima del tentativo n+1. Più lunga dopo un blocco anti-bot (409/429). */
function attesaBackoff(n: number, status: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_BASE_MS * 4);
  const minimo = status === 409 || status === 429 ? BACKOFF_BASE_MS * 4 : 0;
  return Math.round(Math.max(base, minimo) * (0.75 + Math.random() * 0.5));
}

// Sotto questo margine dalla scadenza non si avvia un'altra richiesta: non
// farebbe in tempo a rispondere.
const MIN_RICHIESTA_MS = 500;

/** Riconosce il corpo dell'errore generico dell'API (vedi sopra). */
function erroreGenerico(data: any): boolean {
  if (!data || typeof data !== "object") return false;
  if (String(data.code ?? "") === "1000") return true;
  return /riprovare pi(ù|u') tardi/i.test(String(data.message ?? ""));
}

/**
 * Classe di una risposta dell'API (vedi sopra):
 *  - "ok": 200 completo;
 *  - "assente": 404 con un messaggio sull'articolo richiesto: l'articolo (o
 *    l'allegato) non c'è. Definitivo;
 *  - "atto": 404 «Atto non trovato»: codice redazionale e data GU non
 *    individuano un atto. Definitivo;
 *  - "transitorio": errore generico (404 o 500), altri 5xx, rete, timeout, 200
 *    incompleto (es. pagina HTML), 404 dal corpo illeggibile: può sparire
 *    ritentando, e non dice nulla sull'esistenza del testo;
 *  - "bloccato": 409/429 dell'anti-bot, che colpisce tutto il server: un solo
 *    ritentativo, poi ci si ferma (insistere prolunga il blocco);
 *  - "permanente": 400 e simili, 500 con un messaggio specifico (es. parametri
 *    errati): ritentare non cambia l'esito.
 */
type Classe = "ok" | "assente" | "atto" | "transitorio" | "bloccato" | "permanente";

function classifica(endpoint: string, status: number, data: any): Classe {
  if (status === 200) {
    const completa = data != null && typeof data === "object" && !erroreGenerico(data) &&
      (!endpoint.startsWith("/atto/dettaglio-atto") || data?.data?.atto != null);
    return completa ? "ok" : "transitorio";
  }
  if (status === 409 || status === 429) return "bloccato";
  if (status === 0 || status > 500) return "transitorio";
  const msg = data != null && typeof data === "object" ? String(data.message ?? "").trim() : "";
  if (status === 404) {
    if (/^atto non trovato/i.test(msg)) return "atto";
    // Solo un messaggio che riguarda l'articolo prova che manca: il corpo
    // generico, o uno sconosciuto (es. la pagina HTML di un gateway), no.
    return /articolo/i.test(msg) && !erroreGenerico(data) ? "assente" : "transitorio";
  }
  if (status === 500) return erroreGenerico(data) || !msg ? "transitorio" : "permanente";
  return "permanente";
}

/**
 * Esito di una POST verso l'API. `status` 0 = nessuna risposta (rete/timeout).
 * `scaduto` = i ritentativi si sono fermati per il budget di tempo, quindi
 * l'esito non è definitivo.
 */
type EsitoApi = {
  status: number;
  data: any;
  classe: Classe;
  tentativi: number;
  scaduto?: boolean;
};

type OpzioniRetry = {
  /** Richieste massime (default 3). */
  tentativi?: number;
  /** Timestamp oltre il quale non si avviano altre richieste. */
  scadenza?: number;
};

/** Una sola POST, senza ritentativi. Non lancia eccezioni. */
async function postUnaVolta(endpoint: string, body: unknown, timeoutMs: number): Promise<Omit<EsitoApi, "tentativi">> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: COMMON_HEADERS,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const testo = await response.text();
    let data: any = testo;
    try {
      data = testo ? JSON.parse(testo) : null;
    } catch {
      // corpo non JSON (es. pagina d'errore HTML): resta testo
    }
    return { status: response.status, data, classe: classifica(endpoint, response.status, data) };
  } catch (e) {
    const entro = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)} s` : `${timeoutMs} ms`;
    const msg = (e as Error)?.name === "AbortError"
      ? `nessuna risposta entro ${entro} (timeout)`
      : `errore di rete: ${(e as Error)?.message ?? String(e)}`;
    return { status: 0, data: msg, classe: "transitorio" };
  } finally {
    clearTimeout(timer);
  }
}

/** Descrizione breve di un esito d'errore, per log e messaggi. */
function descriviEsito(e: { status: number; data: any }): string {
  if (e.status === 0) return String(e.data);
  if (e.status === 200 && !erroreGenerico(e.data)) return "HTTP 200 con risposta incompleta";
  const corpo = e.data == null ? "" : typeof e.data === "string" ? e.data : JSON.stringify(e.data);
  const msg = messaggioApi(corpo);
  return `HTTP ${e.status}${msg ? ` «${msg}»` : ""}`;
}

/**
 * POST che restituisce l'esito classificato senza lanciare eccezioni. Ritenta
 * con backoff gli esiti "transitorio" (fino a `tentativi` richieste) e, una
 * volta sola, "bloccato". Con `scadenza` non avvia richieste oltre il budget e
 * accorcia il timeout di ciascuna al tempo che resta.
 * Si cacheano SOLO le risposte 200 complete: un errore in cache restava
 * attaccato all'articolo per 6 ore in quella sessione, vanificando anche i
 * ritentativi di chi richiamava il tool (il check del monitor lo faceva: i
 * tentativi 2 e 3 tornavano "non trovato" in 0-4 ms, dalla cache).
 */
async function apiPostStatus(endpoint: string, body: unknown, opz: OpzioniRetry = {}): Promise<EsitoApi> {
  const key = `POSTS ${endpoint} ${JSON.stringify(body)}`;
  const hit = cacheGet(key) as EsitoApi | undefined;
  // dalla cache nessun tentativo è fallito
  if (hit !== undefined) return { ...hit, tentativi: 1 };

  const max = Math.max(1, opz.tentativi ?? 3);
  const log = (e: EsitoApi, coda: string) =>
    console.error(`[Normattiva MCP] ${endpoint} ${JSON.stringify(body)}: ${descriviEsito(e)} — ${coda}`);
  // Esito se il budget è finito prima ancora di cominciare.
  let esito: EsitoApi = { status: 0, data: "tempo a disposizione esaurito", classe: "transitorio", tentativi: 0, scaduto: true };
  for (let n = 1; n <= max; n++) {
    const resto = opz.scadenza == null ? FETCH_TIMEOUT_MS : opz.scadenza - Date.now();
    if (resto < MIN_RICHIESTA_MS) {
      esito = { ...esito, scaduto: true };
      break;
    }
    esito = { ...(await postUnaVolta(endpoint, body, Math.min(FETCH_TIMEOUT_MS, resto))), tentativi: n };
    if (esito.classe !== "transitorio" && esito.classe !== "bloccato") break;
    const limite = esito.classe === "bloccato" ? Math.min(max, 2) : max;
    if (n >= limite) {
      if (max > 1) log(esito, `tentativi esauriti (${n}/${limite})`);
      break;
    }
    const pausa = attesaBackoff(n, esito.status);
    if (opz.scadenza != null && Date.now() + pausa + MIN_RICHIESTA_MS > opz.scadenza) {
      esito.scaduto = true;
      log(esito, `tentativo ${n}/${limite}, tempo esaurito`);
      break;
    }
    log(esito, `tentativo ${n}/${limite}, riprovo fra ${pausa} ms`);
    await sleep(pausa);
  }
  if (esito.classe === "ok") cacheSet(key, esito, cacheTtlFor(endpoint));
  return esito;
}

/** Recupero non riuscito, con la classe che decide cosa dire e se insistere. */
type ErroreApi = {
  classe: "transitorio" | "bloccato" | "permanente";
  status: number;
  dettaglio: string;
  tentativi: number;
  scaduto?: boolean;
};

/** Il budget di tempo è finito prima di poter interrogare Normattiva. */
const TEMPO_ESAURITO: ErroreApi = { classe: "transitorio", status: 0, dettaglio: "tempo a disposizione esaurito", tentativi: 0, scaduto: true };

/** Esito non riuscito come ErroreApi ("assente" e "atto", fuori dal loro contesto, sono permanenti). */
function comeErrore(e: EsitoApi): ErroreApi {
  const classe = e.classe === "transitorio" || e.classe === "bloccato" ? e.classe : "permanente";
  return { classe, status: e.status, dettaglio: descriviEsito(e), tentativi: e.tentativi, scaduto: e.scaduto };
}

/**
 * Messaggio per un recupero non riuscito, secondo la classe dell'errore: chi
 * legge deve capire se riprovare, aspettare o correggere la richiesta, e che un
 * errore di Normattiva non dice nulla sull'esistenza del testo. `fallito` è la
 * frase su cosa non è riuscito; `esistenza` sostituisce quella standard.
 */
function spiegaErrore(e: ErroreApi, fallito: string, esistenza = "NON indica che il testo non esista."): string {
  if (e.classe === "bloccato") {
    return `⚠️ Normattiva sta bloccando temporaneamente le richieste di questo server (${e.dettaglio}, protezione anti-bot): ${fallito}. ${esistenza} Attendi almeno mezzo minuto prima di riprovare ed evita richieste ravvicinate o in parallelo; se il blocco persiste, dichiara all'utente che il testo non è stato recuperato, senza citarlo a memoria.`;
  }
  if (e.classe === "permanente") {
    return `Errore di Normattiva (${e.dettaglio}): ${fallito}. Ritentare non cambia l'esito: verifica i parametri della richiesta.`;
  }
  if (e.tentativi === 0) {
    return `⚠️ Tempo esaurito: ${fallito}, perché le richieste precedenti a Normattiva hanno occupato tutto il tempo a disposizione. ${esistenza} Riprova.`;
  }
  const quanti = `dopo ${e.tentativi} ${e.tentativi === 1 ? "tentativo" : "tentativi"}${e.scaduto ? ", poi il tempo a disposizione è finito" : ""}`;
  return `⚠️ Errore temporaneo di Normattiva: ${fallito} (${e.dettaglio}, ${quanti}). ${esistenza} Riprova tra qualche secondo: gli errori di Normattiva sono intermittenti e un nuovo tentativo spesso riesce. Se l'errore persiste, dichiara all'utente che il testo non è stato recuperato, senza citarlo a memoria.`;
}

type ArticoloResult =
  | { kind: "article"; label: string; testo: string; tentativi: number }
  | { kind: "empty"; tentativi: number }
  // L'articolo (o la sezione) non c'è: 404 specifico, vedi classifica.
  | { kind: "assente"; tentativi: number }
  // Codice redazionale e data GU non individuano un atto.
  | { kind: "atto"; tentativi: number }
  | ({ kind: "error" } & ErroreApi);

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
  opz: OpzioniRetry = {},
): Promise<{ res: ArticoloResult; atto: any }> {
  const body: Record<string, unknown> = { ...baseBody };
  if (idArticolo != null) body.idArticolo = idArticolo;
  if (flag != null) body.flagTipoArticolo = flag;
  if (sottoArticolo != null) body.sottoArticolo = sottoArticolo;
  const e = await apiPostStatus("/atto/dettaglio-atto", body, opz);
  if (e.classe === "assente" || e.classe === "atto") return { res: { kind: e.classe, tentativi: e.tentativi }, atto: null };
  if (e.classe !== "ok") return { res: { kind: "error", ...comeErrore(e) }, atto: null };

  const atto = e.data?.data?.atto ?? null;
  const ex = extractArticolo(atto?.articoloHtml ?? "", idArticolo);
  if (ex) return { res: { kind: "article", label: ex.label, testo: ex.testo, tentativi: e.tentativi }, atto };
  return { res: { kind: "empty", tentativi: e.tentativi }, atto };
}

// Richieste massime per un singolo articolo. Col guasto del settembre 2026
// (55-70% di errori, indipendenti da una richiesta all'altra: il 18/09 l'art.
// 734 c.p. ha dato 4 falsi 404 di fila e poi 200) 6 richieste falliscono tutte
// in ~3-10 casi su 100 invece di 55-70; con l'API sana basta la prima. Nel caso
// peggiore sono ~7,5 s di attese (fino a ~9,5 col jitter), dentro BUDGET_TOOL_MS.
const TENTATIVI_ARTICOLO = 6;

/**
 * Recupera un articolo cercandolo nel corpo dell'atto (flag 0) e poi negli
 * allegati (flag 1..3). Necessario per i decreti che "approvano" codici e testi
 * unici, dove gli articoli sostanziali stanno in un allegato (es. codice civile =
 * allegato 2 del R.D. 262/1942, c.p.a. = allegato 2 del D.Lgs. 104/2010).
 * Con `flagFisso` la ricerca è limitata a quella sola sezione.
 *
 * Vale la prima sezione, nell'ordine, che ha l'articolo: si passa alla
 * successiva solo quando in questa di sicuro non c'è ("assente"). Un errore,
 * anche dopo i ritentativi, chiude la ricerca: l'articolo poteva stare proprio
 * nella sezione in errore, e un allegato può avere un articolo con lo stesso
 * numero (es. il trattato allegato a una legge di ratifica), che verrebbe
 * restituito al posto di quello chiesto.
 */
async function fetchArticoloAuto(
  baseBody: Record<string, unknown>,
  idArticolo: number,
  sottoArticolo?: number,
  flagFisso?: number,
  opz: OpzioniRetry = {},
): Promise<{ res: ArticoloResult; atto: any; flagUsato: number }> {
  const tentativi: OpzioniRetry = { tentativi: opz.tentativi ?? TENTATIVI_ARTICOLO, scadenza: opz.scadenza };
  if (flagFisso != null) {
    return { ...(await fetchDettaglioArticolo(baseBody, idArticolo, flagFisso, sottoArticolo, tentativi)), flagUsato: flagFisso };
  }
  for (const f of [0, 1, 2, 3]) {
    const r = await fetchDettaglioArticolo(baseBody, idArticolo, f, sottoArticolo, tentativi);
    // "empty" nel corpo (atto recente senza testo consolidato) chiude la ricerca;
    // in un allegato (es. una tabella, senza articoli) no.
    if (r.res.kind !== "assente" && !(r.res.kind === "empty" && f > 0)) return { ...r, flagUsato: f };
  }
  return { res: { kind: "assente", tentativi: 1 }, atto: null, flagUsato: 3 };
}

/**
 * Perché la scansione degli articoli si è fermata. La distinzione conta: con
 * "fine" il testo arriva all'ultimo articolo dell'atto, negli altri casi è
 * PARZIALE e vanno avvisati modello e utente — altrimenti una legge troncata a
 * metà da un 409 anti-bot viene letta come se fosse il testo integrale.
 * "atto": Normattiva non riconosce l'atto (nessun articolo letto).
 */
type MotivoStop = "fine" | "cap" | "tempo" | "errore" | "atto";

type Scansione = {
  articoli: Array<{ n: number; label: string; testo: string }>;
  motivo: MotivoStop;
  /** Articoli non restituiti nemmeno ritentando: NON vuol dire che manchino. */
  mancanti: number[];
  /** L'errore che ha lasciato fuori articoli o fermato la scansione. */
  errore?: ErroreApi;
  atto: any;
};

// Tentativi per articolo nella scansione: meno che per un articolo singolo,
// perché un gruppo di articoli in parallelo dura quanto il più lento; chi resta
// senza risposta riceve un secondo giro di tentativi alla fine.
const TENTATIVI_SCANSIONE = 4;

/**
 * Articoli mancanti DENTRO il testo restituito. Se la scansione si è interrotta,
 * quelli dopo l'ultimo articolo letto li copre la nota d'interruzione.
 */
function lacune(w: Scansione): number[] {
  if (w.motivo === "fine" || w.motivo === "cap") return w.mancanti;
  const ultimo = w.articoli.length ? w.articoli[w.articoli.length - 1].n : 0;
  return w.mancanti.filter((n) => n < ultimo);
}

/**
 * Scorre gli articoli (1..cap) di una sezione dell'atto (flag) a gruppi
 * paralleli. L'atto finisce al primo articolo che di sicuro non c'è (404
 * specifico o testo vuoto), salvo che esista un articolo successivo dello
 * stesso gruppo. Un articolo in errore anche dopo i ritentativi NON chiude
 * l'atto: finisce fra i `mancanti` e la scansione prosegue. Ci si ferma invece
 * al blocco anti-bot, allo scadere del budget di tempo e quando un intero
 * gruppo fallisce (Normattiva è giù: inutile insistere).
 */
async function walkArticoli(
  baseBody: Record<string, unknown>,
  flag: number,
  cap: number,
  scadenza?: number,
): Promise<Scansione> {
  const GRUPPO = 6;
  const w: Scansione = { articoli: [], motivo: "cap", mancanti: [], atto: null };
  const opz: OpzioniRetry = { tentativi: TENTATIVI_SCANSIONE, scadenza };
  // Un blocco anti-bot resta l'errore da riportare: è quello che ferma tutto.
  const annota = (e: ErroreApi) => {
    if (w.errore?.classe !== "bloccato") w.errore = e;
  };
  scansione: for (let start = 1; start <= cap; start += GRUPPO) {
    // Il budget si controlla fra un gruppo e l'altro (e, dentro, a ogni richiesta).
    if (scadenza != null && Date.now() >= scadenza) {
      w.motivo = "tempo";
      break;
    }
    const nums: number[] = [];
    for (let k = start; k < start + GRUPPO && k <= cap; k++) nums.push(k);
    const results = await Promise.all(nums.map((n) => fetchDettaglioArticolo(baseBody, n, flag, undefined, opz)));
    let stop: MotivoStop | null = null;
    let certi = 0; // esiti certi: articolo letto, o di sicuro assente
    for (let i = 0; i < results.length; i++) {
      const { res, atto } = results[i];
      if (atto && !w.atto) w.atto = atto;
      if (res.kind === "article") {
        w.articoli.push({ n: nums[i], label: res.label, testo: res.testo });
        certi++;
      } else if (res.kind === "error") {
        w.mancanti.push(nums[i]);
        annota(res);
        if (res.classe === "bloccato") stop = "errore";
        else if (res.scaduto && !stop) stop = "tempo";
      } else if (res.kind === "atto") {
        // Atto non riconosciuto: se non si è letto nulla, il riferimento è sbagliato.
        if (w.articoli.length === 0 && w.mancanti.length === 0) {
          w.motivo = "atto";
          break scansione;
        }
        w.mancanti.push(nums[i]);
        annota({ classe: "permanente", status: 404, dettaglio: "HTTP 404 «Atto non trovato»", tentativi: res.tentativi });
      } else {
        // "assente" o "empty": qui l'atto finisce, salvo un buco nella numerazione.
        certi++;
        if (results.slice(i + 1).some((r) => r.res.kind === "article")) continue;
        w.motivo = "fine";
        break scansione;
      }
    }
    if (stop) {
      w.motivo = stop;
      break;
    }
    if (certi === 0) {
      w.motivo = "errore";
      break;
    }
  }

  // Secondo giro per gli articoli rimasti indietro, se c'è tempo e Normattiva
  // non sta bloccando le richieste.
  const daRiprovare = lacune(w);
  if (daRiprovare.length && w.errore?.classe !== "bloccato") {
    for (let i = 0; i < daRiprovare.length; i += GRUPPO) {
      if (scadenza != null && Date.now() >= scadenza) break;
      const gruppo = daRiprovare.slice(i, i + GRUPPO);
      const rs = await Promise.all(gruppo.map((n) => fetchDettaglioArticolo(baseBody, n, flag, undefined, opz)));
      rs.forEach(({ res, atto }, j) => {
        if (atto && !w.atto) w.atto = atto;
        if (res.kind === "error" || res.kind === "atto") return;
        // Recuperato, oppure di sicuro assente (un buco nella numerazione): non manca più.
        w.mancanti = w.mancanti.filter((n) => n !== gruppo[j]);
        if (res.kind === "article") w.articoli.push({ n: gruppo[j], label: res.label, testo: res.testo });
      });
      if (rs.some((r) => r.res.kind === "error" && r.res.classe === "bloccato")) break;
    }
    w.articoli.sort((a, b) => a.n - b.n);
  }
  return w;
}

/**
 * Nota da appendere al testo scansionato: dichiara esplicitamente se quanto
 * precede è completo o parziale, e come recuperare il resto.
 */
function notaFineScansione(w: Scansione, cap: number): string {
  const note: string[] = [];
  const ultimo = w.articoli.length ? w.articoli[w.articoli.length - 1].n : 0;
  const perche = w.errore ? ` (${w.errore.dettaglio})` : "";
  const buchi = lacune(w);
  if (buchi.length === 1) {
    note.push(`⚠️ Testo PARZIALE: Normattiva non ha restituito l'art. ${buchi[0]} nemmeno ritentando${perche}. NON indica che manchi: richiedilo con \`articolo=${buchi[0]}\`.`);
  } else if (buchi.length > 1) {
    note.push(`⚠️ Testo PARZIALE: Normattiva non ha restituito gli artt. ${buchi.join(", ")} nemmeno ritentando${perche}. NON indica che manchino: richiedili con \`articolo=N\`.`);
  }
  if (w.motivo === "cap") {
    note.push(`Testo troncato ai primi ${cap} articoli. Usa \`articolo=N\` per consultare i successivi.`);
  } else if (w.motivo === "tempo") {
    note.push(`⚠️ Recupero interrotto per limite di tempo dopo l'art. ${ultimo}: il testo sopra è PARZIALE. Richiedi gli articoli successivi con \`articolo=N\`.`);
  } else if (w.motivo === "errore") {
    const come = w.errore?.classe === "bloccato"
      ? `Normattiva sta bloccando temporaneamente le richieste${perche}. Il testo sopra è PARZIALE: attendi almeno mezzo minuto prima di richiedere gli articoli successivi con \`articolo=N\`, uno per volta.`
      : w.errore?.classe === "permanente"
        ? `un errore di Normattiva${perche}. Il testo sopra è PARZIALE: richiedi gli articoli successivi con \`articolo=N\`.`
        : `errori temporanei di Normattiva${perche}. Il testo sopra è PARZIALE e mancano gli articoli successivi: riprova tra qualche secondo, oppure richiedi i singoli articoli con \`articolo=N\`.`;
    note.push(`⚠️ Recupero interrotto dopo l'art. ${ultimo}: ${come}`);
  }
  return note.length ? `\n\n---\n${note.map((t) => `*${t}*`).join("\n")}` : "";
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
}, scadenza?: number): Promise<{ codiceRedazionale: string; dataGU: string } | { error: string }> {
  const stripZeros = (s: unknown) => String(s ?? "").replace(/^0+/, "");

  // 1. Codice + dataGU già disponibili
  if (p.codice_redazionale && p.data_gu) {
    return { codiceRedazionale: p.codice_redazionale, dataGU: p.data_gu };
  }

  // Una ricerca FALLITA (5xx, anti-bot, rete) non è una ricerca a vuoto: prima
  // finiva anch'essa in "Nessun atto trovato... Verifica i dati".
  const ricercaFallita = (e: EsitoApi, cosa: string) => ({
    error: spiegaErrore(comeErrore(e), `la ricerca di ${cosa} non è andata a buon fine`, "Questo NON indica che l'atto non esista."),
  });

  // 2. tipo_atto + numero + anno
  if (p.tipo_atto && p.numero != null && p.anno != null) {
    const denominazioni = denominazioniTipoAtto(p.tipo_atto);
    const tipo = denominazioni[0];
    const { r: e, usata } = await conRipieghi(
      denominazioni,
      (denominazioneAtto) => apiPostStatus("/ricerca/avanzata", {
        denominazioneAtto,
        numeroProvvedimento: p.numero,
        annoProvvedimento: p.anno,
        orderType: "recente",
        paginazione: { paginaCorrente: 1, numeroElementiPerPagina: 10 },
      }, { scadenza }),
      (e) => e.classe === "ok" && ricercaVuota(e.data),
    );
    if (e.classe !== "ok") return ricercaFallita(e, `${usata} n. ${p.numero}/${p.anno}`);
    const lista: any[] = e.data?.listaAtti || [];
    let pick = lista[0];
    if (p.codice_redazionale) {
      pick = lista.find((a) => stripZeros(a?.codiceRedazionale) === stripZeros(p.codice_redazionale)) || pick;
    }
    if (pick?.codiceRedazionale && pick?.dataGU) {
      return { codiceRedazionale: pick.codiceRedazionale, dataGU: pick.dataGU };
    }
    const anche = denominazioni.length > 1 ? ` (cercato anche come ${denominazioni.slice(1).join(", ")})` : "";
    return { error: `Nessun atto trovato per ${tipo} n. ${p.numero}/${p.anno}${anche}. Verifica i dati (i valori ammessi per tipo_atto sono nel tool tipi_atto) oppure usa ricerca_avanzata/trova_atto_specifico.` };
  }

  // 3. Solo codice redazionale: prova a risolvere la dataGU via ricerca testuale
  if (p.codice_redazionale) {
    const e = await apiPostStatus("/ricerca/semplice", {
      testoRicerca: p.codice_redazionale,
      orderType: "recente",
      paginazione: { paginaCorrente: 1, numeroElementiPerPagina: 10 },
    }, { scadenza });
    if (e.classe !== "ok") return ricercaFallita(e, `del codice redazionale "${p.codice_redazionale}"`);
    const lista: any[] = e.data?.listaAtti || [];
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
  // Ultimo articolo con numero intero (oltre ci sono solo estensioni: -bis, ...).
  // Serve a dare un esito CERTO quando Normattiva non restituisce un articolo:
  // entro la numerazione è un suo errore temporaneo (gli articoli abrogati
  // restano: es. art. 587 c.p. → "((ARTICOLO ABROGATO DALLA L. 5 AGOSTO 1981,
  // N. 442))"), oltre non esiste. Solo valori verificati contro l'API il
  // 2026-09-18 (l'ultimo articolo restituito col suo testo).
  ultimoArticolo?: number;
};

// Ogni voce è stata verificata empiricamente contro le API (codice, dataGU e flag).
const CORPI_NORMATIVI: CorpoNormativo[] = [
  { nome: "Costituzione", chiavi: ["cost", "costituzione", "costituzione italiana", "carta costituzionale"], codice: "047U0001", dataGU: "1947-12-27", flag: 0, riferimento: "Costituzione della Repubblica Italiana", ultimoArticolo: 139 },
  { nome: "Preleggi (disposizioni sulla legge in generale)", chiavi: ["preleggi", "disposizioni sulla legge in generale", "disposizioni preliminari codice civile"], codice: "042U0262", dataGU: "1942-04-04", flag: 1, riferimento: "R.D. 16 marzo 1942, n. 262 (allegato 1)" },
  { nome: "Codice civile", chiavi: ["cc", "cod civ", "codice civile"], codice: "042U0262", dataGU: "1942-04-04", flag: 2, riferimento: "R.D. 16 marzo 1942, n. 262 (allegato 2)", ultimoArticolo: 2969 },
  { nome: "Disposizioni di attuazione del codice civile", chiavi: ["disp att cc", "disposizioni attuazione codice civile", "attuazione codice civile"], codice: "042U0318", dataGU: "1942-04-17", flag: 1, riferimento: "R.D. 30 marzo 1942, n. 318" },
  { nome: "Codice penale", chiavi: ["cp", "cod pen", "codice penale"], codice: "030U1398", dataGU: "1930-10-26", flag: 1, riferimento: "R.D. 19 ottobre 1930, n. 1398", ultimoArticolo: 734 },
  { nome: "Codice di procedura civile", chiavi: ["cpc", "codice procedura civile", "codice di procedura civile"], codice: "040U1443", dataGU: "1940-10-28", flag: 1, riferimento: "R.D. 28 ottobre 1940, n. 1443", ultimoArticolo: 840 },
  { nome: "Codice di procedura penale", chiavi: ["cpp", "codice procedura penale", "codice di procedura penale"], codice: "088G0492", dataGU: "1988-10-24", flag: 0, riferimento: "D.P.R. 22 settembre 1988, n. 447", ultimoArticolo: 746 },
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

// ============================================================================
// TIPI DI ATTO (denominazioneAtto)
// ============================================================================

// Valori ufficiali di denominazioneAtto (GET /tipologiche/denominazione-atto,
// letti il 2026-09-18), con il loro codice. L'API li vuole ESATTI: con "legge"
// invece di "LEGGE" la ricerca non trova nulla, e dettaglio_atto rispondeva
// "Nessun atto trovato per legge n. 241/1990. Verifica i dati" — 18 volte su 18
// nei log del server fra il 04 e il 18/09/2026 (L. 241/1990, D.Lgs. 196/2003,
// D.Lgs. 82/2005, D.P.R. 380/2001...): atti che esistono.
const TIPI_ATTO: Array<[string, string]> = [
  ["COS", "COSTITUZIONE"], ["DCT", "DECRETO"], ["PCG", "DECRETO DEL CAPO DEL GOVERNO"],
  ["3NA", "DECRETO DEL CAPO DEL GOVERNO, PRIMO MINISTRO SEGRETARIO DI STATO"],
  ["PCS", "DECRETO DEL CAPO PROVVISORIO DELLO STATO"], ["DDD", "DECRETO DEL DUCE"],
  ["FAC", "DECRETO DEL DUCE DEL FASCISMO, CAPO DEL GOVERNO"],
  ["PCM_DPC", "DECRETO DEL PRESIDENTE DEL CONSIGLIO DEI MINISTRI"],
  ["PPR", "DECRETO DEL PRESIDENTE DELLA REPUBBLICA"], ["PDL", "DECRETO-LEGGE"],
  ["DLL", "DECRETO-LEGGE LUOGOTENENZIALE"], ["PLL", "DECRETO LEGISLATIVO"],
  ["DCS", "DECRETO LEGISLATIVO DEL CAPO PROVVISORIO DELLO STATO"],
  ["PLG", "DECRETO LEGISLATIVO LUOGOTENENZIALE"], ["PZP", "DECRETO LEGISLATIVO PRESIDENZIALE"],
  ["PLU", "DECRETO LUOGOTENENZIALE"], ["PDM", "DECRETO MINISTERIALE"], ["DPP", "DECRETO PRESIDENZIALE"],
  ["SNI", "DECRETO REALE"], ["DEL", "DELIBERAZIONE"],
  ["GRC", "DETERMINAZIONE DEL COMMISSARIO PER LE FINANZE"],
  ["DPB", "DETERMINAZIONE DEL COMMISSARIO PER LA PRODUZIONE BELLICA"],
  ["8ZL", "DETERMINAZIONE INTERCOMMISSARIALE"], ["PLE", "LEGGE"], ["PLC", "LEGGE COSTITUZIONALE"],
  ["POR", "ORDINANZA"], ["PRD", "REGIO DECRETO"], ["PRL", "REGIO DECRETO-LEGGE"],
  ["RDL", "REGIO DECRETO LEGISLATIVO"], ["D10", "REGOLAMENTO"],
];

// Abbreviazioni d'uso comune (confronto su compatta(): "D.Lgs." → "dlgs"). Hanno
// la precedenza sui codici dell'API: "R.D.L." nelle citazioni è il regio
// decreto-legge, anche se "RDL" è il codice API del REGIO DECRETO LEGISLATIVO
// (che resta raggiungibile col nome per esteso o con "R.D.Lgs.").
const ALIAS_TIPO_ATTO: Record<string, string> = {
  l: "LEGGE", lcost: "LEGGE COSTITUZIONALE", cost: "COSTITUZIONE",
  dlgs: "DECRETO LEGISLATIVO", dlg: "DECRETO LEGISLATIVO", dleg: "DECRETO LEGISLATIVO", dlegs: "DECRETO LEGISLATIVO",
  dl: "DECRETO-LEGGE", dpr: "DECRETO DEL PRESIDENTE DELLA REPUBBLICA",
  dpcm: "DECRETO DEL PRESIDENTE DEL CONSIGLIO DEI MINISTRI", dm: "DECRETO MINISTERIALE",
  rd: "REGIO DECRETO", rdl: "REGIO DECRETO-LEGGE", rdlgs: "REGIO DECRETO LEGISLATIVO",
  dlgt: "DECRETO LUOGOTENENZIALE", dllgt: "DECRETO-LEGGE LUOGOTENENZIALE",
  dlgslgt: "DECRETO LEGISLATIVO LUOGOTENENZIALE",
  dlcps: "DECRETO LEGISLATIVO DEL CAPO PROVVISORIO DELLO STATO",
  dlgscps: "DECRETO LEGISLATIVO DEL CAPO PROVVISORIO DELLO STATO",
};

// Denominazioni da riprovare, nell'ordine, quando la ricerca con quella chiesta
// va a vuoto. I decreti ministeriali su Normattiva stanno quasi sempre come
// "DECRETO" (es. D.M. 10 marzo 2014, n. 55 sui parametri forensi = "DECRETO 10
// marzo 2014, n. 55", codice 14G00067): cercati come DECRETO MINISTERIALE non si
// trovano. "D.Lgt." si usa sia per il decreto luogotenenziale sia per quello
// legislativo luogotenenziale.
const RIPIEGHI_TIPO_ATTO: Record<string, string[]> = {
  "DECRETO MINISTERIALE": ["DECRETO"],
  "DECRETO LUOGOTENENZIALE": ["DECRETO LEGISLATIVO LUOGOTENENZIALE"],
  "DECRETO LEGISLATIVO LUOGOTENENZIALE": ["DECRETO LUOGOTENENZIALE"],
};

/** Riporta tipo_atto al valore esatto che l'API si aspetta (vedi TIPI_ATTO). */
function normalizzaTipoAtto(tipo: string): string {
  const q = compatta(tipo);
  const perNome = TIPI_ATTO.find(([, valore]) => compatta(valore) === q);
  if (perNome) return perNome[1];
  if (Object.hasOwn(ALIAS_TIPO_ATTO, q)) return ALIAS_TIPO_ATTO[q];
  const perCodice = TIPI_ATTO.find(([codice]) => compatta(codice) === q);
  return perCodice ? perCodice[1] : tipo.trim().toUpperCase();
}

/** Denominazioni da provare per tipo_atto: quella esatta, poi i ripieghi. */
function denominazioniTipoAtto(tipo: string): string[] {
  const d = normalizzaTipoAtto(tipo);
  return [d, ...(RIPIEGHI_TIPO_ATTO[d] ?? [])];
}

/** Ricerca senza alcun risultato (non solo una pagina vuota). */
function ricercaVuota(data: any): boolean {
  return !data?.listaAtti?.length && !Number(data?.numeroAttiTrovati);
}

/**
 * Esegue `cerca` con ciascuna denominazione finché una dà risultati (vedi
 * RIPIEGHI_TIPO_ATTO); restituisce la risposta e la denominazione usata.
 */
async function conRipieghi<T>(denominazioni: string[], cerca: (d: string) => Promise<T>, vuota: (r: T) => boolean): Promise<{ r: T; usata: string }> {
  let usata = denominazioni[0];
  let r = await cerca(usata);
  for (const d of denominazioni.slice(1)) {
    if (!vuota(r)) break;
    usata = d;
    r = await cerca(d);
  }
  return { r, usata };
}

/** Avviso in testa ai risultati quando la ricerca ha ripiegato su altre denominazioni. */
function notaRipiego(denominazioni: string[], usata: string | undefined, data: any): string {
  if (!usata || usata === denominazioni[0]) return "";
  return ricercaVuota(data)
    ? `*Nessun atto né come «${denominazioni[0]}» né come ${denominazioni.slice(1).map((d) => `«${d}»`).join(", ")}.*\n\n`
    : `*Nessun atto come «${denominazioni[0]}»: risultati per «${usata}», la denominazione con cui Normattiva classifica questi atti.*\n\n`;
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
// VALIDAZIONE DEI PARAMETRI
// ============================================================================

/**
 * Data nel formato dell'API (AAAA-MM-GG); gg/mm/aaaa, comune in italiano (anche
 * con - o . come separatore), viene convertita. Va controllata qui: con una data
 * malformata (es. "2020/01/01") Normattiva risponde col suo errore generico,
 * identico a quello dei guasti temporanei, e il server la ritenterebbe invano
 * dando la colpa a un disservizio.
 */
function dataApi(descrizione: string) {
  return z.string().transform((s, ctx) => {
    const t = s.trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    const it = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(t);
    const data = iso ? t : it ? `${it[3]}-${it[2].padStart(2, "0")}-${it[1].padStart(2, "0")}` : "";
    // Il passaggio da Date scarta le date impossibili (es. 2023-02-30).
    const d = data ? new Date(`${data}T00:00:00Z`) : null;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== data) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `data non valida "${s}": usa il formato AAAA-MM-GG (es. 2024-03-15)` });
      return z.NEVER;
    }
    return data;
  }).describe(descrizione);
}

// ============================================================================
// SERVER MCP
// ============================================================================

// Il server si costruisce con una funzione: in HTTP senza sessioni ne serve uno
// nuovo per ogni richiesta (vedi avviaHttp). Il corpo NON è rientrato di
// proposito: le istruzioni e le descrizioni dei tool sono template literal su
// più righe, e un rientro cambierebbe il testo che arriva ai client.
function creaServer(): McpServer {
const server = new McpServer(
  {
    name: "normattiva",
    version: "1.5.0",
  },
  {
    instructions: `Server MCP per la normativa italiana (banca dati ufficiale Normattiva). I testi restituiti sono nella versione vigente (multivigente), salvo diversa data_vigenza.

USO PROATTIVO: quando la risposta dipende dal contenuto esatto di norme italiane che sai identificare, recupera il testo con dettaglio_atto PRIMA di citarle, spiegarle o applicarle — anche se l'utente non chiede espressamente di "recuperare la norma". Non citare articoli a memoria (rischio di errori e abrogazioni non recepite); fondati sul testo restituito e indica la fonte.

Come scegliere lo strumento:
1. Articolo di un codice/testo unico noto (es. art. 2043 c.c., art. 575 c.p., art. 29 c.p.a., art. 36 TU pubblico impiego): dettaglio_atto con nome_codice (+articolo, eventualmente estensione='bis'/'ter'/...). L'elenco dei nomi supportati è nel tool corpi_normativi.
2. Atto identificato da una citazione (es. D.Lgs. 152/2006, L. 241/1990): dettaglio_atto con tipo_atto + numero + anno (+articolo). Nessuna ricerca preliminare necessaria.
3. Ricerca tematica o atto non identificato: ricerca_semplice o ricerca_avanzata, poi dettaglio_atto con codice_redazionale + data_gu presi dai risultati.
4. Novità e modifiche normative in un periodo: atti_aggiornati.
I codici e i testi unici approvati con decreto (codice civile, penale, ecc.) hanno gli articoli negli allegati dell'atto: dettaglio_atto li gestisce automaticamente (nome_codice seleziona già l'allegato giusto).

ERRORI TEMPORANEI: Normattiva a volte risponde con un errore generico anche per testi che esistono (il server ritenta già più volte). Se un tool segnala un errore temporaneo o una risposta incompleta, NON concludere che l'articolo o l'atto non esistano e non citarli a memoria: riprova dopo qualche secondo e, se l'errore persiste, dichiara all'utente che il testo non è stato recuperato. Se un tool segnala un blocco delle richieste (anti-bot), attendi almeno mezzo minuto prima di riprovare e non lanciare richieste in parallelo.

Se nella sessione è disponibile anche un connettore dedicato a specifici codici (es. iCodici, strumento recupera_articoli), per gli articoli dei codici che quello copre puoi preferirlo (batch più rapidi); usa questo server per il resto della legislazione, per le ricerche e per le vigenze storiche.`,
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
        content: [{ type: "text", text: limitaTesto(formatted, "Riduci `risultati_per_pagina` o restringi i criteri di ricerca.") }],
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
    data_inizio_emanazione: dataApi("Data inizio emanazione nel formato YYYY-MM-DD").optional(),
    data_fine_emanazione: dataApi("Data fine emanazione nel formato YYYY-MM-DD").optional(),
    data_inizio_pubblicazione: dataApi("Data inizio pubblicazione GU nel formato YYYY-MM-DD").optional(),
    data_fine_pubblicazione: dataApi("Data fine pubblicazione GU nel formato YYYY-MM-DD").optional(),
    data_vigenza: dataApi("Data di vigenza di interesse nel formato YYYY-MM-DD (per ottenere il testo vigente a quella data)").optional(),
    classe_provvedimento: z.enum(["1", "2", "3"]).optional().describe("Classe: '1' = senza aggiornamenti, '2' = aggiornato, '3' = abrogato"),
    anno_provvedimento: z.number().int().min(1800).optional().describe("Anno di emanazione del provvedimento"),
    numero_provvedimento: z.number().int().min(1).optional().describe("Numero del provvedimento"),
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
      if (params.data_inizio_emanazione) body.dataInizioEmanazione = params.data_inizio_emanazione;
      if (params.data_fine_emanazione) body.dataFineEmanazione = params.data_fine_emanazione;
      if (params.data_inizio_pubblicazione) body.dataInizioPubProvvedimento = params.data_inizio_pubblicazione;
      if (params.data_fine_pubblicazione) body.dataFinePubProvvedimento = params.data_fine_pubblicazione;
      if (params.data_vigenza) body.vigenza = params.data_vigenza;
      if (params.classe_provvedimento) body.classeProvvedimento = params.classe_provvedimento;
      if (params.anno_provvedimento) body.annoProvvedimento = params.anno_provvedimento;
      if (params.numero_provvedimento) body.numeroProvvedimento = params.numero_provvedimento;

      // tipo_atto: il valore ufficiale, poi i ripieghi se non trova nulla (es. D.M. → DECRETO).
      const denominazioni = params.tipo_atto ? denominazioniTipoAtto(params.tipo_atto) : [];
      const cerca = (denominazioneAtto?: string) =>
        apiPost("/ricerca/avanzata", denominazioneAtto ? { ...body, denominazioneAtto } : body);
      const { r: data, usata } = denominazioni.length
        ? await conRipieghi(denominazioni, cerca, ricercaVuota)
        : { r: await cerca(), usata: undefined };
      const formatted = notaRipiego(denominazioni, usata, data) + formatListaAtti(data);

      return {
        content: [{ type: "text", text: limitaTesto(formatted, "Riduci `risultati_per_pagina` o restringi i criteri di ricerca.") }],
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
    numero: z.number().int().min(1).describe("Numero dell'atto"),
    anno: z.number().int().min(1800).describe("Anno di emanazione"),
    data_vigenza: dataApi("Data di vigenza (YYYY-MM-DD) per ottenere la versione vigente a quella data. Se omesso, restituisce la versione più recente.").optional(),
  },
  async ({ tipo_atto, numero, anno, data_vigenza }) => {
    try {
      const denominazioni = denominazioniTipoAtto(tipo_atto);
      const body: Record<string, unknown> = {
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

      const { r: data, usata } = await conRipieghi(
        denominazioni,
        (denominazioneAtto) => apiPost("/ricerca/avanzata", { ...body, denominazioneAtto }),
        ricercaVuota,
      );
      const formatted = notaRipiego(denominazioni, usata, data) + formatListaAtti(data);

      return {
        content: [{ type: "text", text: limitaTesto(formatted, "Riduci `risultati_per_pagina` o restringi i criteri di ricerca.") }],
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
  `Recupera il testo di un atto normativo dalla banca dati Normattiva (versione vigente). Usalo PROATTIVAMENTE prima di citare, spiegare o applicare una norma: fonda la risposta sul testo vigente invece di citare a memoria. Identifica l'atto in uno di questi modi, in ordine di preferenza: (a) nome_codice per codici, testi unici e leggi fondamentali (es. nome_codice='codice civile' articolo=2043; nome_codice='c.p.' articolo=575): seleziona automaticamente l'atto e l'allegato giusti — elenco dei nomi nel tool corpi_normativi; (b) tipo_atto + numero + anno (es. 'DECRETO LEGISLATIVO' 152 2006), senza ricerca preliminare; (c) codice_redazionale + data_gu dai risultati di ricerca; (d) solo codice_redazionale (data GU risolta automaticamente). Per gli articoli con estensione usa 'estensione' (es. articolo=609, estensione='bis'). Senza 'articolo' restituisce l'intestazione e l'art. 1; 'testo_completo'=true recupera l'intero testo (max 40 articoli). I testi unici/codici approvati con decreto hanno gli articoli negli allegati: vengono cercati automaticamente anche lì. Limite noto: i sotto-articoli "decimali" (es. art. 114.1 TUB, art. 452-bis.1 c.p.) non sono indirizzabili tramite questa API — se non trovi un articolo di quel tipo, dillo all'utente invece di riprovare. Un errore "temporaneo" o una "risposta incompleta" di Normattiva NON indica che l'articolo non esista: riprova.`,
  {
    nome_codice: z.string().optional().describe("Nome comune di un codice/testo unico/legge fondamentale (es. 'codice civile', 'c.p.', 'c.p.a.', 'TU edilizia', 'TUB', 'legge 241'). Identifica direttamente l'atto e l'allegato corretti. Elenco completo nel tool corpi_normativi."),
    codice_redazionale: z.string().optional().describe("Codice redazionale dell'atto (es. '006G0171', '010U0639'), dai risultati di ricerca. In alternativa usa nome_codice oppure tipo_atto+numero+anno."),
    data_gu: dataApi("Data di pubblicazione in Gazzetta Ufficiale (YYYY-MM-DD, campo 'dataGU' dei risultati). Se omessa viene risolta automaticamente.").optional(),
    tipo_atto: z.string().optional().describe("Tipo di atto per identificarlo senza codice (es. 'LEGGE', 'DECRETO LEGISLATIVO', 'REGIO DECRETO', 'DECRETO DEL PRESIDENTE DELLA REPUBBLICA'). Da usare con 'numero' e 'anno'."),
    numero: z.number().int().min(1).optional().describe("Numero dell'atto (con tipo_atto e anno)."),
    anno: z.number().int().min(1800).optional().describe("Anno dell'atto (con tipo_atto e numero)."),
    articolo: z.number().int().min(1).optional().describe("Numero dell'articolo da recuperare (es. 192). Se omesso, restituisce l'intestazione e l'art. 1."),
    estensione: z.string().optional().describe("Estensione dell'articolo: 'bis', 'ter', 'quater', ... fino a 'vicies' (es. articolo=609 + estensione='bis' per l'art. 609-bis). Richiede 'articolo'."),
    allegato: z.number().int().min(0).optional().describe("Sezione dell'atto in cui cercare: 0 = corpo dell'atto, 1..N = allegato N-esimo. Normalmente NON serve: corpo e allegati vengono esplorati automaticamente (e nome_codice imposta già la sezione giusta)."),
    data_vigenza: dataApi("Data di vigenza (YYYY-MM-DD) per ottenere il testo vigente a quella data. Se omesso, versione vigente attuale.").optional(),
    testo_completo: z.boolean().default(false).describe("Se true, recupera tutti gli articoli dell'atto (fino a un massimo di 40). Ignorato se è specificato 'articolo'."),
  },
  async ({ nome_codice, codice_redazionale, data_gu, tipo_atto, numero, anno, articolo, estensione, allegato, data_vigenza, testo_completo }) => {
    const scadenza = Date.now() + BUDGET_TOOL_MS;
    const out = (t: string) => ({
      content: [{
        type: "text" as const,
        text: limitaTesto(t, "Richiedi un articolo per volta con `articolo=N` invece di `testo_completo=true`."),
      }],
    });
    const bad = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
    try {
      // Identificazione dell'atto: nome_codice (mappa cablata) oppure resolveAtto.
      let cr: string;
      let dg: string;
      let flagFisso: number | undefined = allegato != null ? allegato : undefined;
      let corpo: CorpoNormativo | undefined;

      if (nome_codice) {
        const m = trovaCorpoNormativo(nome_codice);
        if ("error" in m) return bad(m.error);
        corpo = m.corpo;
        cr = corpo.codice;
        dg = corpo.dataGU;
        if (flagFisso == null) flagFisso = corpo.flag;
      } else {
        const resolved = await resolveAtto({ codice_redazionale, data_gu, tipo_atto, numero, anno }, scadenza);
        if ("error" in resolved) return bad(resolved.error);
        cr = resolved.codiceRedazionale;
        dg = resolved.dataGU;
      }

      // Nome e numerazione nota del corpo normativo valgono per la SUA sezione:
      // un `allegato` esplicito diverso ne interroga un'altra (es. allegato=1 con
      // il codice civile = le preleggi, 31 articoli).
      const corpoSezione = corpo && flagFisso === corpo.flag ? corpo : undefined;
      const sezione = (f: number) => (f === 0 ? "corpo dell'atto" : `allegato ${f}`);
      const corpoNome = corpo
        ? corpoSezione
          ? `${corpo.nome} — ${corpo.riferimento}`
          : `${corpo.riferimento.replace(/\s*\(.*\)$/, "")}, ${sezione(flagFisso!)}`
        : undefined;
      const corpoNota = corpo?.nota;
      const dove = corpoNome ? `in "${corpoNome}"` : `per l'atto ${cr} (dataGU ${dg})`;
      const diAtto = corpoNome ? `di "${corpoNome}"` : `dell'atto ${cr} (dataGU ${dg})`;

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

      // Risposta «Atto non trovato»: il riferimento non individua alcun atto.
      const attoNonTrovato = () => bad(corpo
        ? `Normattiva non riconosce l'atto di "${corpo.nome}" con i riferimenti cablati nel server (codice redazionale ${cr}, data GU ${dg}: risposta «Atto non trovato»). Identifica l'atto con tipo_atto + numero + anno (${corpo.riferimento}).`
        : `Atto non trovato su Normattiva: il codice redazionale ${cr} con data GU ${dg} non individua alcun atto. Verifica i due valori: vanno presi insieme dai risultati di ricerca_semplice, ricerca_avanzata o trova_atto_specifico, e data_gu è la data di pubblicazione in Gazzetta Ufficiale, non quella dell'atto. In alternativa identifica l'atto con tipo_atto + numero + anno.`);

      // === Caso 1: articolo specifico (ricerca automatica in corpo e allegati) ===
      if (articolo != null) {
        const ultimo = sottoArt == null ? corpoSezione?.ultimoArticolo : undefined;
        const r = await fetchArticoloAuto(baseBody, articolo, sottoArt, flagFisso, {
          // Oltre l'ultimo articolo noto bastano 2 richieste: servono solo a non
          // fidarsi alla cieca della tabella.
          tentativi: ultimo != null && articolo > ultimo ? 2 : TENTATIVI_ARTICOLO,
          scadenza,
        });
        const oltreNumerazione = ultimo != null && articolo > ultimo
          ? ` La numerazione del ${corpoSezione!.nome} arriva all'art. ${ultimo} (oltre, solo eventuali articoli con estensione: -bis, -ter, ...).`
          : "";
        if (r.res.kind === "atto") return attoNonTrovato();
        if (r.res.kind === "assente") {
          const sezioni = flagFisso == null ? " (cercato nel corpo dell'atto e negli allegati 1-3)" : "";
          return bad(`Articolo ${etichettaArt} non trovato ${dove}${sezioni}: Normattiva risponde che non esiste.${oltreNumerazione} Verifica il numero${sottoArt != null ? " e l'estensione" : ""}.`);
        }
        if (r.res.kind === "error") {
          const fallito = `l'articolo ${etichettaArt} ${dove} non è stato recuperato`;
          // Numerazione nota (codici principali): anche senza risposta si sa se l'articolo esiste.
          if (r.res.classe === "transitorio" && ultimo != null) {
            if (articolo > ultimo) return bad(`Articolo ${etichettaArt} non trovato ${dove}.${oltreNumerazione} Verifica il numero.`);
            return bad(spiegaErrore(r.res, fallito, `L'art. ${articolo} ESISTE (il ${corpoSezione!.nome} va dall'art. 1 all'art. ${ultimo}, abrogati compresi): è un disservizio di Normattiva, non un problema del riferimento.`));
          }
          return bad(spiegaErrore(r.res, fallito, "NON indica che l'articolo non esista."));
        }
        const intest = conCorpo(formatIntestazioneAtto(r.atto, cr, dg, data_vigenza));
        if (r.res.kind === "empty") {
          return out(`${intest}\n\nIl testo dell'articolo ${etichettaArt} non è disponibile (atto molto recente o articolo privo di testo consolidato).`);
        }
        const nota = flagFisso == null && r.flagUsato > 0 ? ` *(dall'allegato ${r.flagUsato})*` : "";
        return out(`${intest}\n\n---\n**${r.res.label}**${nota}\n${r.res.testo}`);
      }

      // La sezione fissata non ha nemmeno l'art. 1 (risposta certa di Normattiva).
      const sezioneInesistente = () =>
        bad(`Nessun articolo nella sezione richiesta (${sezione(flagFisso!)}) ${diAtto}: Normattiva risponde che l'art. 1 non c'è.${allegato != null ? " Verifica il numero di allegato (0 = corpo dell'atto)." : ""}`);
      // L'atto esiste (nessun «Atto non trovato») ma l'art. 1 non c'è né nel corpo né nell'allegato 1.
      const senzaArticoli = async () => {
        const bare = await fetchDettaglioArticolo(baseBody, undefined, 0, undefined, { tentativi: 3, scadenza });
        if (bare.atto) return out(`${formatIntestazioneAtto(bare.atto, cr, dg, data_vigenza)}\n\n(Nessun testo di articolo disponibile per questo atto.)`);
        if (bare.res.kind === "error") return bad(spiegaErrore(bare.res, `il testo ${diAtto} non è stato recuperato`, "NON indica che l'atto non abbia testo."));
        if (bare.res.kind === "atto") return attoNonTrovato();
        return bad(`Normattiva non restituisce articoli ${diAtto}: l'art. 1 non c'è né nel corpo dell'atto né nell'allegato 1. Se l'atto ha più allegati, prova con \`allegato=2\`.`);
      };

      // === Caso 2: testo completo ===
      if (testo_completo) {
        const testoDi = (w: Scansione) => w.articoli.map((a) => `**${a.label}**\n${a.testo}`).join("\n\n---\n");
        // Scansione chiusa con certezza: l'atto finisce lì e non manca nulla.
        const certa = (w: Scansione) => w.motivo === "fine" && w.mancanti.length === 0;
        // Nessun articolo letto, senza certezze: atto non riconosciuto, errore o tempo scaduto.
        const nienteLetto = (w: Scansione) =>
          w.motivo === "atto" ? attoNonTrovato() : bad(spiegaErrore(w.errore ?? TEMPO_ESAURITO, `il testo ${diAtto} non è stato recuperato`));

        // Sezione fissata (nome_codice o allegato esplicito): scorri solo quella.
        if (flagFisso != null) {
          const w = await walkArticoli(baseBody, flagFisso, CAP, scadenza);
          if (w.articoli.length === 0) {
            if (!certa(w)) return nienteLetto(w);
            return w.atto
              ? out(`${conCorpo(formatIntestazioneAtto(w.atto, cr, dg, data_vigenza))}\n\nNessun articolo trovato nella sezione richiesta (${sezione(flagFisso)}).`)
              : sezioneInesistente();
          }
          const intest = conCorpo(formatIntestazioneAtto(w.atto, cr, dg, data_vigenza));
          let o = `${intest}\n\n${testoDi(w)}`;
          o += notaFineScansione(w, CAP);
          o += `\n*Gli articoli con estensione (-bis, -ter, ...) non compaiono nello scorrimento: recuperali con articolo=N + estensione.*`;
          return out(o);
        }
        const main = await walkArticoli(baseBody, 0, CAP, scadenza);
        if (main.articoli.length === 0 && !certa(main)) return nienteLetto(main);
        // Atto ordinario, oppure scansione incompleta: si mostra quel che c'è,
        // dichiarando cosa manca.
        if (main.articoli.length >= 2 || !certa(main)) {
          const intest = formatIntestazioneAtto(main.atto, cr, dg, data_vigenza);
          return out(`${intest}\n\n${testoDi(main)}${notaFineScansione(main, CAP)}`);
        }
        // ≤1 articolo nel corpo, con certezza: il contenuto vero può essere l'allegato (testo unico).
        const alleg = await walkArticoli(baseBody, 1, CAP, scadenza);
        const atto = alleg.atto || main.atto;
        if (alleg.articoli.length >= 1) {
          const intest = formatIntestazioneAtto(atto, cr, dg, data_vigenza);
          let o = `${intest}\n\n*Testo unico allegato:*\n\n${testoDi(alleg)}`;
          o += notaFineScansione(alleg, CAP);
          // Segnala eventuali allegati ulteriori (es. codice civile = allegato 2 del R.D. 262/1942).
          const succ = await fetchDettaglioArticolo(baseBody, 1, 2, undefined, { tentativi: 2, scadenza });
          if (succ.res.kind === "article") o += `\n*L'atto contiene ulteriori allegati: usa \`allegato=2\` (o superiore) per consultarli.*`;
          return out(o);
        }
        if (main.articoli.length === 1) {
          // Atto ad articolo unico; se l'allegato non si è potuto controllare, va detto.
          const avviso = certa(alleg) || alleg.motivo === "atto"
            ? ""
            : `\n\n---\n*⚠️ Non è stato possibile verificare se l'atto ha un allegato con altri articoli (${(alleg.errore ?? TEMPO_ESAURITO).dettaglio}): se te lo aspetti, riprova o usa \`allegato=1\`.*`;
          const intest = formatIntestazioneAtto(main.atto, cr, dg, data_vigenza);
          return out(`${intest}\n\n---\n${testoDi(main)}${avviso}`);
        }
        // Nessun articolo né nel corpo né nell'allegato 1.
        if (!certa(alleg)) return nienteLetto(alleg);
        if (atto) {
          return out(`${formatIntestazioneAtto(atto, cr, dg, data_vigenza)}\n\nIl testo consolidato degli articoli non è ancora disponibile per questo atto.`);
        }
        return senzaArticoli();
      }

      // === Caso 3: default — intestazione + art. 1 (con rilevamento testo unico) ===
      const tentativiArt1: OpzioniRetry = { tentativi: TENTATIVI_ARTICOLO, scadenza };
      // Sezione fissata (nome_codice o allegato esplicito): mostra l'art. 1 di quella sezione.
      if (flagFisso != null) {
        const a1f = await fetchDettaglioArticolo(baseBody, 1, flagFisso, undefined, tentativiArt1);
        if (a1f.res.kind === "article") {
          const intest = conCorpo(formatIntestazioneAtto(a1f.atto, cr, dg, data_vigenza));
          return out(`${intest}\n\n---\n**${a1f.res.label}**\n${a1f.res.testo}\n\n---\n*Usa \`articolo=N\` (con eventuale \`estensione\`) per un articolo specifico, oppure \`testo_completo=true\` per l'intero testo.*`);
        }
        if (a1f.res.kind === "empty") {
          return out(`${conCorpo(formatIntestazioneAtto(a1f.atto, cr, dg, data_vigenza))}\n\nIl testo consolidato non è disponibile per questa sezione.`);
        }
        if (a1f.res.kind === "atto") return attoNonTrovato();
        if (a1f.res.kind === "assente") return sezioneInesistente();
        return bad(spiegaErrore(a1f.res, `l'art. 1 ${diAtto} non è stato recuperato`,
          corpoSezione ? "L'art. 1 esiste: è un disservizio di Normattiva, NON indica che il testo manchi." : undefined));
      }
      const a1 = await fetchDettaglioArticolo(baseBody, 1, 0, undefined, tentativiArt1);
      if (a1.res.kind === "atto") return attoNonTrovato();
      if (a1.res.kind === "error") {
        return bad(spiegaErrore(a1.res, `l'atto ${cr} (dataGU ${dg}) non è stato recuperato`, "NON indica che l'atto non esista."));
      }
      if (a1.res.kind === "empty") {
        return out(`${formatIntestazioneAtto(a1.atto, cr, dg, data_vigenza)}\n\nIl testo consolidato degli articoli non è ancora disponibile per questo atto (probabilmente molto recente). È consultabile nella Gazzetta Ufficiale indicata.`);
      }

      // Se l'art. 1 è un "Articolo Unico" (o manca del tutto), il contenuto potrebbe
      // essere nell'allegato. Conta solo un art. 2 che di sicuro non c'è: nel
      // dubbio (errore) si mostra l'art. 1 dell'atto, che è comunque il suo.
      let soloArticoloUnico = false;
      if (a1.res.kind === "article") {
        const a2 = await fetchDettaglioArticolo(baseBody, 2, 0, undefined, { tentativi: 2, scadenza });
        soloArticoloUnico = a2.res.kind === "assente";
      }
      if (a1.res.kind === "assente" || soloArticoloUnico) {
        const alleg1 = await fetchDettaglioArticolo(baseBody, 1, 1, undefined, { tentativi: 3, scadenza });
        if (alleg1.res.kind === "article") {
          const intest = formatIntestazioneAtto(alleg1.atto || a1.atto, cr, dg, data_vigenza);
          return out(`${intest}\n\n*Atto che approva un testo unico: gli articoli sostanziali sono nell'allegato.*\n\n---\n**${alleg1.res.label}**\n${alleg1.res.testo}\n\n---\n*Usa \`articolo=N\` per un articolo (es. \`articolo=3\`), oppure \`testo_completo=true\` per l'intero testo.*`);
        }
        if (a1.res.kind === "assente") {
          if (alleg1.res.kind === "error") {
            return bad(spiegaErrore(alleg1.res, `il testo ${diAtto} non è stato recuperato`, "NON indica che l'atto non abbia testo."));
          }
          if (alleg1.res.kind === "atto") return attoNonTrovato();
          return senzaArticoli();
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
  `Recupera la lista degli atti normativi aggiornati (modificati) in un determinato periodo. Utile per monitorare le novità normative e le modifiche recenti alla legislazione. L'intervallo non può superare i 12 mesi e i risultati sono limitati a 7000 atti. I periodi lunghi producono molti atti: scorri i risultati con 'pagina' invece di alzare 'risultati_per_pagina'.`,
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

      // L'endpoint ignora la paginazione richiesta: la applichiamo qui.
      const pagine = impaginaLocalmente(data, pagina, risultati_per_pagina);
      if (pagina > 1 && (pagine?.listaAtti?.length ?? 0) === 0) {
        return {
          content: [{
            type: "text",
            text: `Pagina ${pagina} vuota: il periodo ${data_inizio} → ${data_fine} ha ${pagine?.numeroAttiTrovati ?? 0} atti, cioè ${pagine?.numeroPagine ?? 1} pagine da ${risultati_per_pagina}.`,
          }],
        };
      }

      // Proviamo a formattare come lista atti se possibile
      try {
        const formatted = formatListaAtti(pagine);
        return { content: [{ type: "text", text: limitaTesto(formatted, "Riduci `risultati_per_pagina` o accorcia il periodo.") }] };
      } catch {
        return { content: [{ type: "text", text: limitaTesto(JSON.stringify(pagine, null, 2), "Riduci `risultati_per_pagina`.") }] };
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

return server;
}

// ============================================================================
// AVVIO SERVER
// ============================================================================

// Due modi di avvio:
// - stdio (predefinito), per l'uso in locale da Claude Desktop o Claude Code;
// - `--http`, per il server: Streamable HTTP SENZA sessioni, un solo processo.
//   Sostituisce supergateway, che avviava un processo `node` per ogni sessione
//   (584 processi orfani ad agosto 2026), teneva una cache per processo e
//   lasciava ai client sessioni che scadevano. Senza sessioni ogni richiesta è
//   indipendente: un server MCP nuovo per richiesta, cache dei dati condivisa.

/** Chiave nell'indirizzo (`/mcp/<chiave>`), da MCP_URL_TOKEN. Sotto i 32
 *  caratteri non vale: un valore corto per sbaglio non apre l'accesso. Senza
 *  chiave l'endpoint è `/mcp`, aperto: solo per le prove in locale. */
const CHIAVE_MIN = 32;

function chiaveDaAmbiente(): string | null {
  const v = (process.env.MCP_URL_TOKEN || "").trim();
  if (!v) return null;
  if (v.length < CHIAVE_MIN) {
    throw new Error(`MCP_URL_TOKEN troppo corta (${v.length} caratteri, minimo ${CHIAVE_MIN}): il server non parte.`);
  }
  return v;
}

function chiaveGiusta(data: string, attesa: string): boolean {
  const a = Buffer.from(data, "utf8");
  const b = Buffer.from(attesa, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const CORPO_MAX = 1_000_000; // byte: le richieste MCP vere sono di pochi kB

function leggiCorpo(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parti: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > CORPO_MAX) {
        reject(new Error("corpo troppo grande"));
        req.destroy();
        return;
      }
      parti.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parti).toString("utf8")));
      } catch {
        reject(new Error("JSON non valido"));
      }
    });
    req.on("error", reject);
  });
}

function rispondi(res: http.ServerResponse, status: number, corpo: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(corpo));
}

async function avviaHttp(): Promise<void> {
  const chiave = chiaveDaAmbiente();
  const porta = Number(process.env.PORT) || 8000;
  const percorso = chiave ? `/mcp/${chiave}` : "/mcp";

  const httpServer = http.createServer(async (req, res) => {
    const url = (req.url || "").split("?")[0];

    if (url === "/healthz") {
      rispondi(res, 200, { status: "ok", versione: "1.5.0", protezione: chiave ? "chiave" : "nessuna" });
      return;
    }
    // Chiave sbagliata, mancante o percorso sconosciuto: 404, mai 401. Un 401
    // fa partire nei client la scoperta OAuth (/.well-known/...), che qui non c'è.
    const giusto = chiave
      ? url.startsWith("/mcp/") && chiaveGiusta(url.slice("/mcp/".length), chiave)
      : url === "/mcp";
    if (!giusto) {
      rispondi(res, 404, { error: "Not found" });
      return;
    }
    // Senza sessioni non c'è uno stream server→client da aprire (GET) né una
    // sessione da chiudere (DELETE).
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    // Protocollo: l'SDK rifiuta con 400 le versioni che non conosce, e i client
    // Claude recenti mandano `MCP-Protocol-Version: 2026-07-28` anche dopo aver
    // negoziato 2025-11-25 nella initialize. Qui la si riporta all'ultima
    // supportata: è ciò che faceva la Transform Rule di Cloudflare (2026-09-02),
    // che così non serve più e non tocca le chiamate sulla rete interna.
    // L'SDK legge gli header da `rawHeaders` (li converte in una Request web con
    // @hono/node-server), quindi va corretto lì oltre che in `headers`.
    const versione = req.headers["mcp-protocol-version"];
    if (typeof versione === "string" && !SUPPORTED_PROTOCOL_VERSIONS.includes(versione)) {
      req.headers["mcp-protocol-version"] = LATEST_PROTOCOL_VERSION;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === "mcp-protocol-version") req.rawHeaders[i + 1] = LATEST_PROTOCOL_VERSION;
      }
    }

    let corpo: unknown;
    try {
      corpo = await leggiCorpo(req);
    } catch (e) {
      rispondi(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: `Parse error: ${(e as Error).message}` }, id: null });
      return;
    }

    const server = creaServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // nessuna sessione
      enableJsonResponse: true, // risposta JSON, niente stream SSE
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, corpo);
    } catch (e) {
      console.error("[Normattiva MCP] Errore nella richiesta HTTP:", e);
      if (!res.headersSent) {
        rispondi(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Errore interno" }, id: null });
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(porta, resolve));
  console.error(`[Normattiva MCP] HTTP senza sessioni sulla porta ${porta}, endpoint ${chiave ? "/mcp/<chiave>" : "/mcp (APERTO: nessuna MCP_URL_TOKEN)"}, salute /healthz`);
}

async function main() {
  console.error("[Normattiva MCP] Avvio server...");
  console.error(`[Normattiva MCP] Endpoint API: ${API_BASE}`);

  if (process.argv.includes("--http")) {
    await avviaHttp();
    return;
  }

  const server = creaServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[Normattiva MCP] Server connesso e in ascolto.");
}

main().catch((error) => {
  console.error("[Normattiva MCP] Errore fatale:", error);
  process.exit(1);
});
