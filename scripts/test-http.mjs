#!/usr/bin/env node
/**
 * Test del modo HTTP (`node build/index.js --http`), senza rete.
 *
 * Perché esiste: dal 2026-10-26 il server non passa più da supergateway ma
 * parla Streamable HTTP da sé, senza sessioni, con la chiave nell'indirizzo
 * (`/mcp/<MCP_URL_TOKEN>`). Questo test avvia il server buildato contro un finto
 * Normattiva locale e verifica:
 *  - /healthz libero, con la protezione dichiarata;
 *  - 404 (mai 401) senza chiave, con la chiave sbagliata e sulle rotte OAuth;
 *  - 405 su GET (niente stream da aprire senza sessioni);
 *  - con la chiave giusta: initialize, elenco dei tool e una chiamata vera;
 *  - l'header `MCP-Protocol-Version: 2026-07-28` accettato (riportato all'ultima
 *    versione supportata), come faceva la Transform Rule di Cloudflare;
 *  - due client in parallelo senza interferenze;
 *  - una MCP_URL_TOKEN troppo corta: il server non parte.
 *
 * Uso: npm run build && npm run test-http
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CHIAVE = "chiave-di-prova-per-il-test-http-0123456789";
let ok = 0;
let ko = 0;
function verifica(nome, condizione, dettaglio = "") {
  if (condizione) { ok++; console.log(`  ok  ${nome}`); }
  else { ko++; console.log(`  KO  ${nome} ${dettaglio}`); }
}

// Finto Normattiva: risponde solo alle collezioni predefinite.
const finto = http.createServer((req, res) => {
  if (req.url.endsWith("/collections/collection-predefinite")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{ nomeCollezione: "Atti di prova", numeroAtti: 3 }]));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "non previsto dal test" }));
});
await new Promise((r) => finto.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${finto.address().port}`;

function porta() {
  return new Promise((r) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
}

function avvia(env) {
  const figlio = spawn(process.execPath, ["build/index.js", "--http"], {
    env: { ...process.env, NORMATTIVA_API_BASE: API, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  figlio.stderr.on("data", (d) => { log += d; });
  return { figlio, log: () => log };
}

async function pronto(base) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${base}/healthz`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const P = await porta();
const BASE = `http://127.0.0.1:${P}`;
const srv = avvia({ PORT: String(P), MCP_URL_TOKEN: CHIAVE });
try {
  verifica("il server parte", await pronto(BASE), srv.log());

  const salute = await (await fetch(`${BASE}/healthz`)).json();
  verifica("/healthz dichiara la chiave", salute.protezione === "chiave", JSON.stringify(salute));

  const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  for (const [nome, percorso] of [["senza chiave", "/mcp"], ["chiave sbagliata", "/mcp/" + "x".repeat(CHIAVE.length)], ["rotta OAuth", "/.well-known/oauth-protected-resource/mcp"]]) {
    const r = await fetch(BASE + percorso, { method: "POST", headers: H, body: initBody });
    verifica(`404 ${nome}`, r.status === 404, `(status ${r.status})`);
  }
  const g = await fetch(`${BASE}/mcp/${CHIAVE}`, { method: "GET", headers: { Accept: "text/event-stream" } });
  verifica("405 su GET", g.status === 405, `(status ${g.status})`);

  const url = new URL(`${BASE}/mcp/${CHIAVE}`);
  const client = new Client({ name: "test-http", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  verifica("initialize con la chiave", client.getServerVersion()?.version === "1.5.0", JSON.stringify(client.getServerVersion()));
  const { tools } = await client.listTools();
  verifica("8 tool", tools.length === 8, `(${tools.length})`);
  const col = await client.callTool({ name: "collezioni_predefinite", arguments: {} });
  verifica("tools/call arriva al finto Normattiva", col.content?.[0]?.text?.includes("Atti di prova"), JSON.stringify(col).slice(0, 200));
  await client.close();

  const r26 = await fetch(`${BASE}/mcp/${CHIAVE}`, {
    method: "POST",
    headers: { ...H, "MCP-Protocol-Version": "2026-07-28" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const j26 = r26.ok ? await r26.json() : null;
  verifica("header di protocollo 2026-07-28 accettato", r26.status === 200 && j26?.result?.tools?.length === 8, `(status ${r26.status})`);

  const due = await Promise.all([1, 2].map(async (n) => {
    const c = new Client({ name: `parallelo-${n}`, version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(url));
    const r = await c.callTool({ name: "collezioni_predefinite", arguments: {} });
    await c.close();
    return r.content?.[0]?.text?.includes("Atti di prova");
  }));
  verifica("due client in parallelo", due.every(Boolean), JSON.stringify(due));
} finally {
  srv.figlio.kill();
}

// Chiave troppo corta: il server deve rifiutarsi di partire.
const P2 = await porta();
const corto = avvia({ PORT: String(P2), MCP_URL_TOKEN: "corta" });
const codice = await new Promise((r) => { corto.figlio.on("exit", r); setTimeout(() => { corto.figlio.kill(); r("ancora vivo"); }, 5000); });
verifica("chiave corta: il server non parte", codice !== "ancora vivo" && codice !== 0, `(uscita ${codice})`);

finto.close();
console.log(`\n${ok} ok, ${ko} KO`);
process.exit(ko ? 1 : 0);
