// THE APPS — faithful, hand-built replicas of the tools people already use,
// all inside one made-up company, Orbit, so every demo is the same believable
// workday. People and the product (a subscription checkout) are consistent
// across every scene.
import { LOGO } from './kit.js'

export const PEOPLE = {
  maya: { name: 'Maya Chen', role: 'Support', c: '#e8a87c', i: 'MC' },
  dev: { name: 'Dev Patel', role: 'Backend', c: '#6c8ebf', i: 'DP' },
  sam: { name: 'Sam Rivera', role: 'Design', c: '#b38bd6', i: 'SR' },
  priya: { name: 'Priya Nair', role: 'Product', c: '#5fb49c', i: 'PN' },
  you: { name: 'Alex Kim', role: 'Engineering', c: '#e07a7a', i: 'AK' },
  jon: { name: 'Jon Okafor', role: 'Frontend', c: '#d8b45a', i: 'JO' },
}
const av = (p, cls = '') => `<span class="av ${cls}" style="background:${PEOPLE[p].c}">${PEOPLE[p].i}</span>`
export { av }
const lights = '<div class="lights"><i></i><i></i><i></i></div>'

// ── Slack ────────────────────────────────────────────────────────────────────
export function slack({ channel = 'bugs', thread = false } = {}) {
  const ch = (n, on, bold) => `<p class="${on ? 'on' : ''}${bold ? ' b' : ''}"><i>#</i>${n}</p>`
  return `${lights}<div class="sk">
    <nav class="sk-rail"><span class="ws">O</span><span class="ri on"><b>⌂</b><small>Home</small></span><span class="ri"><b>✉</b><small>DMs</small></span><span class="ri"><b>🔔</b><small>Activity</small></span><span class="ri"><b>⋯</b><small>More</small></span><span class="me">${av('you')}</span></nav>
    <aside class="sk-side"><div class="sk-ws">Orbit <i>⌄</i><span class="new">✎</span></div>
      <div class="sk-grp">Channels</div>${ch('announcements')}${ch('bugs', channel === 'bugs', false)}${ch('eng', channel === 'eng', true)}${ch('launch', channel === 'launch', true)}${ch('support')}${ch('design')}
      <div class="sk-grp">Direct messages</div><p class="dm">${av('maya', 'xs')}Maya Chen</p><p class="dm b">${av('dev', 'xs')}Dev Patel</p><p class="dm">${av('priya', 'xs')}Priya Nair</p>
      <div class="sk-grp">Apps</div><p class="dm"><span class="app-i">un</span>Unmute</p></aside>
    <main class="sk-main"><header class="sk-head"><b># ${channel}</b><span class="mem">${av('maya', 'xs')}${av('dev', 'xs')}${av('jon', 'xs')} 18</span></header>
      <div class="sk-msgs"></div>
      <div class="sk-comp"><div class="tools">B&nbsp; I&nbsp; S&nbsp; 🔗&nbsp; ≡&nbsp; ⟨/⟩</div><div class="ph">Message #${channel}</div><div class="foot">＋&nbsp; Aa&nbsp; ☺&nbsp; @ <i>➤</i></div></div></main>
    ${thread ? '<aside class="sk-thread"><header><b>Thread</b><small># ' + channel + '</small><i>✕</i></header><div class="th-body"></div><div class="sk-comp small"><div class="ph">Reply…</div></div></aside>' : ''}
  </div>`
}
export function skMsg(p, time, html, extra = '') {
  return `<div class="sk-m">${av(p)}<div><div class="mh"><b>${PEOPLE[p].name}</b><small>${time}</small></div><div class="mt">${html}</div>${extra}</div></div>`
}
export const skReplies = (n, ps, last) => `<div class="rp">${ps.map((p) => av(p, 'xxs')).join('')}<b>${n} ${n === 1 ? 'reply' : 'replies'}</b><small>${last}</small></div>`
export const skReact = (list) => `<div class="rx">${list.map(([e, n, me]) => `<span class="${me ? 'me' : ''}">${e} ${n}</span>`).join('')}</div>`

// ── Linear ───────────────────────────────────────────────────────────────────
export function linear() {
  const row = (id, title, st, pri, who, lbl, sel) => `<div class="ln-row${sel ? ' sel' : ''}" data-id="${id}"><span class="pri p${pri}"><i></i><i></i><i></i></span><span class="id">${id}</span><span class="stc ${st}"></span><span class="tt">${title}</span>${lbl ? `<span class="lb" style="--c:${lbl[1]}">${lbl[0]}</span>` : ''}<span class="dt">Oct 17</span>${av(who, 'xs')}</div>`
  return `${lights}<div class="ln">
    <aside class="ln-side"><div class="ln-ws"><span class="lg">O</span>Orbit <i>⌄</i></div><p>Inbox <b>3</b></p><p>My issues</p><div class="ln-grp">Workspace</div><p>Projects</p><p>Views</p><div class="ln-grp">Your teams</div><p class="t">▾ Engineering</p><p class="in on">Issues</p><p class="in">Cycles</p><p class="in">Projects</p></aside>
    <main class="ln-main"><header><b>Engineering</b><span class="tab on">All issues</span><span class="tab">Active</span><span class="tab">Backlog</span><span class="flt">Filter · Display</span></header>
      <div class="ln-g"><span class="stc progress"></span>In Progress <small>2</small></div>
      ${row('ORB-409', 'Migrate invoices table to new schema', 'progress', 3, 'dev', ['Backend', '#6c8ebf'])}
      ${row('ORB-412', 'Onboarding: add OAuth sign-in', 'progress', 2, 'jon', ['Frontend', '#d8b45a'])}
      <div class="ln-g"><span class="stc todo"></span>Todo <small>4</small></div>
      ${row('ORB-415', 'CSV export for invoices', 'todo', 2, 'you', ['Feature', '#5fb49c'])}
      ${row('ORB-418', 'Rate limit the public API', 'todo', 1, 'you', ['Backend', '#6c8ebf'], true)}
      ${row('ORB-421', 'Pricing page: annual toggle', 'todo', 3, 'sam', ['Design', '#b38bd6'])}
      ${row('ORB-423', 'Flaky test: checkout.e2e › applies coupon', 'todo', 2, 'dev', ['Bug', '#e07a7a'])}
      <div class="ln-g"><span class="stc backlog"></span>Backlog <small>12</small></div>
      ${row('ORB-430', 'Dark mode for the dashboard', 'backlog', 4, 'sam')}
    </main>
    <aside class="ln-det"><small>ORB-418</small><h3>Rate limit the public API</h3><p>Customers hammering <code>/v1/invoices</code> are slowing everyone down. Limit to <b>100 requests / minute per API key</b>, return <code>429</code> with <code>Retry-After</code>.</p>
      <div class="kv"><span>Status</span><b><span class="stc todo"></span>Todo</b></div><div class="kv"><span>Priority</span><b>Urgent</b></div><div class="kv"><span>Assignee</span><b>${av('you', 'xs')}Alex Kim</b></div><div class="kv"><span>Cycle</span><b>Cycle 14</b></div></aside>
  </div>`
}

// ── Figma ────────────────────────────────────────────────────────────────────
export function figma() {
  const card = (n, p, feats, hi) => `<div class="fg-card${hi ? ' hi' : ''}"><small>${n}</small><b>${p}<i>/mo</i></b>${feats.map((f) => `<p>✓ ${f}</p>`).join('')}<span class="cta">${hi ? 'Start free trial' : 'Get started'}</span></div>`
  return `${lights}<div class="fg">
    <header class="fg-top"><span class="fg-logo"><img src="${LOGO.figma}" alt=""></span><span class="tool on">▸</span><span class="tool">#</span><span class="tool">▢</span><span class="tool">✎</span><span class="tool">T</span><span class="fg-file">Orbit / <b>Pricing v3</b></span><span class="fg-av">${av('sam', 'xs')}${av('you', 'xs')}</span><span class="share">Share</span></header>
    <aside class="fg-layers"><small>Layers</small><p class="on">▾ ▢ Pricing — Desktop</p><p class="in">▸ ▢ Header</p><p class="in">▸ ▢ Plans</p><p class="in">▸ ▢ FAQ</p><p>▸ ▢ Pricing — Mobile</p><p>▸ ▢ Checkout</p></aside>
    <main class="fg-canvas"><span class="fg-label">Pricing — Desktop</span><div class="fg-frame">
      <div class="fg-nav"><b>orbit</b><span>Product</span><span>Pricing</span><span>Docs</span><i>Sign in</i></div>
      <h4>Simple pricing that grows with you</h4><div class="fg-toggle"><span class="on">Monthly</span><span>Annual · save 20%</span></div>
      <div class="fg-cards">${card('Starter', '$0', ['1 project', 'Basic analytics', 'Email support'])}${card('Growth', '$29', ['Unlimited projects', 'Advanced analytics', 'Priority support'], true)}${card('Scale', '$99', ['SSO & audit log', 'Custom limits', 'Dedicated manager'])}</div>
    </div></main>
    <aside class="fg-props"><small>Frame</small><div class="pr"><span>W</span>1440<span>H</span>1024</div><small>Auto layout</small><div class="pr"><span>Gap</span>24<span>Pad</span>64</div><small>Fill</small><div class="pr"><i class="sw"></i>FFFFFF</div><small>Export</small><div class="pr">PNG · 2x</div></aside>
  </div>`
}

// ── Chrome (wraps GitHub, Gmail, docs) ───────────────────────────────────────
export function chrome({ tabs, url, body }) {
  return `${lights}<div class="cr"><div class="cr-tabs">${tabs.map(([icon, t, on]) => `<span class="cr-tab${on ? ' on' : ''}"><img src="${icon}" alt="">${t}<i>✕</i></span>`).join('')}<span class="cr-new">＋</span></div>
    <div class="cr-bar"><span class="nav">‹ › ↻</span><span class="omni"><i>🔒</i>${url}</span><span class="ext">${av('you', 'xs')}</span></div><div class="cr-page">${body}</div></div>`
}

export function github() {
  const ln = (n, t, k = '') => `<div class="gh-l ${k}"><span>${n}</span><code>${t}</code></div>`
  return chrome({ tabs: [[LOGO.github, 'Add OAuth sign-in to onboarding by jono · #807', true], [LOGO.linear, 'ORB-412 Onboarding: add OAuth…']], url: 'github.com/orbit/web/pull/807/files', body: `<div class="gh">
    <header class="gh-top"><img src="${LOGO.github}" alt=""><b>orbit / web</b><span>Code</span><span class="on">Pull requests <i>9</i></span><span>Actions</span></header>
    <div class="gh-title"><h3>Add OAuth sign-in to onboarding <span>#807</span></h3><p><span class="open">⇅ Open</span> <b>jono</b> wants to merge 6 commits into <code>main</code> from <code>jono/oauth-onboarding</code></p></div>
    <div class="gh-tabs"><span>Conversation <i>4</i></span><span>Commits <i>6</i></span><span>Checks <i>3</i></span><span class="on">Files changed <i>5</i></span><b class="add">+184</b><b class="del">−37</b></div>
    <div class="gh-file"><div class="gh-fh">▾ <code>src/onboarding/OAuthStep.tsx</code><span>+64 −12</span></div>
      ${ln(41, 'export async function finishOAuth(code: string) {')}${ln(42, "  const res = await fetch('/api/oauth/token', {", 'add')}${ln(43, "    method: 'POST', body: JSON.stringify({ code }),", 'add')}${ln(44, '  })', 'add')}${ln(45, '  const { token } = await res.json()', 'add')}${ln(46, '  localStorage.setItem("session", token)', 'add')}
      <div class="gh-cm">${av('you', 'xs')}<div><b>Alex Kim</b><p>We already have <code>exchangeAuthCode()</code> in <code>lib/auth</code> — it handles refresh and errors. Should reuse that here.</p></div></div>
      ${ln(47, '  return token')}${ln(48, '}')}</div></div>` })
}

export function gmail() {
  const row = (who, subj, snip, time, unread, sel) => `<div class="gm-r${unread ? ' u' : ''}${sel ? ' sel' : ''}"><i class="cb"></i><i class="star">☆</i><b>${who}</b><span><b>${subj}</b> — ${snip}</span><small>${time}</small></div>`
  return chrome({ tabs: [[LOGO.gmail, 'Inbox (3) - support@orbit.dev - Orbit Mail', true], [LOGO.slack, 'Slack | support | Orbit']], url: 'mail.google.com/mail/u/0/#inbox', body: `<div class="gm">
    <aside class="gm-side"><div class="gm-logo"><img src="${LOGO.gmail}" alt=""><span>Gmail</span></div><span class="compose">✎ Compose</span><p class="on">Inbox <b>3</b></p><p>Starred</p><p>Snoozed</p><p>Sent</p><p>Drafts</p><p>Refunds <b>3</b></p></aside>
    <main class="gm-list"><div class="gm-search">🔍 Search mail</div><div class="gm-tabs"><span class="on">Primary</span><span>Promotions</span><span>Updates</span></div>
      ${row('Lena Fischer', 'Refund for duplicate charge', 'Hi, I was charged twice for October…', '10:31', true, true)}
      ${row('Tom Becker', 'Cancel and refund annual plan', 'We switched tools last week and would like…', '9:58', true, true)}
      ${row('Ana Ruiz', 'Refund request — invoice #4471', 'The upgrade went through by mistake…', '9:12', true, true)}
      ${row('Stripe', 'Your weekly payout summary', '€12,480.00 will arrive in your account…', 'Oct 16')}
      ${row('Priya Nair', 'Q4 pricing review notes', 'Attaching the notes from today’s call…', 'Oct 16')}
      ${row('Linear', 'ORB-418 was assigned to you', 'Rate limit the public API…', 'Oct 16')}
    </main></div>` })
}

export function docs() {
  return chrome({ tabs: [['assets/logos/chrome-color.svg', 'Tax calculation | Payments API docs', true], [LOGO.github, 'orbit/web · Checkout']], url: 'docs.payments.dev/tax/calculate', body: `<div class="dc">
    <aside class="dc-side"><b>Payments API</b><p>Getting started</p><p>Checkout</p><p class="g">Tax</p><p class="on">Calculate tax</p><p>Tax IDs</p><p>Reporting</p><p>Webhooks</p></aside>
    <main class="dc-main"><small>TAX</small><h2>Calculate tax at checkout</h2><p>Add the customer's address to a checkout session and the API returns the correct VAT, GST or sales tax for their location. Prices can be tax-inclusive or exclusive.</p>
      <h4>1. Enable automatic tax</h4><pre><span class="k">const</span> session = <span class="k">await</span> payments.checkout.create({
  line_items: items,
  <span class="h">automatic_tax: { enabled: <span class="k">true</span> },</span>
  customer_update: { address: <span class="s">'auto'</span> },
})</pre><h4>2. Collect the billing address</h4><p>Ask for the country and postal code before showing the total…</p></main></div>` })
}

// ── Terminal · Claude Code ───────────────────────────────────────────────────
// The usual way: switch to the terminal, find the session, type it all out.
export function terminal() {
  return `${lights}<div class="tm"><header class="tm-h">orbit — claude — 112×34</header><div class="tm-b">
    <div class="cc-box"><b><i>✻</i> Welcome to Claude Code</b><small>/help for help, /status for your current setup</small><small>cwd: /Users/alex/orbit</small></div>
    <p class="cc-dim">&gt; Add CSV export for invoices</p>
    <p class="cc-out"><i>⏺</i> Added <b>exportInvoicesCsv()</b> and a download button on the invoices page.</p>
    <div class="cc-in"><span class="pr">&gt;</span><span class="tx"></span><i class="caret"></i></div>
    <p class="cc-hint">? for shortcuts</p></div></div>`
}
