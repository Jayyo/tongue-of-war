// Browser smoke test: start the server, play the opening of a match in headless
// Chromium, and fail on any page error, console error, failed request or HTTP error.
//
//   npx playwright install chromium     (once)
//   npm run smoke                       keyless: the scripted bot answers
//   npm run smoke -- --mock-llm         a local fake model answers through /api/opponent
//
// The server is started with --no-dotenv and without any provider variables, so a
// developer's own keys are never used. --mock-llm points it at an in-process
// OpenAI-compatible stub and checks that the stub received the server-built prompt.

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.join(import.meta.dirname, '..');
const MOCK_SENTENCE = '적 후열을 파고드는 날렵한 그림자 자객 셋';
const useMock = process.argv.includes('--mock-llm');
const problems = [];
const mockCalls = [];

function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try { mockCalls.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { mockCalls.push(null); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: `"${MOCK_SENTENCE}."` } }] }));
      });
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js', '--no-dotenv'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not start within 10 s')); }, 10_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}`)); });
    child.stdout.on('data', (b) => {
      const m = String(b).match(/http:\/\/[\d.]+:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, url: `http://127.0.0.1:${m[1]}/` }); }
    });
  });
}

/** Watches one page for anything that should never happen in a clean run. */
function watch(page) {
  const seen = { opponentCalls: 0 };
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('request', (r) => { if (r.url().endsWith('/api/opponent')) seen.opponentCalls++; });
  return seen;
}

async function openingAsLucifer(page, url) {
  const seen = watch(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('button.cmd-card[data-id=lucifer]');
  await page.click('#btn-start');
  await page.fill('#prompt-input', '앞을 막아서는 느린 탱크 셋');
  await page.waitForFunction(() => document.querySelectorAll('#receipt .sp').length >= 3);
  await page.click('#btn-summon');
  // the first opponent turn comes at the 12 s wave edge
  await page.waitForFunction(() => !document.querySelector('#foe-quote').hidden, null, { timeout: 25_000 });
  // Our three tanks plus at least one opponent unit, every one of them assembled from
  // its part sheet. The opponent's cohort lands 0.6 s after its quote appears.
  await page.waitForFunction(() => {
    const c = document.querySelector('#field').dataset;
    return Number(c.units) >= 4 && c.units === c.rigged;
  }, null, { timeout: 8_000 }).catch(() => problems.push('opponent never landed, or some units are still flat sprites'));

  const out = await page.evaluate(() => ({
    clock: document.querySelector('#clock').textContent,
    receipt: [...document.querySelectorAll('#receipt .sp b')].map((b) => b.textContent),
    quote: document.querySelector('#fq-text').textContent,
    tag: document.querySelector('#fq-tag').textContent,
    rigs: `${document.querySelector('#field').dataset.rigged}/${document.querySelector('#field').dataset.units}`,
    log: [...document.querySelectorAll('#log div')].map((d) => d.textContent),
  }));
  console.log(JSON.stringify(out, null, 2));

  await page.close();
  if (!out.receipt.includes('탱크')) problems.push('receipt did not show the parsed noun');
  if (!out.log.some((l) => l.includes('출전'))) problems.push('no cohort entered the field');
  if (useMock) {
    if (out.quote !== MOCK_SENTENCE) problems.push(`opponent did not use the model sentence: ${out.quote}`);
    const call = mockCalls[0];
    const [system, user] = call?.messages ?? [];
    if (!system?.content?.includes('강령전쟁') || !user?.content?.startsWith('## 전황')) {
      problems.push('the model did not receive the prompt the server builds');
    }
  } else {
    if (!out.tag.startsWith('내장 봇')) problems.push(`keyless match should be played by the bot, got "${out.tag}"`);
    if (seen.opponentCalls) problems.push(`keyless client still called /api/opponent ${seen.opponentCalls}x`);
  }
}

/** The alchemist's transmute: engrave a design, flip its damage channel, pay 30. */
async function transmuteAsAlchemist(page, url) {
  watch(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('button.cmd-card[data-id=alchemist]');
  await page.click('#btn-start');
  await page.fill('#prompt-input', '멀리서 꿰뚫는 강철 장궁대');
  await page.waitForFunction(() => document.querySelectorAll('#receipt .sp').length >= 2);
  await page.click('#btn-summon');
  // the HUD repaints on the next frame, so first see the summon paid for, then wait for income
  const essence = (cmp) => page.waitForFunction(cmp, null, { timeout: 15_000 });
  await essence(() => Number(document.querySelector('#res-p2').textContent) < 72);
  await essence(() => Number(document.querySelector('#res-p2').textContent) >= 72);
  await page.click('#btn-engrave');
  await essence(() => Number(document.querySelector('#res-p2').textContent) < 30);
  await essence(() => Number(document.querySelector('#res-p2').textContent) >= 30);
  const card = page.locator('#card-slots .card:not(.empty)');
  const before = await card.getAttribute('title');
  await page.click('#btn-transmute');
  const essenceBefore = Number(await page.textContent('#res-p2'));
  await card.click();
  // the HUD (log and essence) repaints on the next animation frame
  await page.waitForFunction(() => document.querySelector('#log').textContent.includes('전투 연성'));
  const essenceAfter = Number(await page.textContent('#res-p2'));
  const after = await card.getAttribute('title');
  console.log(`transmute: ${before} -> ${after}, essence ${essenceBefore} -> ${essenceAfter}`);
  if (!before?.endsWith('(물리)') || !after?.endsWith('(비술)')) problems.push('transmute did not flip the engraved card to arcane');
  if (!(essenceBefore - essenceAfter >= 20)) problems.push('transmute did not charge its cost');
}

const env = { ...process.env, PORT: '0', HOST: '127.0.0.1' };
for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'LLM_PROVIDER', 'LLM_MODEL',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_REASONING_EFFORT']) delete env[k];

let mock, server, browser;
try {
  mock = useMock ? await startMock() : null;
  if (mock) Object.assign(env, { LLM_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, LLM_MODEL: 'mock' });
  server = await startServer(env);
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const viewport = { width: 1440, height: 900 };
  await openingAsLucifer(await browser.newPage({ viewport }), server.url);
  await transmuteAsAlchemist(await browser.newPage({ viewport }), server.url);
} catch (e) {
  problems.push(String(e?.message ?? e));
} finally {
  try { await browser?.close(); } finally {
    server?.child.kill();
    mock?.close();
  }
}
for (const p of problems) console.error(`FAIL ${p}`);
console.log(problems.length ? 'smoke: failed' : 'smoke: ok');
process.exit(problems.length ? 1 : 0);
