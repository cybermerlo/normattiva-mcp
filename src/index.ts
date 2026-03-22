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

const COMMON_HEADERS: Record<string, string> = {
  "Accept": "application/json, text/plain, */*",
  "Content-Type": "application/json",
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
    headers: COMMON_HEADERS,
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
    result += `Codice redazionale: ${atto.codiceRedazionale}\n`;
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
  `Recupera il dettaglio completo di un atto normativo, incluso il testo integrale. Richiede il codice redazionale dell'atto (es. '24G00231'), che si ottiene dai risultati delle ricerche. Restituisce il testo completo dell'atto nella versione vigente.`,
  {
    codice_redazionale: z.string().describe("Codice redazionale dell'atto (es. '24G00231', '06G00171'). Si ottiene dai risultati della ricerca semplice o avanzata."),
    data_vigenza: z.string().optional().describe("Data di vigenza (YYYY-MM-DD) per ottenere la versione vigente a quella data"),
  },
  async ({ codice_redazionale, data_vigenza }) => {
    try {
      let endpoint = `/visualizzazione/dettaglio/${codice_redazionale}`;
      if (data_vigenza) {
        endpoint += `?dataVigenza=${data_vigenza}`;
      }

      const data = await apiGet(endpoint);
      
      // Il dettaglio può avere formati diversi, gestiamo il caso generico
      if (typeof data === "string") {
        return { content: [{ type: "text", text: data }] };
      }
      
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
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
  `Recupera la lista degli atti normativi che sono stati aggiornati (modificati) in un determinato periodo. Utile per monitorare le novità normative e le modifiche recenti alla legislazione.`,
  {
    data_inizio: z.string().describe("Data inizio periodo nel formato YYYY-MM-DD"),
    data_fine: z.string().describe("Data fine periodo nel formato YYYY-MM-DD"),
    pagina: z.number().int().min(1).default(1).describe("Numero di pagina"),
    risultati_per_pagina: z.number().int().min(1).max(50).default(10).describe("Risultati per pagina"),
  },
  async ({ data_inizio, data_fine, pagina, risultati_per_pagina }) => {
    try {
      const body = {
        dataInizio: data_inizio,
        dataFine: data_fine,
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
