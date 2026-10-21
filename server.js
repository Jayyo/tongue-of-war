// @ts-check
// Dev server: static files + LLM proxy.
//
// The browser never sees an API key. It POSTs a battlefield snapshot to
// /api/opponent and gets back {sentence, commanderId} — the AI commander's
// actual Korean sentence, which then runs through the SAME interpreter and BP
// compiler the human's sentence does. That symmetry is the whole point: the AI
// is playing the game, not bypassing it.
//
//   node server.js            (default :8123)
//   PORT=9000 node server.js

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- providers
/**
 * Provider order is by "fast enough to answer inside a 12s wave, with good
 * Korean". Whichever key exists wins; everything falls back to the local stub
 * on the client if this endpoint fails.
 */
const PROVIDERS = [
  {
    id: 'openai',
    key: () => process.env.OPENAI_API_KEY,
    url: 'https://api.openai.com/v1/chat/completions',
    // Measured on this box: gpt-5.4-mini ~2.0s, gpt-5.5 ~4.2s per sentence.
    // Both fit inside a 12s wave; mini is the default because the opponent
    // answering fast is what makes the exchange feel like a duel.
    model: process.env.GAME_LLM_MODEL || 'gpt-5.4-mini',
    build: (model, sys, user) => ({
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: {
        model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        max_completion_tokens: 220,
      },
    }),
    parse: (j) => j?.choices?.[0]?.message?.content,
  },
  {
    id: 'gemini',
    key: () => process.env.GEMINI_API_KEY,
    url: null, // built per-request
    model: process.env.GAME_LLM_MODEL || 'gemini-3-flash',
    build: (model, sys, user) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      headers: {},
      body: {
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 220, temperature: 0.9 },
      },
    }),
    parse: (j) => j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(''),
  },
  {
    id: 'deepseek',
    key: () => process.env.DEEPSEEK_API_KEY,
    url: 'https://api.deepseek.com/chat/completions',
    model: process.env.GAME_LLM_MODEL || 'deepseek-chat',
    build: (model, sys, user) => ({
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: {
        model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        max_tokens: 220, temperature: 1.0,
      },
    }),
    parse: (j) => j?.choices?.[0]?.message?.content,
  },
];

function activeProvider() {
  const forced = process.env.GAME_LLM_PROVIDER;
  const list = forced ? PROVIDERS.filter((p) => p.id === forced) : PROVIDERS;
  return list.find((p) => p.key());
}

// ---------------------------------------------------------------- cache
// Same quantised situation -> same sentence. Keeps a 6-minute match to a handful
// of real calls and makes repeat play feel consistent (Infinite Craft's trick).
const cache = new Map();
const CACHE_MAX = 500;

function cacheGet(k) { return cache.get(k); }
function cacheSet(k, v) {
  cache.set(k, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ---------------------------------------------------------------- LLM call
async function callLLM(sys, user, timeoutMs = 9000) {
  const prov = activeProvider();
  if (!prov) return { ok: false, error: 'no_api_key' };

  const spec = prov.build(prov.model, sys, user);
  const url = spec.url ?? prov.url;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...spec.headers },
      body: JSON.stringify(spec.body),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `http_${res.status}`, detail: text.slice(0, 300), provider: prov.id };
    const json = JSON.parse(text);
    const out = prov.parse(json);
    if (!out) return { ok: false, error: 'empty', detail: text.slice(0, 300), provider: prov.id };
    return { ok: true, text: out.trim(), provider: prov.id, model: prov.model, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: String(e?.name === 'AbortError' ? 'timeout' : e).slice(0, 200), provider: prov.id };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- routes
async function handleOpponent(req, res) {
  const body = await readJson(req);
  const { system, user, cacheKey } = body ?? {};
  if (!system || !user) return send(res, 400, { error: 'system and user required' });

  if (cacheKey) {
    const hit = cacheGet(cacheKey);
    if (hit) return send(res, 200, { ...hit, cached: true });
  }
  const out = await callLLM(system, user);
  if (out.ok && cacheKey) cacheSet(cacheKey, out);
  send(res, out.ok ? 200 : 502, out);
}

function handleHealth(_req, res) {
  const prov = activeProvider();
  send(res, 200, {
    ok: true,
    provider: prov?.id ?? null,
    model: prov?.model ?? null,
    keysPresent: PROVIDERS.filter((p) => p.key()).map((p) => p.id),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/opponent' && req.method === 'POST') return handleOpponent(req, res);
    if (url.pathname === '/api/health') return handleHealth(req, res);
    return serveStatic(url.pathname, res);
  } catch (e) {
    send(res, 500, { error: String(e).slice(0, 300) });
  }
});

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',   // dev: never serve a stale module
    });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  });
}

function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

server.listen(PORT, () => {
  const prov = activeProvider();
  console.log(`강령전쟁 dev server  →  http://localhost:${PORT}`);
  console.log(prov ? `LLM: ${prov.id} / ${prov.model}` : 'LLM: (키 없음 — 로컬 스텁 봇으로 동작)');
});
