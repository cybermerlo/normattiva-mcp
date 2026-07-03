#!/usr/bin/env node
/**
 * Smoke test end-to-end del server MCP Normattiva.
 *
 * Avvia il server BUILDATO (build/index.js) su stdio e lo interroga con un
 * vero client MCP — lo stesso protocollo usato da Claude — su una "golden
 * suite" di casi noti (articoli di codici negli allegati, estensioni -bis,
 * percorso generico tipo+numero+anno, percorsi d'errore).
 *
 * Serve a due cose:
 *  1. regressioni nel codice (ogni push);
 *  2. drift dell'API Normattiva (esecuzione settimanale in CI): se il
 *     Poligrafico cambia struttura/risposte, questo test se ne accorge
 *     prima degli utenti.
 *
 * Uso: npm run build && npm run smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PAUSA_MS = 400; // gentilezza verso l'API pubblica
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASI = [
  {
    nome: "corpi_normativi (filtro 'civile')",
    tool: "corpi_normativi",
    args: { filtro: "civile" },
    attendi: (t) => t.includes("Codice civile"),
  },
  {
    nome: "art. 2043 c.c. (codice in allegato 2)",
    tool: "dettaglio_atto",
    args: { nome_codice: "codice civile", articolo: 2043 },
    attendi: (t) => t.toLowerCase().includes("risarcire il danno"),
  },
  {
    nome: "art. 575 c.p. (codice in allegato 1)",
    tool: "dettaglio_atto",
    args: { nome_codice: "codice penale", articolo: 575 },
    attendi: (t) => t.toLowerCase().includes("morte di un uomo"),
  },
  {
    nome: "art. 416-bis c.p. (estensione in allegato)",
    tool: "dettaglio_atto",
    args: { nome_codice: "c.p.", articolo: 416, estensione: "bis" },
    attendi: (t) => t.toLowerCase().includes("tipo mafioso"),
  },
  {
    nome: "art. 32 Cost. (corpo dell'atto)",
    tool: "dettaglio_atto",
    args: { nome_codice: "costituzione", articolo: 32 },
    attendi: (t) => t.toLowerCase().includes("tutela la salute"),
  },
  {
    nome: "art. 50 TUEL (testo unico, flag 0)",
    tool: "dettaglio_atto",
    args: { nome_codice: "tuel", articolo: 50 },
    attendi: (t) => t.toLowerCase().includes("sindaco"),
  },
  {
    nome: "percorso generico: L. 898/1970 art. 5 (divorzio)",
    tool: "dettaglio_atto",
    args: { tipo_atto: "LEGGE", numero: 898, anno: 1970, articolo: 5 },
    attendi: (t) => t.toLowerCase().includes("scioglimento"),
  },
  {
    nome: "errore: articolo inesistente (c.c. 9999)",
    tool: "dettaglio_atto",
    args: { nome_codice: "codice civile", articolo: 9999 },
    erroreAtteso: true,
    attendi: (t) => t.toLowerCase().includes("non trovato"),
  },
  {
    nome: "errore: nome_codice sconosciuto",
    tool: "dettaglio_atto",
    args: { nome_codice: "codice inesistentissimo", articolo: 1 },
    erroreAtteso: true,
    attendi: (t) => t.toLowerCase().includes("non riconosciuto"),
  },
  {
    nome: "errore: estensione non supportata (decimale)",
    tool: "dettaglio_atto",
    args: { nome_codice: "TUB", articolo: 114, estensione: "1" },
    erroreAtteso: true,
    attendi: (t) => t.toLowerCase().includes("estensione"),
  },
];

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["build/index.js"],
    stderr: "ignore",
    // Passa l'ambiente completo al server: di default il transport lo filtra,
    // ma in ambienti dietro proxy (HTTPS_PROXY + NODE_USE_ENV_PROXY=1) il
    // server figlio ne ha bisogno per raggiungere l'API.
    env: { ...process.env },
  });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const nomi = tools.tools.map((t) => t.name);
  console.log(`Tool esposti: ${nomi.join(", ")}`);
  for (const atteso of ["dettaglio_atto", "corpi_normativi", "ricerca_semplice"]) {
    if (!nomi.includes(atteso)) {
      console.error(`FAIL: tool '${atteso}' non esposto`);
      process.exit(1);
    }
  }

  let falliti = 0;
  for (const caso of CASI) {
    await sleep(PAUSA_MS);
    const t0 = Date.now();
    let esito = "PASS";
    let dettaglio = "";
    try {
      const res = await client.callTool({ name: caso.tool, arguments: caso.args });
      const testo = (res.content ?? []).map((c) => c.text ?? "").join("\n");
      const isErr = res.isError === true;
      const attesoErr = caso.erroreAtteso === true;
      if (attesoErr !== isErr) {
        esito = "FAIL";
        dettaglio = `isError=${isErr}, atteso ${attesoErr}`;
      } else if (!caso.attendi(testo)) {
        esito = "FAIL";
        dettaglio = `contenuto inatteso: ${testo.slice(0, 140).replace(/\n/g, " ")}…`;
      }
    } catch (e) {
      esito = "FAIL";
      dettaglio = String(e).slice(0, 200);
    }
    if (esito === "FAIL") falliti++;
    console.log(`${esito === "PASS" ? "✅" : "❌"} ${caso.nome} (${Date.now() - t0}ms)${dettaglio ? ` — ${dettaglio}` : ""}`);
  }

  // Verifica cache: la seconda richiesta identica deve essere servita in-memory.
  const t0 = Date.now();
  await client.callTool({ name: "dettaglio_atto", arguments: { nome_codice: "codice civile", articolo: 2043 } });
  console.log(`ℹ️  cache: richiesta ripetuta servita in ${Date.now() - t0}ms`);

  await client.close();
  if (falliti > 0) {
    console.error(`\n${falliti} caso/i FALLITI.`);
    process.exit(1);
  }
  console.log(`\nTutti i ${CASI.length} casi superati.`);
}

main().catch((e) => {
  console.error("Errore fatale dello smoke test:", e);
  process.exit(1);
});
