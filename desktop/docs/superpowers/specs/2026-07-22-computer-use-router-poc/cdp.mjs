// Minimal dependency-free CDP client (Node >=22 built-in WebSocket).
//   node cdp.mjs <titleMatch> eval  "<js expression>"
//   node cdp.mjs <titleMatch> shot  <out.png>
// Drives an Electron renderer directly — Space/focus/compositor independent.
const [,, titleMatch, cmd, arg] = process.argv;
const PORT = process.env.CDP_PORT || 9222;

const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
// match by title, by target id, or by ws-url substring (id follows in-tab navigation)
const t = list.find(x => x.type === 'page' && (
  (x.title || '').includes(titleMatch) || x.id === titleMatch || (x.webSocketDebuggerUrl || '').includes(titleMatch)
));
if (!t) { console.error('no page target matching', JSON.stringify(titleMatch), '\navailable:', list.filter(x=>x.type==='page').map(x=>x.title)); process.exit(2); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });

await new Promise(r => ws.addEventListener('open', r));

const SCROLLER_JS = `(() => {
  const cs = [...document.querySelectorAll("*")].filter(e => {
    const s = getComputedStyle(e);
    return /auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 40;
  });
  cs.sort((a, b) => b.scrollHeight - a.scrollHeight);
  return cs[0] || null;
})()`;

if (cmd === 'scroll') {
  // arg: "bottom" | "top" | signed integer pixel delta
  const expr = `(() => {
    const s = ${SCROLLER_JS};
    if (!s) return "NO_SCROLLER";
    const before = s.scrollTop;
    const target = ${JSON.stringify(arg)};
    if (target === "bottom") s.scrollTop = s.scrollHeight;
    else if (target === "top") s.scrollTop = 0;
    else s.scrollTop = before + parseInt(target, 10);
    return { cls: (s.className || "").slice(0, 50), before, after: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, atBottom: s.scrollTop + s.clientHeight >= s.scrollHeight - 2 };
  })()`;
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(JSON.stringify(res.result?.result?.value, null, 2));
} else if (cmd === 'clicktext') {
  // click the link/block whose visible text best matches arg (Notion SPA nav)
  const expr = `(() => {
    const want = ${JSON.stringify(arg)};
    const els = [...document.querySelectorAll('a, [role="link"], .notion-page-block, [data-block-id]')];
    let best = null, bestLen = 1e9;
    for (const e of els) {
      const txt = (e.textContent || '').trim();
      if (txt.includes(want) && txt.length < bestLen) { best = e; bestLen = txt.length; }
    }
    if (!best) return "NO_MATCH";
    const a = best.closest('a') || best.querySelector('a') || best;
    a.scrollIntoView({block:'center'});
    a.click();
    return { clicked: (best.textContent||'').trim().slice(0,60) };
  })()`;
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(JSON.stringify(res.result?.result?.value, null, 2));
} else if (cmd === 'focusend') {
  // focus the LAST editable block and place the caret at its end
  const expr = `(() => {
    const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(e => e.offsetParent !== null);
    const el = eds[eds.length - 1];
    if (!el) return "NO_EDITABLE";
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    return { focused: (el.textContent||'').trim().slice(-50), count: eds.length };
  })()`;
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(JSON.stringify(res.result?.result?.value, null, 2));
} else if (cmd === 'key') {
  // arg: a key name understood by CDP (Enter, Backspace, ArrowDown, ...)
  const keyMap = { Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' } };
  const k = keyMap[arg] || { key: arg, code: arg };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
  if (k.text) await send('Input.dispatchKeyEvent', { type: 'char', ...k });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  console.log('key', arg);
} else if (cmd === 'type') {
  // insert text at the current selection (into the focused contenteditable)
  await send('Input.insertText', { text: arg });
  console.log('typed', JSON.stringify(arg.slice(0, 60)));
} else if (cmd === 'typekeys') {
  // real per-character keyboard events — durable for editors (Notion/Lexical/Slate)
  // that discard one-shot Input.insertText. Re-focuses the last block first.
  const focus = `(() => {
    const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(e => e.offsetParent !== null);
    const el = eds[eds.length - 1]; if (!el) return false;
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return true;
  })()`;
  await send('Runtime.evaluate', { expression: focus, returnByValue: true });
  for (const ch of arg) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
  console.log('typekeys', arg.length, 'chars');
} else if (cmd === 'eval') {
  const res = await send('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) { console.error('JS ERROR:', JSON.stringify(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails)); process.exit(3); }
  console.log(JSON.stringify(res.result?.result?.value ?? res.result?.result, null, 2));
} else if (cmd === 'shot') {
  await send('Page.enable');
  const res = await send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(arg, Buffer.from(res.result.data, 'base64'));
  console.log('wrote', arg);
} else {
  console.error('unknown cmd', cmd); process.exit(64);
}
ws.close();
process.exit(0);
