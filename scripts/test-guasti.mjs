#!/usr/bin/env node
/**
 * Test dei GUASTI dell'API Normattiva, contro un finto Normattiva locale.
 *
 * Perché esiste: dal 2026-09-17 l'API risponde a intermittenza con un errore
 * generico — HTTP 404 o 500 con corpo
 *   {"message":"Errore generico della chiamata, riprovare più tardi","code":"1000"}
 * — IDENTICO alla risposta per un articolo che non esiste. Il server lo
 * traduceva in "Articolo N non trovato... Verifica il numero" (e lo teneva in
 * cache per 6 ore). Lo smoke test contro l'API vera non può riprodurre il
 * guasto a comando: questo sì, in modo deterministico e senza rete.
 *
 * Avvia build/index.js puntandolo (NORMATTIVA_API_BASE) a un server HTTP locale
 * che risponde secondo un copione per articolo, e verifica via MCP:
 *  - ritentativi con backoff su 404/500 generici e su 200 incompleti;
 *  - nessun 404 in cache (una sessione non resta "avvelenata");
 *  - messaggi: errore temporaneo (mai "verifica il numero") per gli articoli
 *    esistenti, "non trovato" solo con un riscontro;
 *  - tipo_atto normalizzato (legge → LEGGE) e ripiego DECRETO MINISTERIALE → DECRETO;
 *  - testo_completo: un falso 404 non tronca l'atto spacciandolo per completo.
 *
 * Uso: npm run build && npm run test-guasti
 */
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const GEN = { message: "Errore generico della chiamata, riprovare più tardi", code: "1000" };
const R404 = { status: 404, body: GEN };
const R500 = { status: 500, body: GEN };
const HTML200 = { status: 200, raw: "<html><body>Service Unavailable</body></html>" };

// Articolo nel formato degli allegati (codici) o AKN (corpo dell'atto).
const artAllegato = (n, testo) => ({
  status: 200,
  body: { code: null, message: null, success: true, data: { atto: {
    titolo: "ATTO DI PROVA", sottoTitolo: "(prova)",
    articoloHtml: `<div class="bodyTesto"><span class="attachment-just-text"><div> Art. ${n}. <br> ${testo} <br></div></span></div>`,
  } } },
});
const artAkn = (n, testo) => ({
  status: 200,
  body: { code: null, message: null, success: true, data: { atto: {
    titolo: "LEGGE DI PROVA", sottoTitolo: "(prova)",
    articoloHtml: `<div class="bodyTesto"><h2 class="article-num-akn">Art. ${n}</h2><div class="art-comma-div-akn">${testo}</div></div>`,
  } } },
});

// Copione: chiave "codice|idArticolo|flag|sottoArticolo" → risposte in sequenza
// (l'ultima si ripete). Senza copione: 404 generico, come l'API per un articolo inesistente.
const copione = new Map();
const chiamate = new Map();
const ricerche = [];
const k = (codice, id, flag, sotto) => `${codice}|${id ?? ""}|${flag ?? ""}|${sotto ?? ""}`;
const imposta = (chiave, ...risposte) => { copione.set(chiave, risposte); chiamate.set(chiave, 0); };
const conta = (chiave) => chiamate.get(chiave) ?? 0;

const server = http.createServer((req, res) => {
  let dati = "";
  req.on("data", (c) => (dati += c));
  req.on("end", () => {
    const body = dati ? JSON.parse(dati) : {};
    let r;
    if (req.url.endsWith("/atto/dettaglio-atto")) {
      const chiave = k(body.codiceRedazionale, body.idArticolo, body.flagTipoArticolo, body.sottoArticolo);
      chiamate.set(chiave, conta(chiave) + 1);
      const seq = copione.get(chiave);
      r = seq ? seq[Math.min(conta(chiave) - 1, seq.length - 1)] : R404;
    } else if (req.url.endsWith("/ricerca/avanzata")) {
      ricerche.push(body.denominazioneAtto);
      const atti = {
        "LEGGE|241|1990": { codiceRedazionale: "090G0294", dataGU: "1990-08-18" },
        "DECRETO|55|2014": { codiceRedazionale: "14G00067", dataGU: "2014-04-02" },
      };
      if (body.numeroProvvedimento === 999) r = R500;
      else {
        const a = atti[`${body.denominazioneAtto}|${body.numeroProvvedimento}|${body.annoProvvedimento}`];
        r = { status: 200, body: { listaAtti: a ? [a] : [], numeroAttiTrovati: a ? 1 : 0 } };
      }
    } else {
      r = { status: 404, body: { message: "rotta sconosciuta al finto Normattiva" } };
    }
    res.writeHead(r.status, { "content-type": r.raw ? "text/html" : "application/json" });
    res.end(r.raw ?? JSON.stringify(r.body));
  });
});

let falliti = 0;
function verifica(nome, cond, dettaglio = "") {
  console.log(`${cond ? "✅" : "❌"} ${nome}${cond ? "" : ` — ${dettaglio}`}`);
  if (!cond) falliti++;
}

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const porta = server.address().port;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["build/index.js"],
    stderr: "ignore",
    env: { ...process.env, NORMATTIVA_API_BASE: `http://127.0.0.1:${porta}`, NORMATTIVA_BACKOFF_MS: "5" },
  });
  const client = new Client({ name: "test-guasti", version: "1.0.0" });
  await client.connect(transport);
  const chiama = async (args) => {
    const r = await client.callTool({ name: "dettaglio_atto", arguments: args });
    return { testo: (r.content ?? []).map((c) => c.text ?? "").join("\n"), errore: r.isError === true };
  };
  const CC = "042U0262", CP = "030U1398";

  // 1. Falsi 404 e 500 generici, poi la risposta vera → articolo restituito.
  imposta(k(CC, 2043, 2), R404, R500, artAllegato(2043, "Qualunque fatto doloso o colposo"));
  let r = await chiama({ nome_codice: "codice civile", articolo: 2043 });
  verifica("404/500 generici ritentati fino all'articolo", !r.errore && r.testo.includes("Qualunque fatto doloso") && conta(k(CC, 2043, 2)) === 3, `${conta(k(CC, 2043, 2))} chiamate: ${r.testo.slice(0, 120)}`);

  // 2. Articolo entro la numerazione del c.c., sempre 404 → errore temporaneo certo.
  imposta(k(CC, 1218, 2), R404);
  r = await chiama({ nome_codice: "codice civile", articolo: 1218 });
  verifica("c.c. 1218 sempre in errore → 'errore temporaneo', mai 'verifica il numero'",
    r.errore && r.testo.includes("Risposta incompleta da Normattiva, errore temporaneo") && r.testo.includes("ESISTE") && !/verifica il numero/i.test(r.testo),
    r.testo.slice(0, 160));
  verifica("c.c. 1218: 6 richieste (ritentativi)", conta(k(CC, 1218, 2)) === 6, `${conta(k(CC, 1218, 2))} chiamate`);

  // 3. Nessun 404 in cache: se Normattiva si riprende, la stessa sessione lo vede subito.
  imposta(k(CC, 1218, 2), artAllegato(1218, "Il debitore che non esegue esattamente"));
  r = await chiama({ nome_codice: "codice civile", articolo: 1218 });
  verifica("il 404 non resta in cache", !r.errore && r.testo.includes("Il debitore"), r.testo.slice(0, 120));

  // 4. Oltre l'ultimo articolo del c.c. → "non trovato", con solo 2 richieste.
  r = await chiama({ nome_codice: "codice civile", articolo: 9999 });
  verifica("c.c. 9999 → non trovato (arriva all'art. 2969)", r.errore && r.testo.includes("non trovato") && r.testo.includes("2969"), r.testo.slice(0, 160));
  verifica("c.c. 9999: 2 richieste", conta(k(CC, 9999, 2)) === 2, `${conta(k(CC, 9999, 2))} chiamate`);

  // 5. Estensione (numerazione ignota), sempre 404, ma l'art. 1 risponde → messaggio ambiguo, non "non trovato".
  imposta(k(CC, 1, 2), artAllegato(1, "La capacità giuridica si acquista"));
  r = await chiama({ nome_codice: "codice civile", articolo: 2043, estensione: "bis" });
  verifica("2043-bis inesistente + art. 1 ok → ambiguo, senza 'non trovato'",
    r.errore && r.testo.includes("non restituito da Normattiva") && r.testo.includes("L'art. 1 dello stesso atto invece viene restituito") && !r.testo.includes("non trovato"),
    r.testo.slice(0, 160));

  // 6. Atto senza numerazione nota, articolo e art. 1 sempre in errore → errore temporaneo.
  r = await chiama({ nome_codice: "TU edilizia", articolo: 16 });
  verifica("TU edilizia 16 + art. 1 in errore → errore temporaneo",
    r.errore && r.testo.includes("errore temporaneo") && r.testo.includes("non restituisce nemmeno l'art. 1"), r.testo.slice(0, 160));

  // 6-bis. Atto generico (sezioni da esplorare) sempre in errore: giri alternati,
  // 6 richieste sul corpo e 3 per allegato = 15, non 24.
  r = await chiama({ codice_redazionale: "TEST0002", data_gu: "2020-01-01", articolo: 5 });
  const perSezione = [0, 1, 2, 3].map((f) => conta(k("TEST0002", 5, f)));
  verifica("atto generico in errore: 15 richieste (6 corpo + 3×3 allegati), messaggio temporaneo",
    JSON.stringify(perSezione) === "[6,3,3,3]" && r.errore && r.testo.includes("errore temporaneo"),
    `${JSON.stringify(perSezione)} ${r.testo.slice(0, 120)}`);

  // 7. 200 con pagina HTML (risposta incompleta) → ritentato.
  imposta(k(CP, 575, 1), HTML200, artAllegato(575, "Chiunque cagiona la morte di un uomo"));
  r = await chiama({ nome_codice: "codice penale", articolo: 575 });
  verifica("200 incompleto (HTML) ritentato", !r.errore && r.testo.includes("morte di un uomo") && conta(k(CP, 575, 1)) === 2, r.testo.slice(0, 120));

  // 8. Errore 500 persistente su un codice noto → errore temporaneo certo.
  imposta(k(CP, 640, 1), R500);
  r = await chiama({ nome_codice: "c.p.", articolo: 640 });
  verifica("c.p. 640 sempre 500 → errore temporaneo", r.errore && r.testo.includes("errore temporaneo") && !/verifica il numero/i.test(r.testo), r.testo.slice(0, 160));

  // 9. tipo_atto minuscolo → LEGGE (prima: "Nessun atto trovato per legge n. 241/1990").
  imposta(k("090G0294", 22, 0), artAkn(22, "diritto di accesso"));
  r = await chiama({ tipo_atto: "legge", numero: 241, anno: 1990, articolo: 22 });
  verifica("tipo_atto 'legge' normalizzato in 'LEGGE'", !r.errore && r.testo.includes("diritto di accesso") && ricerche.includes("LEGGE") && !ricerche.includes("legge"), `${JSON.stringify(ricerche)} ${r.testo.slice(0, 100)}`);

  // 10. D.M. → ripiego su DECRETO.
  imposta(k("14G00067", 4, 0), artAkn(4, "parametri generali"));
  r = await chiama({ tipo_atto: "D.M.", numero: 55, anno: 2014, articolo: 4 });
  verifica("DECRETO MINISTERIALE senza risultati → ripiego su DECRETO",
    !r.errore && r.testo.includes("parametri generali") && ricerche.includes("DECRETO MINISTERIALE") && ricerche.includes("DECRETO"), `${JSON.stringify(ricerche)} ${r.testo.slice(0, 100)}`);

  // 11. Ricerca fallita (500) → errore temporaneo, non "Nessun atto trovato".
  r = await chiama({ tipo_atto: "LEGGE", numero: 999, anno: 2020, articolo: 1 });
  verifica("ricerca in errore → errore temporaneo, non 'Nessun atto trovato'",
    r.errore && r.testo.includes("Errore temporaneo di Normattiva nella ricerca") && !r.testo.includes("Nessun atto trovato"), r.testo.slice(0, 160));

  // 12. testo_completo: falso 404 a metà atto → l'atto NON viene troncato.
  for (let n = 1; n <= 8; n++) imposta(k("TEST0001", n, 0), artAkn(n, `testo dell'articolo ${n}`));
  imposta(k("TEST0001", 3, 0), R404, artAkn(3, "testo dell'articolo 3"));
  r = await chiama({ codice_redazionale: "TEST0001", data_gu: "2020-01-01", testo_completo: true });
  const presenti = [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => r.testo.includes(`testo dell'articolo ${n}`)).length;
  verifica("testo_completo: falso 404 sull'art. 3 recuperato, 8 articoli su 8", !r.errore && presenti === 8, `${presenti}/8: ${r.testo.slice(-200)}`);
  verifica("testo_completo: la fine incerta è dichiarata", r.testo.includes("errori temporanei"), r.testo.slice(-200));

  // 13. Default (senza articolo) su un codice: l'art. 1 ha un falso 404 → ritentato.
  imposta(k(CP, 1, 1), R404, artAllegato(1, "Nessuno può essere punito"));
  r = await chiama({ nome_codice: "codice penale" });
  verifica("intestazione + art. 1 con falso 404 → ritentato", !r.errore && r.testo.includes("Nessuno può essere punito"), r.testo.slice(0, 120));

  await client.close();
  server.close();
  if (falliti > 0) {
    console.error(`\n${falliti} verifica/he FALLITE.`);
    process.exit(1);
  }
  console.log("\nTutte le verifiche superate.");
}

main().catch((e) => {
  console.error("Errore fatale del test:", e);
  server.close();
  process.exit(1);
});
