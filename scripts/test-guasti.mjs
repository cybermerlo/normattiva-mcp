#!/usr/bin/env node
/**
 * Test dei GUASTI dell'API Normattiva, contro un finto Normattiva locale.
 *
 * Perché esiste: dal 2026-09-17 l'API risponde a intermittenza con un errore
 * generico — HTTP 404 o 500 con corpo
 *   {"message":"Errore generico della chiamata, riprovare più tardi","code":"1000"}
 * — che il server traduceva in "Articolo N non trovato... Verifica il numero"
 * (e teneva in cache per 6 ore). Il finto Normattiva risponde come l'API vera
 * (verificata il 2026-10-24): 404 con un messaggio specifico per un articolo
 * che non esiste, 404 «Atto non trovato» per un riferimento sbagliato, e il
 * corpo generico solo per i guasti, a comando. Lo smoke test contro l'API vera
 * non può riprodurre i guasti a comando: questo sì, in modo deterministico e
 * senza rete.
 *
 * Avvia build/index.js puntandolo (NORMATTIVA_API_BASE) a un server HTTP locale
 * che risponde secondo un copione per articolo, e verifica via MCP:
 *  - ritentativi con backoff sugli errori temporanei, nessuno sui 404 specifici;
 *  - nessun 404 in cache (una sessione non resta "avvelenata");
 *  - messaggi: "non trovato" solo con un 404 specifico (o oltre la numerazione
 *    nota), errore temporaneo (mai "verifica il numero") quando Normattiva non
 *    risponde, "Atto non trovato" per un riferimento sbagliato;
 *  - vale la prima sezione (corpo, poi allegati) che ha l'articolo: mai un
 *    allegato al posto di un corpo in errore;
 *  - blocco anti-bot: un solo ritentativo e l'invito ad aspettare;
 *  - errori permanenti non ritentati né spacciati per temporanei;
 *  - budget di tempo rispettato anche se Normattiva non risponde;
 *  - date controllate (e convertite) prima di interrogare l'API;
 *  - tipo_atto normalizzato e ripieghi (D.M. → DECRETO) in tutti i tool;
 *  - testo_completo: niente testo troncato spacciato per completo.
 *
 * Uso: npm run build && npm run test-guasti
 */
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const GEN = { message: "Errore generico della chiamata, riprovare più tardi", code: "1000" };
const R404 = { status: 404, body: GEN };
const R500 = { status: 500, body: GEN };
const R409 = { status: 409, raw: "<html><body>La pagina richiesta e' stata bloccata dai sistemi di protezione</body></html>" };
const HTML200 = { status: 200, raw: "<html><body>Service Unavailable</body></html>" };
const SOSPESA = { sospesa: true }; // Normattiva accetta la connessione ma non risponde
const ATTO_NON_TROVATO = { status: 404, body: { message: "Atto non trovato", code: null } };
// 404 per un articolo (o allegato) che non esiste, come lo dà l'API vera.
const inesistente = (b) => ({
  status: 404,
  body: {
    message: `dataPubblicazioneGazzetta:Sat Jan 01 00:00:00 CET 2000 codiceRedazionale:${b.codiceRedazionale} idArticolo:${b.idArticolo} idSottoArticolo:${b.sottoArticolo ?? 1} idSottoArticolo1:null flagTipoArticolo:${b.flagTipoArticolo}`,
    code: null,
  },
});

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
const attoSenzaTesto = {
  status: 200,
  body: { code: null, message: null, success: true, data: { atto: { titolo: "ATTO SENZA ARTICOLI", articoloHtml: "<div></div>" } } },
};

// Atti noti con la loro data GU: con un'altra data l'API risponde «Atto non trovato».
const DATE_GU = { "090G0294": "1990-08-18" };

// Copione: chiave "codice|idArticolo|flag|sottoArticolo" → risposte in sequenza
// (l'ultima si ripete). Senza copione: 404 specifico, come l'API per un articolo inesistente.
const copione = new Map();
const chiamate = new Map();
const ultimoCorpo = new Map();
const richieste = []; // tutte le richieste a dettaglio-atto
const ricerche = [];
const k = (codice, id, flag, sotto) => `${codice}|${id ?? ""}|${flag ?? ""}|${sotto ?? ""}`;
const imposta = (chiave, ...risposte) => { copione.set(chiave, risposte); chiamate.set(chiave, 0); };
const conta = (chiave) => chiamate.get(chiave) ?? 0;
const sospese = new Set();

const server = http.createServer((req, res) => {
  let dati = "";
  req.on("data", (c) => (dati += c));
  req.on("end", () => {
    const body = dati ? JSON.parse(dati) : {};
    let r;
    if (req.url.endsWith("/atto/dettaglio-atto")) {
      richieste.push(body);
      const chiave = k(body.codiceRedazionale, body.idArticolo, body.flagTipoArticolo, body.sottoArticolo);
      chiamate.set(chiave, conta(chiave) + 1);
      ultimoCorpo.set(chiave, body);
      const seq = copione.get(chiave);
      if (DATE_GU[body.codiceRedazionale] && DATE_GU[body.codiceRedazionale] !== body.dataGU) r = ATTO_NON_TROVATO;
      else r = seq ? seq[Math.min(conta(chiave) - 1, seq.length - 1)] : inesistente(body);
    } else if (req.url.endsWith("/ricerca/avanzata")) {
      ricerche.push(body.denominazioneAtto);
      const atti = {
        "LEGGE|241|1990": { codiceRedazionale: "090G0294", dataGU: "1990-08-18", descrizioneAtto: "LEGGE 7 agosto 1990, n. 241" },
        "DECRETO|55|2014": { codiceRedazionale: "14G00067", dataGU: "2014-04-02", descrizioneAtto: "DECRETO 10 marzo 2014, n. 55" },
      };
      if (body.numeroProvvedimento === 999) r = R500;
      else if (body.numeroProvvedimento === 998) r = { status: 400, body: { message: "Parametri di ricerca non validi", code: "1501" } };
      else if (body.numeroProvvedimento === 997) r = SOSPESA;
      else {
        const a = atti[`${body.denominazioneAtto}|${body.numeroProvvedimento}|${body.annoProvvedimento}`];
        r = { status: 200, body: { listaAtti: a ? [a] : [], numeroAttiTrovati: a ? 1 : 0, paginaCorrente: 1, numeroPagine: 1 } };
      }
    } else {
      r = { status: 404, body: { message: "rotta sconosciuta al finto Normattiva" } };
    }
    if (typeof r === "function") r = r(body);
    if (r.sospesa) {
      sospese.add(res);
      res.on("close", () => sospese.delete(res));
      return;
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

async function avvia(porta, envExtra = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["build/index.js"],
    stderr: "ignore",
    env: { ...process.env, NORMATTIVA_API_BASE: `http://127.0.0.1:${porta}`, NORMATTIVA_BACKOFF_MS: "5", ...envExtra },
  });
  const client = new Client({ name: "test-guasti", version: "1.0.0" });
  await client.connect(transport);
  const chiama = async (args, tool = "dettaglio_atto") => {
    const t0 = Date.now();
    const r = await client.callTool({ name: tool, arguments: args });
    return { testo: (r.content ?? []).map((c) => c.text ?? "").join("\n"), errore: r.isError === true, ms: Date.now() - t0 };
  };
  return { client, chiama };
}

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const porta = server.address().port;
  const { client, chiama } = await avvia(porta);
  const CC = "042U0262", CP = "030U1398", TUE = "001G0429";
  const perSezione = (codice, id) => JSON.stringify([0, 1, 2, 3].map((f) => conta(k(codice, id, f))));
  const corto = (r) => r.testo.slice(0, 200).replace(/\n/g, " ");
  let r;

  // Le date entrano nello schema del tool come stringhe, con la loro descrizione.
  const tools = await client.listTools();
  const dv = tools.tools.find((t) => t.name === "dettaglio_atto")?.inputSchema?.properties?.data_vigenza;
  verifica("schema: data_vigenza resta una stringa descritta", dv?.type === "string" && /YYYY-MM-DD/.test(dv?.description ?? ""), JSON.stringify(dv));

  // --- Articolo singolo: ritentativi e messaggi --------------------------------

  // Falsi 404 e 500 generici, poi la risposta vera → articolo restituito.
  imposta(k(CC, 2043, 2), R404, R500, artAllegato(2043, "Qualunque fatto doloso o colposo"));
  r = await chiama({ nome_codice: "codice civile", articolo: 2043 });
  verifica("404/500 generici ritentati fino all'articolo", !r.errore && r.testo.includes("Qualunque fatto doloso") && conta(k(CC, 2043, 2)) === 3, `${conta(k(CC, 2043, 2))} chiamate: ${corto(r)}`);

  // Articolo entro la numerazione del c.c., sempre in errore → errore temporaneo, l'articolo esiste.
  imposta(k(CC, 1218, 2), R404);
  r = await chiama({ nome_codice: "codice civile", articolo: 1218 });
  verifica("c.c. 1218 sempre in errore → 'errore temporaneo' ed 'ESISTE', mai 'verifica il numero'",
    r.errore && r.testo.includes("Errore temporaneo di Normattiva") && r.testo.includes("ESISTE") && !/verifica il numero/i.test(r.testo), corto(r));
  verifica("c.c. 1218: 6 richieste (ritentativi)", conta(k(CC, 1218, 2)) === 6, `${conta(k(CC, 1218, 2))} chiamate`);

  // Nessun 404 in cache: se Normattiva si riprende, la stessa sessione lo vede subito.
  imposta(k(CC, 1218, 2), artAllegato(1218, "Il debitore che non esegue esattamente"));
  r = await chiama({ nome_codice: "codice civile", articolo: 1218 });
  verifica("il 404 non resta in cache", !r.errore && r.testo.includes("Il debitore"), corto(r));

  // Articolo inesistente: 404 specifico → "non trovato" alla prima risposta.
  r = await chiama({ nome_codice: "codice civile", articolo: 9999 });
  verifica("c.c. 9999 (404 specifico) → non trovato, con la numerazione del c.c.", r.errore && r.testo.includes("non trovato") && r.testo.includes("2969"), corto(r));
  verifica("c.c. 9999: una sola richiesta", conta(k(CC, 9999, 2)) === 1, `${conta(k(CC, 9999, 2))} chiamate`);

  // Oltre la numerazione nota e Normattiva in errore: "non trovato" dalla tabella, con 2 richieste.
  imposta(k(CC, 9998, 2), R404);
  r = await chiama({ nome_codice: "codice civile", articolo: 9998 });
  verifica("c.c. 9998 in errore, oltre l'art. 2969 → non trovato con 2 richieste",
    r.errore && r.testo.includes("non trovato") && r.testo.includes("2969") && conta(k(CC, 9998, 2)) === 2, `${conta(k(CC, 9998, 2))} chiamate: ${corto(r)}`);

  // Estensione inesistente (404 specifico) → non trovato, senza ritentare.
  r = await chiama({ nome_codice: "codice civile", articolo: 2043, estensione: "bis" });
  verifica("2043-bis inesistente → non trovato, una richiesta",
    r.errore && r.testo.includes("non trovato") && conta(k(CC, 2043, 2, 2)) === 1, `${conta(k(CC, 2043, 2, 2))} chiamate: ${corto(r)}`);

  // Atto senza numerazione nota, articolo sempre in errore → errore temporaneo. Anche
  // con l'art. 1 in cache (vista di default): il riscontro sull'art. 1 non c'è più.
  imposta(k(TUE, 1, 0), artAkn(1, "Ambito di applicazione"));
  await chiama({ nome_codice: "TU edilizia" });
  imposta(k(TUE, 16, 0), R404);
  r = await chiama({ nome_codice: "TU edilizia", articolo: 16 });
  verifica("TU edilizia 16 sempre in errore → errore temporaneo, mai 'verifica'",
    r.errore && r.testo.includes("Errore temporaneo di Normattiva") && r.testo.includes("NON indica che l'articolo non esista") && !/verifica/i.test(r.testo) && conta(k(TUE, 16, 0)) === 6,
    `${conta(k(TUE, 16, 0))} chiamate: ${corto(r)}`);

  // 200 con pagina HTML (risposta incompleta) → ritentato.
  imposta(k(CP, 575, 1), HTML200, artAllegato(575, "Chiunque cagiona la morte di un uomo"));
  r = await chiama({ nome_codice: "codice penale", articolo: 575 });
  verifica("200 incompleto (HTML) ritentato", !r.errore && r.testo.includes("morte di un uomo") && conta(k(CP, 575, 1)) === 2, corto(r));

  // Errore 500 generico persistente su un codice noto → errore temporaneo.
  imposta(k(CP, 640, 1), R500);
  r = await chiama({ nome_codice: "c.p.", articolo: 640 });
  verifica("c.p. 640 sempre 500 → errore temporaneo", r.errore && r.testo.includes("Errore temporaneo") && !/verifica il numero/i.test(r.testo), corto(r));

  // --- Atti generici: corpo e allegati -----------------------------------------

  // Corpo sempre in errore: ci si ferma lì (6 richieste), gli allegati non si toccano.
  imposta(k("TEST0002", 5, 0), R404);
  r = await chiama({ codice_redazionale: "TEST0002", data_gu: "2020-01-01", articolo: 5 });
  verifica("corpo in errore → errore temporaneo, allegati non interrogati",
    perSezione("TEST0002", 5) === "[6,0,0,0]" && r.errore && r.testo.includes("Errore temporaneo"), `${perSezione("TEST0002", 5)} ${corto(r)}`);

  // Un errore nel corpo non fa restituire l'articolo omonimo dell'allegato.
  imposta(k("TEST0003", 2, 0), R500, artAkn(2, "testo del corpo"));
  imposta(k("TEST0003", 2, 1), artAllegato(2, "testo dell'allegato"));
  r = await chiama({ codice_redazionale: "TEST0003", data_gu: "2020-01-01", articolo: 2 });
  verifica("500 sul corpo ritentato: art. 2 del corpo, non quello dell'allegato",
    !r.errore && r.testo.includes("testo del corpo") && !r.testo.includes("testo dell'allegato") && conta(k("TEST0003", 2, 1)) === 0, `${perSezione("TEST0003", 2)} ${corto(r)}`);

  // Articolo assente dal corpo, allegato 1 sempre in errore → errore temporaneo, non "non trovato".
  imposta(k("TEST0008", 5, 1), R500);
  r = await chiama({ codice_redazionale: "TEST0008", data_gu: "2020-01-01", articolo: 5 });
  verifica("allegato in errore dopo il corpo senza l'articolo → errore temporaneo",
    r.errore && r.testo.includes("Errore temporaneo") && !r.testo.includes("non trovato") && perSezione("TEST0008", 5) === "[1,6,0,0]", `${perSezione("TEST0008", 5)} ${corto(r)}`);

  // Articolo nell'allegato 2: corpo e allegato 1 rispondono "non esiste", una richiesta ciascuno.
  imposta(k("TEST0009", 7, 2), artAllegato(7, "settimo articolo dell'allegato"));
  r = await chiama({ codice_redazionale: "TEST0009", data_gu: "2020-01-01", articolo: 7 });
  verifica("articolo nell'allegato 2 trovato con 3 richieste",
    !r.errore && r.testo.includes("settimo articolo") && r.testo.includes("dall'allegato 2") && perSezione("TEST0009", 7) === "[1,1,1,0]", `${perSezione("TEST0009", 7)} ${corto(r)}`);

  // Riferimento sbagliato (data dell'atto invece della data GU) → «Atto non trovato», una richiesta.
  const prima = richieste.length;
  r = await chiama({ codice_redazionale: "090G0294", data_gu: "1990-08-07", articolo: 22 });
  verifica("«Atto non trovato» → riferimento da verificare, una richiesta, niente 'disservizio'",
    r.errore && r.testo.includes("Atto non trovato") && r.testo.includes("data_gu") && !/disservizio|temporaneo/i.test(r.testo) && richieste.length - prima === 1,
    `${richieste.length - prima} richieste: ${corto(r)}`);

  // Errore permanente (500 con un messaggio specifico) → non ritentato, non "temporaneo".
  imposta(k("TEST0007", 5, 0), { status: 500, body: { message: "Formato data non valido: dataGU", code: null } });
  r = await chiama({ codice_redazionale: "TEST0007", data_gu: "2020-01-01", articolo: 5 });
  verifica("500 specifico → una richiesta, errore permanente",
    r.errore && r.testo.includes("Formato data non valido") && r.testo.includes("Ritentare non cambia") && !r.testo.includes("temporaneo") && perSezione("TEST0007", 5) === "[1,0,0,0]",
    `${perSezione("TEST0007", 5)} ${corto(r)}`);

  // --- Allegato esplicito diverso dalla sezione del codice ---------------------

  r = await chiama({ nome_codice: "codice civile", allegato: 1, articolo: 50 });
  verifica("c.c. con allegato=1 (preleggi), art. 50 assente → non trovato, senza la numerazione del c.c.",
    r.errore && r.testo.includes("non trovato") && !r.testo.includes("ESISTE") && !r.testo.includes("2969") && r.testo.includes("allegato 1"), corto(r));
  imposta(k(CC, 40, 1), R404);
  r = await chiama({ nome_codice: "codice civile", allegato: 1, articolo: 40 });
  verifica("c.c. con allegato=1 in errore → errore temporaneo, senza 'ESISTE'",
    r.errore && r.testo.includes("Errore temporaneo") && !r.testo.includes("ESISTE"), corto(r));

  // --- Blocco anti-bot ----------------------------------------------------------

  imposta(k(CC, 2045, 2), R409);
  r = await chiama({ nome_codice: "codice civile", articolo: 2045 });
  verifica("409 su sezione fissa → 2 richieste e invito ad attendere",
    r.errore && conta(k(CC, 2045, 2)) === 2 && r.testo.includes("bloccando") && /attendi/i.test(r.testo) && !r.testo.includes("anche subito"),
    `${conta(k(CC, 2045, 2))} chiamate: ${corto(r)}`);
  imposta(k("TEST0010", 5, 0), R409);
  r = await chiama({ codice_redazionale: "TEST0010", data_gu: "2020-01-01", articolo: 5 });
  verifica("409 esplorando le sezioni → ci si ferma al corpo (2 richieste)",
    r.errore && perSezione("TEST0010", 5) === "[2,0,0,0]" && r.testo.includes("bloccando"), `${perSezione("TEST0010", 5)} ${corto(r)}`);

  // --- Date ---------------------------------------------------------------------

  const primaData = richieste.length;
  r = await chiama({ nome_codice: "codice civile", articolo: 2043, data_vigenza: "2020/01/01" });
  verifica("data_vigenza malformata → errore di parametro, nessuna richiesta a Normattiva",
    r.errore && r.testo.includes("data non valida") && richieste.length === primaData, `${richieste.length - primaData} richieste: ${corto(r)}`);
  imposta(k(CC, 2044, 2), artAllegato(2044, "Non è responsabile chi cagiona il danno per legittima difesa"));
  r = await chiama({ nome_codice: "codice civile", articolo: 2044, data_vigenza: "1/3/2020" });
  verifica("data_vigenza gg/mm/aaaa convertita in AAAA-MM-GG",
    !r.errore && ultimoCorpo.get(k(CC, 2044, 2))?.dataVigenza === "2020-03-01" && r.testo.includes("vigenza: 2020-03-01"), `${JSON.stringify(ultimoCorpo.get(k(CC, 2044, 2)))} ${corto(r)}`);
  r = await chiama({ nome_codice: "codice civile", articolo: 2044, data_vigenza: "2023-02-30" });
  verifica("data impossibile (30 febbraio) rifiutata", r.errore && r.testo.includes("data non valida"), corto(r));

  // --- Ricerche e tipo_atto ------------------------------------------------------

  // tipo_atto minuscolo → LEGGE (prima: "Nessun atto trovato per legge n. 241/1990").
  imposta(k("090G0294", 22, 0), artAkn(22, "diritto di accesso"));
  ricerche.length = 0;
  r = await chiama({ tipo_atto: "legge", numero: 241, anno: 1990, articolo: 22 });
  verifica("tipo_atto 'legge' normalizzato in 'LEGGE'", !r.errore && r.testo.includes("diritto di accesso") && JSON.stringify(ricerche) === '["LEGGE"]', `${JSON.stringify(ricerche)} ${corto(r)}`);

  // D.M. → ripiego su DECRETO, in dettaglio_atto, trova_atto_specifico e ricerca_avanzata.
  imposta(k("14G00067", 4, 0), artAkn(4, "parametri generali"));
  ricerche.length = 0;
  r = await chiama({ tipo_atto: "D.M.", numero: 55, anno: 2014, articolo: 4 });
  verifica("dettaglio_atto: DECRETO MINISTERIALE senza risultati → ripiego su DECRETO",
    !r.errore && r.testo.includes("parametri generali") && JSON.stringify(ricerche) === '["DECRETO MINISTERIALE","DECRETO"]', `${JSON.stringify(ricerche)} ${corto(r)}`);
  for (const [tool, args] of [
    ["trova_atto_specifico", { tipo_atto: "D.M.", numero: 55, anno: 2014 }],
    ["ricerca_avanzata", { tipo_atto: "D.M.", numero_provvedimento: 55, anno_provvedimento: 2014 }],
  ]) {
    ricerche.length = 0;
    r = await chiama(args, tool);
    verifica(`${tool}: D.M. → ripiego su DECRETO, dichiarato`,
      !r.errore && r.testo.includes("14G00067") && r.testo.includes("risultati per «DECRETO»") && JSON.stringify(ricerche) === '["DECRETO MINISTERIALE","DECRETO"]',
      `${JSON.stringify(ricerche)} ${corto(r)}`);
  }

  // Abbreviazioni storiche: R.D.L. = regio decreto-legge; D.Lgt. e D.L.Lgt. = luogotenenziali.
  // (numeri diversi: le ricerche riuscite restano in cache)
  for (const [i, [tipo, attese]] of [
    ["R.D.L.", ["REGIO DECRETO-LEGGE"]],
    ["R.D.Lgs.", ["REGIO DECRETO LEGISLATIVO"]],
    ["D.Lgt.", ["DECRETO LUOGOTENENZIALE", "DECRETO LEGISLATIVO LUOGOTENENZIALE"]],
    ["D.L.Lgt.", ["DECRETO-LEGGE LUOGOTENENZIALE"]],
    ["D.Lgs.Lgt.", ["DECRETO LEGISLATIVO LUOGOTENENZIALE", "DECRETO LUOGOTENENZIALE"]],
  ].entries()) {
    ricerche.length = 0;
    r = await chiama({ tipo_atto: tipo, numero: 151 + i, anno: 1944, articolo: 1 });
    verifica(`tipo_atto '${tipo}' → ${attese.join(" poi ")}`, JSON.stringify(ricerche) === JSON.stringify(attese), JSON.stringify(ricerche));
  }

  // Ricerca fallita (500) → errore temporaneo, non "Nessun atto trovato".
  r = await chiama({ tipo_atto: "LEGGE", numero: 999, anno: 2020, articolo: 1 });
  verifica("ricerca in errore → errore temporaneo, non 'Nessun atto trovato'",
    r.errore && r.testo.includes("Errore temporaneo di Normattiva") && r.testo.includes("la ricerca di") && !r.testo.includes("Nessun atto trovato"), corto(r));
  // Ricerca rifiutata (400) → errore permanente col messaggio dell'API, non "temporaneo".
  r = await chiama({ tipo_atto: "LEGGE", numero: 998, anno: 2020, articolo: 1 });
  verifica("ricerca rifiutata (400) → messaggio dell'API, non 'temporaneo'",
    r.errore && r.testo.includes("Parametri di ricerca non validi") && !r.testo.includes("temporaneo") && !r.testo.includes("Nessun atto trovato"), corto(r));

  // --- Vista di default (senza articolo) ---------------------------------------

  // Codice: l'art. 1 ha un falso 404 → ritentato.
  imposta(k(CP, 1, 1), R404, artAllegato(1, "Nessuno può essere punito"));
  r = await chiama({ nome_codice: "codice penale" });
  verifica("intestazione + art. 1 con falso 404 → ritentato", !r.errore && r.testo.includes("Nessuno può essere punito"), corto(r));

  // Atto generico con l'art. 1 sempre in errore: errore temporaneo, mai "Nessun testo".
  imposta(k("TEST0005", 1, 0), R404);
  imposta(k("TEST0005", undefined, 0), attoSenzaTesto);
  r = await chiama({ codice_redazionale: "TEST0005", data_gu: "2020-01-01" });
  verifica("art. 1 sempre in errore → errore temporaneo, non 'Nessun testo'",
    r.errore && r.testo.includes("Errore temporaneo") && !r.testo.includes("Nessun testo"), corto(r));

  // Atto senza l'art. 1 né nel corpo né nell'allegato 1 (404 specifici) → "Nessun testo", legittimo.
  imposta(k("TEST0012", undefined, 0), attoSenzaTesto);
  r = await chiama({ codice_redazionale: "TEST0012", data_gu: "2020-01-01" });
  verifica("art. 1 assente da corpo e allegato 1 → 'Nessun testo di articolo'", !r.errore && r.testo.includes("Nessun testo di articolo disponibile"), corto(r));

  // Un falso 404 sull'art. 2 non trasforma l'atto in "testo unico allegato".
  imposta(k("TEST0006", 1, 0), artAkn(1, "primo articolo del corpo"));
  imposta(k("TEST0006", 2, 0), R404, R404, artAkn(2, "secondo articolo del corpo"));
  imposta(k("TEST0006", 1, 1), artAllegato(1, "primo articolo dell'allegato"));
  r = await chiama({ codice_redazionale: "TEST0006", data_gu: "2020-01-01" });
  verifica("art. 2 in errore → si mostra l'art. 1 del corpo, non l'allegato",
    !r.errore && r.testo.includes("primo articolo del corpo") && !r.testo.includes("testo unico"), corto(r));

  // --- testo_completo -------------------------------------------------------------

  // Falso 404 a metà atto → recuperato; la fine (404 specifico sull'art. 9) è certa.
  for (let n = 1; n <= 8; n++) imposta(k("TEST0001", n, 0), artAkn(n, `testo dell'articolo ${n}`));
  imposta(k("TEST0001", 3, 0), R404, artAkn(3, "testo dell'articolo 3"));
  r = await chiama({ codice_redazionale: "TEST0001", data_gu: "2020-01-01", testo_completo: true });
  let presenti = [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => r.testo.includes(`testo dell'articolo ${n}`)).length;
  verifica("testo_completo: falso 404 sull'art. 3 recuperato, 8 articoli su 8, nessun avviso",
    !r.errore && presenti === 8 && !r.testo.includes("PARZIALE"), `${presenti}/8: ${r.testo.slice(-300)}`);

  // Art. 3 sempre in errore: gli articoli successivi ci sono e il buco è dichiarato.
  for (let n = 1; n <= 8; n++) imposta(k("TEST0013", n, 0), artAkn(n, `testo dell'articolo ${n}`));
  imposta(k("TEST0013", 3, 0), R404);
  r = await chiama({ codice_redazionale: "TEST0013", data_gu: "2020-01-01", testo_completo: true });
  presenti = [1, 2, 4, 5, 6, 7, 8].filter((n) => r.testo.includes(`testo dell'articolo ${n}`)).length;
  verifica("testo_completo: art. 3 sempre in errore → artt. 1-2 e 4-8 presenti, art. 3 dichiarato mancante",
    !r.errore && presenti === 7 && r.testo.includes("PARZIALE") && r.testo.includes("l'art. 3"), `${presenti}/7: ${r.testo.slice(-300)}`);
  verifica("testo_completo: art. 3 ritentato in un secondo giro (8 richieste)", conta(k("TEST0013", 3, 0)) === 8, `${conta(k("TEST0013", 3, 0))} chiamate`);

  // Blocco anti-bot durante la scansione: ci si ferma e si avvisa.
  for (let n = 1; n <= 8; n++) imposta(k("TEST0015", n, 0), artAkn(n, `testo dell'articolo ${n}`));
  imposta(k("TEST0015", 2, 0), R409);
  r = await chiama({ codice_redazionale: "TEST0015", data_gu: "2020-01-01", testo_completo: true });
  verifica("testo_completo: 409 → scansione fermata, PARZIALE, invito ad attendere",
    !r.errore && r.testo.includes("bloccando") && r.testo.includes("PARZIALE") && conta(k("TEST0015", 2, 0)) === 2 && conta(k("TEST0015", 7, 0)) === 0,
    `${conta(k("TEST0015", 2, 0))}/${conta(k("TEST0015", 7, 0))} chiamate: ${r.testo.slice(-300)}`);

  // Normattiva giù: il primo gruppo fallisce per intero → errore, senza insistere sul resto.
  for (let n = 1; n <= 6; n++) imposta(k("TEST0016", n, 0), R404);
  r = await chiama({ codice_redazionale: "TEST0016", data_gu: "2020-01-01", testo_completo: true });
  verifica("testo_completo: tutto in errore → errore temporaneo, scansione fermata al primo gruppo",
    r.errore && r.testo.includes("Errore temporaneo") && conta(k("TEST0016", 7, 0)) === 0, `${conta(k("TEST0016", 7, 0))} chiamate: ${corto(r)}`);

  await client.close();

  // --- Budget di tempo, con un server dal budget corto (2 s) ---------------------
  const breve = await avvia(porta, { NORMATTIVA_BUDGET_MS: "2000" });
  imposta(k(CC, 2046, 2), SOSPESA);
  r = await breve.chiama({ nome_codice: "codice civile", articolo: 2046 });
  verifica("Normattiva non risponde: articolo → risposta entro il budget, errore temporaneo",
    r.errore && r.ms < 4000 && r.testo.includes("Errore temporaneo"), `${r.ms} ms: ${corto(r)}`);
  r = await breve.chiama({ tipo_atto: "LEGGE", numero: 997, anno: 2020, articolo: 1 });
  verifica("Normattiva non risponde: ricerca → risposta entro il budget", r.errore && r.ms < 4000, `${r.ms} ms: ${corto(r)}`);
  imposta(k("TEST0011", 5, 0), SOSPESA);
  r = await breve.chiama({ codice_redazionale: "TEST0011", data_gu: "2020-01-01", articolo: 5 });
  verifica("Normattiva non risponde: esplorazione delle sezioni → entro il budget, allegati non interrogati",
    r.errore && r.ms < 4000 && perSezione("TEST0011", 5) === "[1,0,0,0]", `${r.ms} ms ${perSezione("TEST0011", 5)}: ${corto(r)}`);
  // Scansione: l'art. 7 non risponde fino allo scadere del budget → non viene spacciato per la fine dell'atto.
  for (let n = 1; n <= 8; n++) imposta(k("TEST0014", n, 0), artAkn(n, `testo dell'articolo ${n}`));
  imposta(k("TEST0014", 7, 0), SOSPESA);
  r = await breve.chiama({ codice_redazionale: "TEST0014", data_gu: "2020-01-01", testo_completo: true });
  presenti = [1, 2, 3, 4, 5, 6, 8].filter((n) => r.testo.includes(`testo dell'articolo ${n}`)).length;
  verifica("testo_completo a budget scaduto: art. 8 presente, art. 7 dichiarato mancante",
    !r.errore && r.ms < 4000 && presenti === 7 && r.testo.includes("PARZIALE") && r.testo.includes("l'art. 7"), `${r.ms} ms, ${presenti}/7: ${r.testo.slice(-300)}`);
  await breve.client.close();

  for (const res of sospese) res.destroy();
  server.closeAllConnections?.();
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
