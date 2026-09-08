/* ==========================================================================
   Drives the whole experience the way a visitor does, and asserts what the
   surfaces should be saying at each step. Run with the repo served on :4180.

       node experience/verify.mjs
   ========================================================================== */
import { chromium } from '@playwright/test';

const URL = process.env.EXPERIENCE_URL ?? 'http://localhost:4180/experience/';
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const attr = (s, a) => page.getAttribute(s, a).catch(() => null);
const text = (s) => page.locator(s).first().textContent().catch(() => null);
const unscaled = (sel) => page.evaluate((s) => {
  const e = document.querySelector(s); if (!e) return null;
  const k = parseFloat(getComputedStyle(document.querySelector('.machine-fit')).transform.split('(')[1]) || 1;
  const r = e.getBoundingClientRect();
  return { w: +(r.width / k).toFixed(1), h: +(r.height / k).toFixed(1) };
}, sel);

// ── At rest ────────────────────────────────────────────────────────────────
const idle = await unscaled('.u-notch');
ok(idle && idle.h === 34, `idle notch is ${idle?.h}pt tall, want 34 (the measured bar)`);

// The mass's middle must sit exactly over the camera housing, or the whole
// illusion collapses.
const drift = await page.evaluate(() => {
  const mid = document.querySelector('.u-bar-mid'), cut = document.querySelector('.housing');
  if (!mid || !cut) return null;
  const a = mid.getBoundingClientRect(), b = cut.getBoundingClientRect();
  return Math.abs(a.left - b.left) + Math.abs(a.right - b.right);
});
ok(drift !== null && drift < 1, `the mass's middle is ${drift?.toFixed(2)}px off the camera housing`);

// ── Dictation ──────────────────────────────────────────────────────────────
await page.keyboard.down('f');
await page.waitForTimeout(1500);
ok(await attr('.u-pill', 'data-phase') === 'recording', 'holding the key did not open a recording pill');
ok((await unscaled('.u-pill'))?.h === 36, 'the pill is not 36pt tall (PillMetrics.height)');
ok(await page.locator('.doc .landing').count() === 1, 'no words landed at the cursor while speaking');
const partial = (await text('.doc .landing'))?.trim() ?? '';
ok(partial.split(/\s+/).length >= 3, `only "${partial}" landed in 1.5s — the schedule is not running`);

await page.keyboard.up('f');
await page.waitForTimeout(300);
ok(await attr('.u-pill', 'data-phase') === 'processing', 'release did not go to processing');
await page.waitForTimeout(700);
ok(await attr('.u-pill', 'data-phase') === 'output', 'processing did not resolve to the silent tick');
await page.waitForTimeout(1300);
ok(await page.locator('.u-pill').count() === 0, 'the pill did not go away after success');

// A tap, rather than a hold, is nothing: too short, and no call was made.
await page.keyboard.down('f'); await page.waitForTimeout(120); await page.keyboard.up('f');
await page.waitForTimeout(250);
ok(await attr('.u-pill', 'data-phase') === 'too-short', 'a 120ms hold should be "Didn\'t catch that"');
await page.waitForTimeout(1500);

// ── The formatter ──────────────────────────────────────────────────────────
const before = (await text('.doc p'))?.trim();
await page.keyboard.down('CapsLock'); await page.waitForTimeout(1200);
ok(await attr('.u-pill', 'data-phase') === 'recording', 'Caps Lock did not open a capture');
const tint = await page.evaluate(() => document.querySelector('.u-pill')?.hasAttribute('data-tint'));
ok(tint === true, 'the formatter lane is not tinted — it must not look like plain dictation');
await page.keyboard.up('CapsLock'); await page.waitForTimeout(1100);
const after = (await text('.doc p'))?.trim();
ok(before !== after, 'the formatter did not rewrite the text in place');
await page.waitForTimeout(1200);

// ── Remote: the notch ladder ───────────────────────────────────────────────
await page.keyboard.down('AltRight'); await page.waitForTimeout(900);
ok(await page.locator('.u-agent-control').count() === 1, 'a Remote capture must carry the agent control');
ok(await page.locator('.u-remote-glyph').count() === 1, 'a Remote capture swaps the dot for its glyph');
await page.keyboard.up('AltRight'); await page.waitForTimeout(700);
ok((await text('.u-bar-status'))?.trim() === 'Sending', 'the router step is not announced at bar level');
await page.waitForTimeout(1400);
ok((await text('.u-bar-status'))?.trim() === 'Working', 'the notch did not go to Working');
ok(await attr('.u-notch', 'data-state') === 'active', 'notch state should be active');
await page.waitForTimeout(5600);
ok(await attr('.u-notch', 'data-state') === 'attention', 'the notch never asked for you');
ok((await text('.u-bar-status'))?.trim() === 'Needs you', 'attention should read "Needs you"');
ok((await text('.u-bar-detail'))?.includes('marketing pages'), 'the question is not in the bar');

// ── Expanding ──────────────────────────────────────────────────────────────
await page.locator('.u-notch').click({ force: true });
await page.waitForTimeout(500);
ok(await attr('#panel', 'data-open') === 'true', 'clicking an asking notch did not expand it');
ok(await page.locator('[data-answer]').count() === 2, 'the question offers no choices');
ok(await page.locator('.u-user-bubble').count() === 1, 'the transcript is missing your own message');

await page.locator('[data-answer]').first().click();
await page.waitForTimeout(500);
ok(await attr('#panel', 'data-open') === 'false', 'answering did not collapse the surface');
ok((await text('.u-bar-status'))?.trim() === 'Working', 'after answering it should carry on working');
await page.waitForTimeout(3400);
ok(await attr('.u-notch', 'data-state') === 'idle', 'it never went quiet again');

// ── The cockpit ────────────────────────────────────────────────────────────
await page.locator('.u-notch').click({ force: true });
await page.waitForTimeout(500);
ok(await page.locator('.u-wall').count() === 1, 'clicking an idle notch should open the Orchestrator');
ok(await page.locator('.u-card').count() >= 4, 'the wall has no cards');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok(await attr('#panel', 'data-open') === 'false', 'Escape did not close the surface');

// ── The meeting notetaker ──────────────────────────────────────────────────
await page.keyboard.press('ControlLeft');
await page.waitForTimeout(150);
ok(await page.locator('.u-nt').count() === 0, 'one press of left ⌃ must not start a meeting');
await page.keyboard.press('ControlLeft');
await page.waitForTimeout(300);
ok(await attr('.u-nt', 'data-state') === 'idle', 'left ⌃ twice did not start the notetaker');
await page.locator('.u-nt').click();
await page.waitForTimeout(300);
ok(await attr('.u-nt', 'data-state') === 'discard', 'tapping the widget did not reveal the actions');
await page.locator('[data-action="end"]').click();
await page.waitForTimeout(300);
ok(await attr('.u-nt', 'data-state') === 'completed', 'End did not acknowledge');

ok(errors.length === 0, `console errors:\n    ${errors.join('\n    ')}`);
await browser.close();

if (fails.length) {
  console.error(`\n✗ ${fails.length} check(s) failed\n`);
  for (const f of fails) console.error('  • ' + f);
  process.exit(1);
}
console.log('✓ the whole flow runs: dictate → format → hand off → routing → working → needs you → answer → cockpit → meeting');
