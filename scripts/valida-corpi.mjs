#!/usr/bin/env node
/**
 * Validazione della tabella CORPI_NORMATIVI contro l'API Normattiva reale.
 *
 * La tabella (codice redazionale + dataGU + allegato per ~55 codici e testi
 * unici) è cablata nel sorgente ed è il punto che "marcisce in silenzio": se
 * Normattiva cambia un codice o la struttura degli allegati, nome_codice
 * smette di funzionare senza che nessun test locale lo veda.
 *
 * Questo script interroga il server BUILDATO via MCP (black-box): chiede
 * l'elenco a corpi_normativi e per ogni voce recupera l'intestazione +
 * art. 1 con dettaglio_atto(nome_codice=...). PASS se torna un articolo.
 *
 * Pensato per l'esecuzione SETTIMANALE in CI (è ~1 chiamata per corpo,
 * sequenziale e con pausa: gentile con l'API pubblica).
 *
 * Uso: npm run build && npm run valida-corpi
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PAUSA_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["build/index.js"],
    stderr: "ignore",
    // Ambiente completo al server figlio (serve dietro proxy, cfr. smoke.mjs).
    env: { ...process.env },
  });
  const client = new Client({ name: "valida-corpi", version: "1.0.0" });
  await client.connect(transport);

  const lista = await client.callTool({ name: "corpi_normativi", arguments: {} });
  const testoLista = (lista.content ?? []).map((c) => c.text ?? "").join("\n");
  // Righe della tabella markdown: "| <nome> | <atto> | <alias> |"
  const nomi = testoLista
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| nome_codice") && !l.startsWith("|---"))
    .map((l) => l.split("|")[1]?.trim())
    .filter(Boolean);

  if (nomi.length < 30) {
    console.error(`FAIL: elenco corpi sospettosamente corto (${nomi.length} voci). Output:\n${testoLista.slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`Corpi normativi da validare: ${nomi.length}\n`);

  const falliti = [];
  const avvisi = [];
  for (const nome of nomi) {
    await sleep(PAUSA_MS);
    try {
      const res = await client.callTool({ name: "dettaglio_atto", arguments: { nome_codice: nome } });
      const testo = (res.content ?? []).map((c) => c.text ?? "").join("\n");
      if (res.isError === true) {
        falliti.push([nome, testo.slice(0, 120)]);
        console.log(`❌ ${nome}`);
      } else if (/\*\*Art/.test(testo)) {
        console.log(`✅ ${nome}`);
      } else {
        // Risposta valida ma senza articolo (es. testo consolidato assente):
        // non è una rottura della mappa, ma va tenuto d'occhio.
        avvisi.push([nome, testo.slice(0, 120)]);
        console.log(`⚠️  ${nome} (nessun articolo nel default)`);
      }
    } catch (e) {
      falliti.push([nome, String(e).slice(0, 120)]);
      console.log(`❌ ${nome} — ${String(e).slice(0, 80)}`);
    }
  }

  await client.close();

  console.log(`\nEsito: ${nomi.length - falliti.length - avvisi.length} PASS, ${avvisi.length} WARN, ${falliti.length} FAIL`);
  for (const [n, d] of avvisi) console.log(`  WARN ${n}: ${d.replace(/\n/g, " ")}`);
  for (const [n, d] of falliti) console.log(`  FAIL ${n}: ${d.replace(/\n/g, " ")}`);
  if (falliti.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Errore fatale della validazione:", e);
  process.exit(1);
});
