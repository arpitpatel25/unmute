/* ==========================================================================
   Checks the replica against the numbers in the Swift/TSX sources.
   Every expectation below cites the constant it comes from, so a change in
   the app that this page has not followed shows up as a failure rather than
   as a drawing that merely looks about right.

   Run:  node replica/verify.mjs        (serve the repo root on :4180 first)
   ========================================================================== */
import { chromium } from '@playwright/test';

const URL = process.env.REPLICA_URL ?? 'http://localhost:4180/replica/index.html';
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const r = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { w: +b.width.toFixed(2), h: +b.height.toFixed(2) };
  };
  const css = (sel, prop) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el)[prop] : null;
  };

  // Does the mass's middle sit exactly over the camera housing, in every state?
  const drift = [];
  document.querySelectorAll('.u-notch-stage').forEach((st, i) => {
    const cut = st.querySelector('.u-cutout'), mid = st.querySelector('.u-bar-mid');
    if (!cut || !mid) return;
    const c = cut.getBoundingClientRect(), m = mid.getBoundingClientRect();
    const d = Math.abs(c.left - m.left) + Math.abs(c.right - m.right);
    if (d > 0.5) drift.push(`stage ${i}: ${d.toFixed(2)}px`);
  });

  // Is any label cut off by the half it lives in?
  const clipped = [];
  document.querySelectorAll('.u-bar-left, .u-bar-right').forEach((h) => {
    if (h.scrollWidth > h.clientWidth + 0.5) clipped.push(h.textContent.trim().slice(0, 32));
  });

  // Is any text box tighter than its own font (which slices descenders)?
  const tight = [];
  document.querySelectorAll('.u-bar-status, .u-bar-detail, .u-error-msg, .u-error-hint, ' +
    '.u-processing-label, .u-paused-label, .u-fallback-msg, .u-nt-saved').forEach((el) => {
    const cs = getComputedStyle(el);
    if (parseFloat(cs.lineHeight) < parseFloat(cs.fontSize) * 1.15)
      tight.push(el.className);
  });

  // Does anything escape its own capsule?
  const overflow = [];
  document.querySelectorAll('.u-pill, .u-nt, .u-offline, .u-hint').forEach((el) => {
    const p = el.getBoundingClientRect();
    el.querySelectorAll('*').forEach((c) => {
      const b = c.getBoundingClientRect();
      if (b.height && (b.bottom > p.bottom + 0.6 || b.top < p.top - 0.6))
        overflow.push(`${el.dataset.phase ?? el.className.split(' ')[0]} > ${c.className}`);
    });
  });

  return {
    pillRecording: box('.u-pill[data-phase="recording"]'),
    pillOutput: box('.u-pill[data-phase="output"]'),
    pillError: box('.u-pill[data-phase="error"]'),
    chip: box('.u-chip'),
    agent: box('.u-agent-control'),
    hint: box('.u-hint'),
    offline: box('.u-offline'),
    notetaker: box('.u-nt'),
    selectorRow: box('.u-selector-row'),
    wave: box('.u-wave'),
    ntWave: box('.u-nt-wave'),
    clusterGap: css('.u-cluster', 'gap'),
    columnGap: css('.u-pill-column', 'gap'),
    glassBorder: css('.u-glass', 'borderWidth'),
    drift, clipped, tight, overflow,
    specimens: document.querySelectorAll('.specimen').length,
  };
});

// PillMetrics.height — one height for every element in the cluster.
ok(r.pillRecording.h === 36, `pill height ${r.pillRecording.h}, want 36 (PillMetrics.height)`);
ok(r.pillError.h === 36, `error pill height ${r.pillError.h}, want 36`);
ok(r.chip.w === 36 && r.chip.h === 36, `chip ${r.chip.w}×${r.chip.h}, want 36×36 (square, so the capsule is a circle)`);
ok(r.agent.h === 36, `agent control height ${r.agent.h}, want 36`);
ok(r.offline.h === 36, `offline card height ${r.offline.h}, want 36`);
ok(r.notetaker.h === 36, `notetaker height ${r.notetaker.h}, want 36 (notetakerWidget.ts pillHeight)`);
// output — a square frame, so the tick sits in a circle.
ok(r.pillOutput.w === 36 && r.pillOutput.h === 36, `output pill ${r.pillOutput.w}×${r.pillOutput.h}, want 36×36`);
// The hint chip is the one deliberate exception: it sits above the cluster.
ok(r.hint.h === 34, `hint chip height ${r.hint.h}, want 34`);
ok(r.selectorRow.h === 32, `selector row height ${r.selectorRow.h}, want 32`);
// Waveform.swift: height 16, 7 dots of 3.5 on a 5pt gap = 54.5.
ok(r.wave.h === 16, `waveform band ${r.wave.h}, want 16`);
ok(r.wave.w === 54.5, `waveform width ${r.wave.w}, want 54.5 (7 × 3.5 + 6 × 5)`);
// NotetakerWidget.tsx: WAVE_WIDTH 55, 20 tall.
ok(r.ntWave.w === 55 && r.ntWave.h === 20, `notetaker wave ${r.ntWave.w}×${r.ntWave.h}, want 55×20`);
ok(r.clusterGap === '8px', `cluster gap ${r.clusterGap}, want 8px (HStack(spacing: 8))`);
ok(r.columnGap === '9px', `column gap ${r.columnGap}, want 9px (VStack(spacing: 9))`);
// strokeBorder insets by half a line, so the rim must not grow the box.
ok(r.glassBorder === '0px', `glass draws a real border (${r.glassBorder}); the rim must be inset`);

ok(r.drift.length === 0, `the mass's middle is off the camera housing:\n    ${r.drift.join('\n    ')}`);
ok(r.clipped.length === 0, `labels cut off by their half:\n    ${r.clipped.join('\n    ')}`);
ok(r.tight.length === 0, `text boxes tighter than their font (descenders sliced): ${r.tight.join(', ')}`);
ok(r.overflow.length === 0, `content escaping its capsule:\n    ${r.overflow.join('\n    ')}`);
ok(consoleErrors.length === 0, `console errors:\n    ${consoleErrors.join('\n    ')}`);

await browser.close();

if (fails.length) {
  console.error(`\n✗ ${fails.length} check(s) failed\n`);
  for (const f of fails) console.error('  • ' + f);
  process.exit(1);
}
console.log(`✓ all checks pass — ${r.specimens} specimens, geometry matches the source constants`);
