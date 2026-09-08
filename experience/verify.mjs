/* Drives the guided tour the way a visitor does and asserts each step. */
import { chromium } from '@playwright/test';
const URL = process.env.EXPERIENCE_URL ?? 'http://localhost:4180/experience/';
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1680, height: 1050 } });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(URL, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);

const stepNo = async () => (await p.locator('#guide-step').textContent()).match(/\d+/)?.[0];
const cap = (k) => p.locator(`.keycap[data-key="${k}"]`);
const atStep = async (n, what) =>
  ok(await stepNo() === String(n), `expected step ${n} (${what}), got "${await p.locator('#guide-step').textContent()}"`);

// ── The page ───────────────────────────────────────────────────────────────
ok(await p.locator('.feature').count() === 3, 'the three features are not all there');
ok(await p.locator('.machine').count() === 1, 'no machine');
const k = parseFloat(await p.evaluate(() =>
  getComputedStyle(document.querySelector('.machine-fit')).getPropertyValue('--k')));
ok(k > 0.6, `the machine is scaled to ${k} — too small to read`);

// The mass's middle must sit on the camera housing, or the illusion collapses.
const drift = await p.evaluate(() => {
  const mid = document.querySelector('.u-bar-mid'), cut = document.querySelector('.housing');
  if (!mid || !cut) return null;
  const a = mid.getBoundingClientRect(), b = cut.getBoundingClientRect();
  return Math.abs(a.left - b.left) + Math.abs(a.right - b.right);
});
ok(drift !== null && drift < 1.5, `the mass's middle is ${drift?.toFixed(2)}px off the housing`);
ok(await stepNo() === '1', 'the tour did not start at step 1');
ok(await cap('fn').getAttribute('data-next') !== null, 'step 1 does not point at the Fn cap');

// ── 1–2 · dictation, press to start and press again to finish ──────────────
await cap('fn').click(); await p.waitForTimeout(400);
await atStep(2, 'speaking');
ok(await p.getAttribute('.u-pill', 'data-phase') === 'recording', 'no recording pill');
await p.waitForTimeout(4200);
ok(await p.locator('.doc .shot').count() === 1, 'the screenshot never joined the sentence');
await cap('fn').click();
await p.waitForFunction(() => document.querySelector('#guide-step').textContent.includes('3'), null, { timeout: 8000 });
ok(await p.locator('.doc p').count() >= 1, 'nothing landed in the document');
ok((await p.locator('.doc').textContent()).includes('Screenshot'), 'the attachment did not land with the words');

// ── 3 · the formatter ──────────────────────────────────────────────────────
await cap('caps').click(); await p.waitForTimeout(400);
ok(await p.evaluate(() => document.querySelector('.u-pill')?.hasAttribute('data-tint')),
   'the formatter lane must not look like plain dictation');
await cap('caps').click();
await p.waitForFunction(() => document.querySelector('#guide-step').textContent.includes('4'), null, { timeout: 8000 });

// ── 4 · hand off ───────────────────────────────────────────────────────────
await cap('ropt').click(); await p.waitForTimeout(400);
ok(await p.locator('.u-agent-control').count() === 1, 'a Remote capture must carry the agent control');
ok(await p.locator('.u-remote-glyph').count() === 1, 'a Remote capture swaps the dot for its glyph');
await cap('ropt').click();
await p.waitForFunction(() => document.querySelector('#guide-step').textContent.includes('5'), null, { timeout: 25000 });
ok((await p.locator('.u-bar-status').textContent()).includes('waiting on you'),
   'the closed surface should be counting what is waiting');

// ── 5 · the pocket ─────────────────────────────────────────────────────────
await cap('ropt').click(); await p.waitForTimeout(500);
await atStep(6, 'pocket open');
ok(await p.locator('.u-pocket-shoulders').count() === 1, 'the pocket needs its shoulder row');
ok(await p.locator('.u-pocket-pip').count() === 3, 'the slot rail should show every slot it holds');

// ── 6–7 · the task, then the dashboard ─────────────────────────────────────
await p.locator('.u-pocket').click({ position: { x: 120, y: 62 } });
await p.waitForTimeout(500); await atStep(7, 'task open');
ok(await p.locator('.u-user-bubble').count() === 1, 'the transcript is missing your own message');
await p.locator('.u-quiet-btn', { hasText: 'Open dashboard' }).click();
await p.waitForTimeout(600); await atStep(8, 'dashboard');
ok(await p.locator('.u-card').count() === 4, 'the wall is not showing its cards');

// ── 8–9 · put it away, bring it back ───────────────────────────────────────
await p.keyboard.press('Escape'); await p.waitForTimeout(500);
await atStep(9, 'closed');
ok(await p.getAttribute('#panel', 'data-open') === 'false', 'Escape did not close the surface');
await p.keyboard.down('Meta'); await p.keyboard.down('Alt');
await p.waitForTimeout(150);
await p.keyboard.up('Alt'); await p.keyboard.up('Meta');
await p.waitForTimeout(500); await atStep(10, 'reopened');
ok(await p.locator('.u-wall').count() === 1, '⌘⌥ did not bring the Orchestrator back');
await p.keyboard.press('Escape'); await p.waitForTimeout(300);

// ── 10–11 · the meeting ────────────────────────────────────────────────────
await cap('lctrl').click(); await p.waitForTimeout(120);
ok(await p.locator('.u-nt').count() === 0, 'one press of left ⌃ must not start a meeting');
await cap('lctrl').click(); await p.waitForTimeout(400);
await atStep(11, 'recording the room');
ok(await p.getAttribute('.u-nt', 'data-state') === 'idle', 'the notetaker did not start');
await cap('lctrl').click(); await p.waitForTimeout(120);
await cap('lctrl').click(); await p.waitForTimeout(400);
ok(await p.getAttribute('.u-nt', 'data-state') === 'completed', 'ending did not acknowledge');
ok((await p.locator('#guide-step').textContent()).includes('whole thing'), 'the tour never finished');

ok(errs.length === 0, `console errors:\n    ${errs.join('\n    ')}`);
await b.close();
if (fails.length) {
  console.error(`\n✗ ${fails.length} check(s) failed\n`);
  for (const f of fails) console.error('  • ' + f);
  process.exit(1);
}
console.log('✓ all 11 guided steps run, and the mass sits on the housing');
