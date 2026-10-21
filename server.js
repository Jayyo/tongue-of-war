// @ts-check
// Local server: static files + the LLM opponent endpoint.
//
// The browser never sees an API key and never sends a prompt. It POSTs a public
// battlefield snapshot to /api/opponent; the server validates it, builds the
// commander's prompt (src/ai/opponent-prompt.js) and asks the configured model
// for one Korean sentence. That sentence then runs through the SAME interpreter
// and BP compiler the human's sentence does. With no key configured the game
// plays against the scripted bot.
//
//   npm start                      http://127.0.0.1:8123
//   PORT=9000 HOST=0.0.0.0 npm start
//
// Configuration comes from the environment or a .env file (see .env.example).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSystemPrompt, buildUserPrompt, cacheKeyOf, readSnapshot, sanitizeSentence,
} from './src/ai/opponent-prompt.js';
import { getCommander } from './src/domain/commanders.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// --no-dotenv keeps tests from picking up a developer's real keys.
if (!process.argv.includes('--no-dotenv')) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env: fine */ }
}

const PORT = Number(process.env.PORT ?? 8123);
const HOST = process.env.HOST ?? '127.0.0.1';
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 9000);
const MAX_OUTPUT_TOKENS = 600;   // a sentence is ~30 tokens; the rest is headroom for reasoning models
const RATE_PER_MINUTE = 12;      // upstream calls per client address; one wave is 12 s
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

// ---------------------------------------------------------------- providers
/**
 * Defaults were picked by timing the game's real prompt: a 12 s wave needs an
 * answer in a couple of seconds, so each default is a fast model with reasoning
 * turned down (gpt-6-luna/none 1.3-2.3 s, gemini-3.5-flash/minimal ~1.6 s,
 * deepseek-chat ~1 s). Larger reasoning models took 5-7 s and sometimes spent
 * the whole output budget on reasoning. Any model can be chosen with LLM_MODEL.
 */
const PROVIDERS = {
  // Any server that speaks the OpenAI chat-completions format: a local llama.cpp,
  // Ollama or vLLM server, or a hosted one. Needs LLM_BASE_URL and LLM_MODEL, and
  // wins the automatic pick when LLM_BASE_URL is set.
  'openai-compatible': {
    key: () => process.env.LLM_BASE_URL,
    model: null,
    effort: null,
    call: (cfg, sys, user, signal) => chatCompletions(`${process.env.LLM_BASE_URL?.replace(/\/+$/, '')}/chat/completions`,
      process.env.LLM_API_KEY, cfg, sys, user, signal, 'max_tokens'),
  },
  openai: {
    key: () => process.env.OPENAI_API_KEY,
    model: 'gpt-6-luna',
    effort: 'none',
    call: (cfg, sys, user, signal) => chatCompletions('https://api.openai.com/v1/chat/completions',
      process.env.OPENAI_API_KEY, cfg, sys, user, signal, 'max_completion_tokens'),
  },
  gemini: {
    key: () => process.env.GEMINI_API_KEY,
    model: 'gemini-3.5-flash',
    effort: 'minimal',
    call: gemini,
  },
  deepseek: {
    key: () => process.env.DEEPSEEK_API_KEY,
    model: 'deepseek-chat',
    effort: null,
    call: (cfg, sys, user, signal) => chatCompletions('https://api.deepseek.com/chat/completions',
      process.env.DEEPSEEK_API_KEY, cfg, sys, user, signal, 'max_tokens'),
  },
};

function pickProvider() {
  const wanted = process.env.LLM_PROVIDER;
  if (wanted && !PROVIDERS[wanted]) {
    console.warn(`LLM_PROVIDER=${wanted} is not one of ${Object.keys(PROVIDERS).join(', ')}; using the scripted bot`);
    return null;
  }
  const id = wanted ?? Object.keys(PROVIDERS).find((k) => PROVIDERS[k].key());
  if (!id || !PROVIDERS[id].key()) return null;
  const p = PROVIDERS[id];
  const model = process.env.LLM_MODEL || p.model;
  if (!model) {
    console.warn(`LLM_PROVIDER=${id} needs LLM_MODEL; using the scripted bot`);
    return null;
  }
  const effort = process.env.LLM_REASONING_EFFORT ?? p.effort;
  return { id, model, effort: effort || null, call: p.call };
}

const provider = pickProvider();

async function chatCompletions(url, key, cfg, sys, user, signal, maxField) {
  const body = {
    model: cfg.model,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    [maxField]: MAX_OUTPUT_TOKENS,
  };
  if (cfg.effort) body.reasoning_effort = cfg.effort;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, error: text.replace(/\s+/g, ' ').slice(0, 300) };
  return { text: JSON.parse(text)?.choices?.[0]?.message?.content ?? '' };
}

async function gemini(cfg, sys, user, signal) {
  const generationConfig = { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.9 };
  if (cfg.effort) generationConfig.thinkingConfig = { thinkingLevel: cfg.effort };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig,
    }),
    signal,
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, error: text.replace(/\s+/g, ' ').slice(0, 300) };
  const parts = JSON.parse(text)?.candidates?.[0]?.content?.parts ?? [];
  return { text: parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('') };
}

/** One upstream call inside a fixed time budget. Reasoning effort is dropped
 *  (once, and remembered) if the model rejects the configured level. */
async function askModel(sys, user) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    let out = await provider.call(provider, sys, user, ctl.signal);
    if (out.status === 400 && provider.effort && /reasoning|thinking/i.test(out.error ?? '')) {
      console.warn(`${provider.model} rejected reasoning effort "${provider.effort}"; retrying without it`);
      provider.effort = null;
      out = await provider.call(provider, sys, user, ctl.signal);
    }
    if (out.status) {
      console.warn(`LLM ${provider.id}/${provider.model} HTTP ${out.status}: ${out.error}`);
      return { ok: false, error: `http_${out.status}` };
    }
    const sentence = sanitizeSentence(out.text);
    if (!sentence) return { ok: false, error: 'empty' };
    return { ok: true, text: sentence, provider: provider.id, model: provider.model, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- cache + rate limit
// Same quantised situation -> same sentence: saves calls when a situation repeats
// and makes repeat play feel consistent.
const cache = new Map();
const CACHE_MAX = 500;
const recent = new Map();   // client address -> timestamps of upstream calls

function allowCall(addr) {
  const now = Date.now();
  const list = (recent.get(addr) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= RATE_PER_MINUTE) { recent.set(addr, list); return false; }
  list.push(now);
  recent.set(addr, list);
  if (recent.size > 1000) recent.delete(recent.keys().next().value);
  return true;
}

// ---------------------------------------------------------------- routes
async function handleOpponent(req, res) {
  if (!provider) return send(res, 200, { ok: false, error: 'no_provider' });
  // JSON only: a cross-site page cannot send this without a CORS preflight, which
  // this server never approves.
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    return send(res, 415, { ok: false, error: 'json_only' });
  }
  const body = await readJson(req, 16_384);
  if (body === undefined) {
    res.setHeader('Connection', 'close');
    return send(res, 413, { ok: false, error: 'too_large' });
  }
  const input = readSnapshot(body);
  if (!input.ok) return send(res, 400, { ok: false, error: `bad_${input.error}` });

  const key = cacheKeyOf(input.commanderId, input.snap, input.difficulty);
  const hit = cache.get(key);
  if (hit) return send(res, 200, { ...hit, cached: true });
  if (!allowCall(req.socket.remoteAddress ?? '?')) return send(res, 429, { ok: false, error: 'rate_limited' });

  const out = await askModel(buildSystemPrompt(getCommander(input.commanderId)), buildUserPrompt(input.snap));
  if (out.ok) {
    cache.set(key, out);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  send(res, out.ok ? 200 : 502, out);
}

function handleHealth(_req, res) {
  send(res, 200, { ok: true, provider: provider?.id ?? null, model: provider?.model ?? null });
}

// Only what the page actually loads is served — never dotfiles, tools or the .env.
const PUBLIC = [
  /^\/index\.html$/,
  /^\/src\/[\w/-]+\.(js|css)$/,
  /^\/assets\/[\w/-]+\.(webp|json)$/,
  /^\/node_modules\/three\/build\/three\.(module|core)\.js$/,
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
};

function serveStatic(pathname, res) {
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { return send(res, 400, { error: 'bad path' }); }
  if (!PUBLIC.some((re) => re.test(rel))) { res.writeHead(404); return res.end('not found'); }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',   // local dev server: never serve a stale module
      'X-Content-Type-Options': 'nosniff',
      // No framing: a page elsewhere must not be able to wrap the game and click
      // through matches on the player's key.
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/') && !sameSite(req)) return send(res, 403, { error: 'forbidden' });
    if (url.pathname === '/api/opponent' && req.method === 'POST') return await handleOpponent(req, res);
    if (url.pathname === '/api/health') return handleHealth(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(url.pathname, res);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'internal error' });
  }
});

/**
 * The API is for the page this server serves. Reject other origins, and while
 * bound to loopback also reject unexpected Host headers (DNS rebinding).
 */
function sameSite(req) {
  const host = req.headers.host ?? '';
  if (LOOPBACK && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

/** Resolves to the parsed body, null for invalid JSON, undefined if it is too large. */
function readJson(req, limit) {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length'] ?? 0) > limit) { req.resume(); return resolve(undefined); }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) finish(undefined);     // keep draining; the 413 closes the connection
      else chunks.push(c);
    });
    // Decode once at the end: a multi-byte Hangul character can straddle two chunks.
    req.on('end', () => { try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(null); } });
    req.on('error', () => finish(null));
  });
}

function send(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, HOST, () => {
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  console.log(`Tongue of War  ->  http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${port}`);
  console.log(provider
    ? `opponent: ${provider.id} / ${provider.model}${provider.effort ? ` (reasoning ${provider.effort})` : ''}`
    : 'opponent: scripted bot (no LLM key configured, see .env.example)');
  if (provider && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    console.warn(`warning: listening on ${HOST} with an API key configured. Anyone who can reach this port can ` +
      `spend it (rate limit ${RATE_PER_MINUTE} calls/min per address).`);
  }
});
