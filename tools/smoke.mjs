// Browser smoke test: start the server, play the opening of a match in headless
// Chromium, fail on any page error, console error or failed request.
//
//   npx playwright install chromium     (once)
//   npm run smoke                       keyless: the scripted bot answers
//   npm run smoke -- --mock-llm         a local fake model answers through /api/opponent
//
// --mock-llm points the server at an in-process OpenAI-compatible stub, so the
// whole opponent path (snapshot -> server prompt -> model -> parser -> summon) is
// exercised without an API key.

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.join(import.meta.dirname, '..');
const MOCK_SENTENCE = '적 후열을 파고드는 날렵한 그림자 자객 셋';
const useMock = process.argv.includes('--mock-llm');

function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: `"${MOCK_SENTENCE}."` } }] }));
      });
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (b) => {
      const m = String(b).match(/http:\/\/[\d.]+:(\d+)/);
      if (m) resolve({ child, url: `http://127.0.0.1:${m[1]}/` });
    });
    child.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
}

const env = { ...process.env, PORT: '0', HOST: '127.0.0.1' };
for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'LLM_PROVIDER', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_REASONING_EFFORT']) delete env[k];
const mock = useMock ? await startMock() : null;
if (mock) Object.assign(env, { LLM_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, LLM_MODEL: 'mock' });

const { child, url } = await startServer(env);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const problems = [];
let ok = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('button.cmd-card[data-id=lucifer]');
  await page.click('#btn-start');
  await page.fill('#prompt-input', '앞을 막아서는 느린 탱크 셋');
  await page.waitForFunction(() => document.querySelectorAll('#receipt .sp').length >= 3);
  await page.click('#btn-summon');
  // the first opponent turn comes at the 12 s wave edge
  await page.waitForFunction(() => !document.querySelector('#foe-quote').hidden, null, { timeout: 25_000 });

  const seen = await page.evaluate(() => ({
    clock: document.querySelector('#clock').textContent,
    receipt: [...document.querySelectorAll('#receipt .sp b')].map((b) => b.textContent),
    quote: document.querySelector('#fq-text').textContent,
    tag: document.querySelector('#fq-tag').textContent,
    log: [...document.querySelectorAll('#log div')].map((d) => d.textContent),
  }));
  console.log(JSON.stringify(seen, null, 2));

  if (!seen.receipt.includes('탱크')) problems.push('receipt did not show the parsed noun');
  if (!seen.log.some((l) => l.includes('출전'))) problems.push('no cohort entered the field');
  if (useMock && seen.quote !== MOCK_SENTENCE) problems.push(`opponent did not use the model sentence: ${seen.quote}`);
  if (!useMock && !seen.tag.startsWith('내장 봇')) problems.push(`keyless match should be played by the bot, got "${seen.tag}"`);
  ok = problems.length === 0;
} catch (e) {
  problems.push(String(e?.message ?? e));
} finally {
  await browser.close();
  child.kill();
  mock?.close();
}
for (const p of problems) console.error(`FAIL ${p}`);
console.log(ok ? 'smoke: ok' : 'smoke: failed');
process.exit(ok ? 0 : 1);
