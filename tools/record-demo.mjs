// Records the README media in headless Chromium: a still of the select screen and
// an animated clip of a match opening. The page runs on Playwright's fake clock and
// each frame is taken after a fixed amount of game time (100 ms, 180 ms per typed
// syllable, 400 ms in the time-lapse), so slow software WebGL does not show up as
// stutter and a run is repeatable apart from the opponent's sentence.
//
//   npx playwright install chromium        (once; needs ffmpeg built with libwebp)
//   node tools/record-demo.mjs             writes docs/media/{select,demo}.webp
//
// The opponent is whatever the server is configured with (environment or .env):
// with OPENAI_API_KEY or another provider it films the LLM commander, without one
// the bot. The opponent's tag is printed so you can check which one it was.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'media');
const FRAMES = fs.mkdtempSync(path.join(os.tmpdir(), 'tow-frames-'));
const VIEW = { width: 1280, height: 800 };
const STEP = 100;            // ms of game time per frame in normal-speed segments (10 fps clip)

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, env: { ...process.env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not start within 10 s')); }, 10_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}`)); });
    child.stdout.on('data', (b) => {
      const m = String(b).match(/http:\/\/[\d.]+:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, url: `http://127.0.0.1:${m[1]}/` }); }
    });
  });
}

async function record(browser, url) {
  // The select screen is shot on a normal page: CSS transitions do not advance
  // while the fake clock is paused.
  const plain = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
  await plain.goto(url, { waitUntil: 'networkidle' });
  await plain.click('button.cmd-card[data-id=baal]');
  await plain.waitForTimeout(800);
  await plain.screenshot({ path: path.join(FRAMES, 'select.png') });
  await plain.close();

  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
  // Page.captureScreenshot straight over CDP: page.screenshot() waits on page-side
  // animation frames, which never come while the fake clock is paused.
  const cdp = await page.context().newCDPSession(page);
  let frame = 0;
  const shot = async () => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(FRAMES, `f${String(frame++).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
  };
  let gameMs = 0;
  const advance = async (ms) => { await page.clock.runFor(ms); gameMs += ms; };
  /** Advance game time, one frame per `every` ms (every > STEP is a time-lapse). */
  const play = async (ms, every = STEP) => {
    for (let t = 0; t < ms; t += every) { await advance(every); await shot(); }
  };
  /** One syllable per frame; 180 ms each lets the 170 ms receipt debounce fire. */
  const type = async (text) => {
    for (let i = 1; i <= text.length; i++) {
      await page.fill('#prompt-input', text.slice(0, i));
      await advance(180);
      if (text[i - 1] !== ' ') await shot();
    }
    await play(800);
  };
  /** Real-time wait while the page's own clock stays frozen (e.g. for the model's reply). */
  const until = async (fn, ms = 20_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      if (await page.evaluate(fn)) return;
    }
    throw new Error('timed out waiting for the page');
  };

  // install() alone lets fake time keep flowing with the wall clock; pausing it
  // means only runFor() moves the game.
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  await page.clock.install({ time: t0 });
  await page.clock.pauseAt(t0 + 1000);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('button.cmd-card[data-id=baal]');
  await page.click('#btn-start');
  await type('앞을 막아서는 두꺼운 탱크 셋');              // "thick tanks x3 that hold the line"
  await page.click('#btn-summon');
  await play(2500);
  await play(12_100 - gameMs, 400);                        // 4x time-lapse to the first wave edge
  // the opponent is asked at the wave edge; freeze the game until its sentence lands
  await until(() => !document.querySelector('#foe-quote').hidden);
  console.log('opponent:', await page.evaluate(() =>
    `${document.querySelector('#fq-tag').textContent} | ${document.querySelector('#fq-text').textContent}`));
  await play(2000);
  await type('적 후열을 파고드는 날렵한 그림자 자객 셋');   // "swift shadow assassins x3 that dive the enemy back line"
  await page.click('#btn-summon');
  await play(4500);
}

let server, browser;
try {
  fs.mkdirSync(OUT, { recursive: true });
  server = await startServer();
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  await record(browser, server.url);
  try { await browser.close(); } finally { server.child.kill(); }

  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(FRAMES, 'select.png'),
    '-c:v', 'libwebp', '-quality', '86', path.join(OUT, 'select.webp')]);
  // Animated WebP rather than GIF: at full width the HUD text stays readable and the
  // file is about half the size of a blurry 800 px GIF.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(1000 / STEP), '-i', path.join(FRAMES, 'f%04d.png'),
    '-c:v', 'libwebp_anim', '-quality', '75', '-compression_level', '6', '-loop', '0', path.join(OUT, 'demo.webp')]);
  for (const f of fs.readdirSync(OUT)) console.log(`${f}  ${(fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2)} MB`);
} finally {
  try { await browser?.close(); } catch { /* already closed */ }
  server?.child.kill();
  if (process.env.KEEP_FRAMES) console.log(`frames kept in ${FRAMES}`);
  else fs.rmSync(FRAMES, { recursive: true, force: true });
}
