#!/usr/bin/env node

// src/cli.ts
import { writeFileSync } from "node:fs";

// src/core.ts
var TASK_TYPES = ["code", "research", "comms", "content", "personal", "other"];
var DAY_MS = 864e5;
var MINUTE_MS = 6e4;
var MAX_LIVE_GAP_MS = 30 * MINUTE_MS;
var TAIL_MS = 10 * MINUTE_MS;
var BURST_WINDOW_MS = 6e4;
var BURST_MAX_NEIGHBOURS = 3;
var MACHINE_TEXT = /^\s*(#\s*AGENTS\.md|<[a-z_-]+>|\[Unmute created|Using ONLY|Run exactly|Call the probe|You are (cleaning|a |an |the )|AGENTS\.md)/i;
var AUTOMATION_CWD = ["/tmp/", "/private/tmp/", "/routine-sessions/", "/probe"];
var TASK_RULES = [
  ["content", /\b(tweet|twitter|x\.com|instagram|reel|linkedin|youtube|video|caption|thumbnail|followers|viral|post)\b/i],
  ["comms", /\b(email|gmail|inbox|whatsapp|slack|reply|dm|imessage|message|send)\b/i],
  ["code", /\b(code|bug|repo|build|deploy|test|function|api|commit|pr|branch|error|fix|implement|refactor|release|feature|css|server|typescript|python)\b/i],
  ["research", /\b(research|search|compare|analy[sz]e|explain|summari[sz]e|look up|investigate|what is|how does)\b/i],
  ["personal", /\b(flight|travel|passport|visa|calendar|meeting|book|buy|order|price|hotel|bank|doctor|exam|movie|trip)\b/i]
];
function isMachineText(text) {
  return MACHINE_TEXT.test(text);
}
function classifyTask(openingText) {
  for (const [type, rule] of TASK_RULES) if (rule.test(openingText)) return type;
  return "other";
}
function cleanSessions(input) {
  let machineOnly = 0;
  const withHuman = [];
  for (const s of input) {
    if (AUTOMATION_CWD.some((p) => s.cwd.includes(p))) {
      machineOnly++;
      continue;
    }
    const messages = s.messages.filter((m) => !isMachineText(m.text)).sort((a, b) => a.t - b.t);
    if (messages.length === 0) {
      machineOnly++;
      continue;
    }
    withHuman.push({ ...s, messages });
  }
  withHuman.sort((a, b) => a.messages[0].t - b.messages[0].t);
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  let duplicates = 0;
  for (const s of withHuman) {
    const key = s.messages[0].text.trim().slice(0, 200);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(s);
  }
  const starts = unique.map((s) => s.messages[0].t);
  const kept = [];
  let bursts = 0;
  for (let i = 0; i < unique.length; i++) {
    const t = starts[i];
    const neighbours = upperBound(starts, t + BURST_WINDOW_MS) - lowerBound(starts, t - BURST_WINDOW_MS);
    if (neighbours > BURST_MAX_NEIGHBOURS) {
      bursts++;
      continue;
    }
    kept.push(unique[i]);
  }
  return { sessions: kept, dropped: { machineOnly, duplicates, bursts } };
}
function computeMetrics(sessions, from, to) {
  const lo = startOfDay(from);
  const hi = startOfDay(to) + DAY_MS;
  const sessionsByDay = /* @__PURE__ */ new Map();
  const messagesByDay = /* @__PURE__ */ new Map();
  const hourSessions = /* @__PURE__ */ new Map();
  const minuteSessions = /* @__PURE__ */ new Map();
  const weekTypes = /* @__PURE__ */ new Map();
  const taskTypes = Object.fromEntries(TASK_TYPES.map((k) => [k, 0]));
  let sessionCount = 0;
  let messageCount = 0;
  for (const s of sessions) {
    const inWindow = s.messages.filter((m) => m.t >= lo && m.t < hi);
    if (inWindow.length === 0) continue;
    const startedHere = s.messages[0].t >= lo && s.messages[0].t < hi;
    if (startedHere) {
      sessionCount++;
      bump(sessionsByDay, dayKey(s.messages[0].t));
      const type = classifyTask(s.messages[0].text);
      taskTypes[type]++;
      const wk = weekKey(s.messages[0].t);
      if (!weekTypes.has(wk)) weekTypes.set(wk, /* @__PURE__ */ new Set());
      weekTypes.get(wk).add(type);
    }
    for (let i = 0; i < inWindow.length; i++) {
      const m = inWindow[i];
      messageCount++;
      bump(messagesByDay, dayKey(m.t));
      const hour = Math.floor(m.t / 36e5);
      if (!hourSessions.has(hour)) hourSessions.set(hour, /* @__PURE__ */ new Set());
      hourSessions.get(hour).add(s.id);
      const next = inWindow[i + 1]?.t;
      const end = next !== void 0 && next - m.t < MAX_LIVE_GAP_MS ? next : m.t + TAIL_MS;
      for (let min = Math.floor(m.t / MINUTE_MS); min * MINUTE_MS < end; min++) {
        if (!minuteSessions.has(min)) minuteSessions.set(min, /* @__PURE__ */ new Set());
        minuteSessions.get(min).add(s.id);
      }
    }
  }
  const activeDays = [.../* @__PURE__ */ new Set([...sessionsByDay.keys(), ...messagesByDay.keys()])].sort();
  const minutesByDay = /* @__PURE__ */ new Map();
  for (const min of minuteSessions.keys()) bump(minutesByDay, dayKey(min * MINUTE_MS));
  return {
    from,
    to,
    activeDays: activeDays.length,
    calendarDays: Math.round((hi - lo) / DAY_MS),
    sessions: sessionCount,
    messages: messageCount,
    spd: summarize(activeDays.map((d) => sessionsByDay.get(d) ?? 0)),
    mpd: summarize(activeDays.map((d) => messagesByDay.get(d) ?? 0)),
    ahd: summarize(activeDays.map((d) => (minutesByDay.get(d) ?? 0) / 60)),
    par: summarize([...minuteSessions.values()].map((v) => v.size)),
    jph: summarize([...hourSessions.values()].map((v) => v.size)),
    ttw: weekTypes.size ? mean([...weekTypes.values()].map((v) => v.size)) : 0,
    taskTypes
  };
}
function compare(sessions, before, after, permutations = 2e4) {
  const b = computeMetrics(sessions, before[0], before[1]);
  const a = computeMetrics(sessions, after[0], after[1]);
  const ratio = (x, y) => y > 0 ? round(x / y, 1) : null;
  const daily = (from, to) => dailyCounts(sessions, from, to);
  const db = daily(before[0], before[1]);
  const da = daily(after[0], after[1]);
  return {
    before: b,
    after: a,
    multiplier: {
      spd: ratio(a.spd.median, b.spd.median),
      mpd: ratio(a.mpd.median, b.mpd.median),
      ahd: ratio(a.ahd.median, b.ahd.median),
      jph: ratio(a.jph.median, b.jph.median)
    },
    pValue: {
      spd: permutationP(db.sessions, da.sessions, permutations),
      mpd: permutationP(db.messages, da.messages, permutations)
    }
  };
}
function firstUnmuteDay(sessions) {
  let first = Infinity;
  for (const s of sessions) if (s.source === "unmute" && s.messages.length) first = Math.min(first, s.messages[0].t);
  return Number.isFinite(first) ? dayKey(first) : null;
}
function dailyCounts(sessions, from, to) {
  const lo = startOfDay(from);
  const hi = startOfDay(to) + DAY_MS;
  const s = /* @__PURE__ */ new Map();
  const m = /* @__PURE__ */ new Map();
  for (const x of sessions) {
    if (x.messages[0].t >= lo && x.messages[0].t < hi) bump(s, dayKey(x.messages[0].t));
    for (const msg of x.messages) if (msg.t >= lo && msg.t < hi) bump(m, dayKey(msg.t));
  }
  const days = [.../* @__PURE__ */ new Set([...s.keys(), ...m.keys()])];
  return { sessions: days.map((d) => s.get(d) ?? 0), messages: days.map((d) => m.get(d) ?? 0) };
}
function permutationP(before, after, n) {
  if (!before.length || !after.length) return 1;
  const ranks = averageRanks([...before, ...after]);
  const sumAfter = (r) => r.slice(before.length).reduce((a, b) => a + b, 0);
  const observed = sumAfter(ranks);
  let rng = 795580989;
  const rand = () => {
    rng = rng + 1831565813 >>> 0;
    let x = Math.imul(rng ^ rng >>> 15, rng | 1);
    x ^= x + Math.imul(x ^ x >>> 7, x | 61);
    return ((x ^ x >>> 14) >>> 0) / 4294967296;
  };
  const pool = [...ranks];
  let hits = 0;
  for (let i = 0; i < n; i++) {
    for (let j = pool.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [pool[j], pool[k]] = [pool[k], pool[j]];
    }
    if (sumAfter(pool) >= observed - 1e-9) hits++;
  }
  return (hits + 1) / (n + 1);
}
function averageRanks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return ranks;
}
function summarize(values) {
  if (!values.length) return { median: 0, trimmedMean: 0, p90: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * 0.1);
  const trimmed = sorted.slice(cut, sorted.length - cut);
  return {
    median: round(median(sorted), 1),
    trimmedMean: round(mean(trimmed.length ? trimmed : sorted), 1),
    p90: round(sorted[Math.floor(0.9 * (sorted.length - 1))], 1)
  };
}
function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function round(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function weekKey(t) {
  const d = new Date(t);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7);
  return dayKey(monday.getTime());
}
function startOfDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}
function lowerBound(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function upperBound(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// src/sources.ts
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function readClaudeSessions(opts = {}) {
  const root = join(opts.home ?? homedir(), ".claude", "projects");
  const out = [];
  for (const project of safeReaddir(root)) {
    const dir = join(root, project);
    if (!isDir(dir)) continue;
    for (const file of safeReaddir(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const session = parseClaudeTranscript(readText(join(dir, file)), file.replace(/\.jsonl$/, ""));
      if (session) out.push(session);
    }
  }
  return out;
}
function parseClaudeTranscript(text, id) {
  let entrypoint;
  let cwd = "";
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const d = parseLine(line);
    if (!d || d.isSidechain) continue;
    entrypoint ??= typeof d.entrypoint === "string" ? d.entrypoint : void 0;
    if (!cwd && typeof d.cwd === "string") cwd = d.cwd;
    if (d.type !== "user" || d.isMeta || typeof d.timestamp !== "string") continue;
    const content = d.message?.content;
    let body = null;
    if (typeof content === "string") body = content;
    else if (Array.isArray(content)) {
      if (content.some((c) => c?.type === "tool_result")) continue;
      const texts = content.filter((c) => c?.type === "text").map((c) => c.text ?? "");
      if (texts.length) body = texts.join(" ");
    }
    if (body && body.trim()) messages.push({ t: Date.parse(d.timestamp), text: body.slice(0, 400) });
  }
  if (!messages.length) return null;
  return { id, provider: "claude", source: claudeSource(entrypoint), cwd, messages };
}
function claudeSource(entrypoint) {
  if (entrypoint === "cli") return "terminal";
  if (entrypoint === "claude-desktop") return "desktop-app";
  if (entrypoint === "sdk-cli" || entrypoint === "sdk-ts" || entrypoint === "sdk-py") return "sdk";
  return "other";
}
function readCodexSessions(opts = {}) {
  const home = opts.home ?? homedir();
  const files = [
    ...walk(join(home, ".codex", "sessions")),
    ...walk(join(home, ".codex", "archived_sessions"))
  ].filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.zst"));
  const haveZstd = files.some((f) => f.endsWith(".zst")) && spawnSync("zstd", ["--version"]).status === 0;
  const out = [];
  for (const file of files) {
    let text;
    if (file.endsWith(".zst")) {
      if (!haveZstd) continue;
      const r = spawnSync("zstd", ["-dc", file], { maxBuffer: 512 * 1024 * 1024 });
      if (r.status !== 0) continue;
      text = r.stdout.toString("utf8");
    } else text = readText(file);
    const session = parseCodexRollout(text, file);
    if (session) out.push(session);
  }
  return out;
}
function parseCodexRollout(text, fallbackId) {
  let id = fallbackId;
  let cwd = "";
  let originator = "";
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const d = parseLine(line);
    if (!d) continue;
    const p = d.payload ?? {};
    if (d.type === "session_meta") {
      if (typeof p.id === "string") id = p.id;
      if (typeof p.cwd === "string") cwd = p.cwd;
      if (typeof p.originator === "string") originator = p.originator;
      continue;
    }
    if (d.type === "event_msg" && p.type === "user_message" && typeof d.timestamp === "string") {
      const body = typeof p.message === "string" ? p.message : "";
      if (body.trim()) messages.push({ t: Date.parse(d.timestamp), text: body.slice(0, 400) });
    }
  }
  if (!messages.length) return null;
  const source = codexSource(originator);
  if (source === null) return null;
  return { id, provider: "codex", source, cwd, messages };
}
function codexSource(originator) {
  if (originator === "unmute" || originator === "unmute-agent") return "unmute";
  if (originator === "codex_exec" || originator === "probe") return null;
  if (originator === "codex-tui" || originator === "codex_cli_rs") return "terminal";
  if (originator === "Codex Desktop") return "desktop-app";
  return "other";
}
function readUnmuteIndex(opts = {}) {
  const dir = join(opts.home ?? homedir(), ".unmute", "remote", "session-index");
  return readUnmuteIndexFromText(readText(join(dir, "sessions.jsonl")), readText(join(dir, "turns.jsonl")));
}
function readUnmuteIndexFromText(sessionsText, turnsText) {
  if (!sessionsText || !turnsText) return [];
  const turns = /* @__PURE__ */ new Map();
  for (const line of turnsText.split("\n")) {
    const t = line ? parseLine(line) : null;
    if (!t || typeof t.s !== "string" || typeof t.t !== "number") continue;
    if (!turns.has(t.s)) turns.set(t.s, []);
    turns.get(t.s).push({ t: t.t, text: typeof t.text === "string" ? t.text.slice(0, 400) : "" });
  }
  const out = [];
  for (const line of sessionsText.split("\n")) {
    const r = line ? parseLine(line) : null;
    if (!r || typeof r.id !== "string") continue;
    if (r.provenance !== "main" || r.briefing) continue;
    const messages = turns.get(r.id);
    if (!messages?.length) continue;
    out.push({
      id: r.id,
      provider: r.provider === "codex" ? "codex" : "claude",
      // The index records every session on the Mac, not only Unmute's. Merge
      // it after the harness readers so their launch labels win.
      source: "other",
      cwd: typeof r.cwd === "string" ? r.cwd : "",
      messages: messages.sort((a, b) => a.t - b.t)
    });
  }
  return out;
}
function mergeSessions(...lists) {
  const byId = /* @__PURE__ */ new Map();
  for (const list of lists) for (const s of list) if (!byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()];
}
function parseLine(line) {
  try {
    const d = JSON.parse(line);
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function walk(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of safeReaddir(dir)) {
      const p = join(dir, name);
      if (isDir(p)) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

// src/cli.ts
var DAY_MS2 = 864e5;
function parseArgs(argv) {
  const args = { days: 30, json: false, index: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--split") args.split = argv[++i];
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--card") args.card = argv[++i];
    else if (a === "--no-index") args.index = false;
    else if (a === "-h" || a === "--help") args.help = true;
  }
  if (args.split && !/^\d{4}-\d{2}-\d{2}$/.test(args.split)) fail("--split must be YYYY-MM-DD");
  if (!Number.isFinite(args.days) || args.days < 7 || args.days > 90) fail("--days must be between 7 and 90");
  return args;
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const log = (s) => {
    if (!args.json) process.stderr.write(s);
  };
  log("Reading your local Claude Code and Codex logs\u2026\n");
  const raw = mergeSessions(readClaudeSessions(), readCodexSessions(), args.index ? readUnmuteIndex() : []);
  const { sessions, dropped } = cleanSessions(raw);
  if (!sessions.length) fail("No Claude Code or Codex sessions found in ~/.claude or ~/.codex.");
  const today = startOfDay2(dayKey(Date.now())) - DAY_MS2;
  const splitKey = args.split ?? firstUnmuteDay(sessions) ?? dayKey(today - (args.days - 1) * DAY_MS2);
  const split = startOfDay2(splitKey);
  const before = [dayKey(split - args.days * DAY_MS2), dayKey(split - DAY_MS2)];
  const after = [dayKey(Math.max(split, today - (args.days - 1) * DAY_MS2)), dayKey(today)];
  const result = compare(sessions, before, after);
  if (args.json) {
    process.stdout.write(JSON.stringify({ version: "0.1.0", split: splitKey, windows: { before, after }, dropped, sessionsRead: raw.length, ...result }, null, 2) + "\n");
  } else {
    process.stdout.write(report(result, splitKey, raw.length, dropped));
  }
  if (args.card) {
    writeFileSync(args.card, card(result));
    log(`
Share card written to ${args.card}
`);
  }
}
function report(r, split, read, dropped) {
  const b = r.before;
  const a = r.after;
  const row = (name, x, y, m) => `  ${name.padEnd(30)} ${String(x).padStart(7)}  \u2192  ${String(y).padStart(7)}   ${m === null ? "" : `${m}\xD7`}
`;
  const thin = (m) => m.activeDays < 5;
  let out = "\n  UNMUTE BENCH v0.1 \xB7 the benchmark that measures the human, not the model\n\n";
  out += `  ${"Median per active day".padEnd(30)} ${"before".padStart(7)}     ${"after".padStart(7)}
`;
  out += `  ${"".padEnd(30)} ${range(b).padStart(7)}     ${range(a).padStart(7)}
`;
  out += "  " + "\u2500".repeat(64) + "\n";
  out += row("SPD  agent sessions", b.spd.median, a.spd.median, r.multiplier.spd);
  out += row("MPD  messages to agents", b.mpd.median, a.mpd.median, r.multiplier.mpd);
  out += row("AHD  hours agents ran", b.ahd.median, a.ahd.median, r.multiplier.ahd);
  out += row("JPH  agents steered per hour", b.jph.median, a.jph.median, r.multiplier.jph);
  out += row("PAR  agents running at once", b.par.median, a.par.median, null);
  out += row("AD   active days", b.activeDays, a.activeDays, null);
  out += row("TTW  task types per week", round1(b.ttw), round1(a.ttw), null);
  out += "  " + "\u2500".repeat(64) + "\n";
  const p = Math.max(r.pValue.spd, r.pValue.mpd);
  out += `  ${p < 1e-3 ? "Statistically significant (p < 0.001)" : p < 0.05 ? `Statistically significant (p = ${p.toFixed(3)})` : `Not statistically significant (p = ${p.toFixed(2)})`}
`;
  out += `  Split date: ${split} \xB7 ${read} sessions read \xB7 removed ${dropped.bursts} bursts, ${dropped.duplicates} repeats, ${dropped.machineOnly} automated
`;
  if (thin(b) || thin(a)) out += "  Fewer than 5 active days on one side: treat this as a preview, not a result.\n";
  out += "\n  Method: justunmute.me/bench \xB7 Nothing left this machine.\n\n";
  return out;
}
function card(r) {
  const rows = [
    ["Agent sessions / day", r.before.spd.median, r.after.spd.median, r.multiplier.spd],
    ["Messages to agents / day", r.before.mpd.median, r.after.mpd.median, r.multiplier.mpd],
    ["Hours agents ran / day", r.before.ahd.median, r.after.ahd.median, r.multiplier.ahd]
  ];
  const barX = 420;
  const barMax = 560;
  let body = "";
  rows.forEach(([label, x, y, m], i) => {
    const top = 190 + i * 140;
    const max = Math.max(x, y, 1e-9);
    const wb = Math.max(x / max * barMax, 40);
    const wa = Math.max(y / max * barMax, 40);
    body += `<text x="72" y="${top + 38}" font-size="24" font-weight="600">${esc(label)}</text>`;
    body += `<rect x="${barX}" y="${top}" width="${wb}" height="34" rx="4" fill="#d9d9d9"/>`;
    body += `<text x="${barX + wb - 12}" y="${top + 24}" font-size="18" font-weight="600" text-anchor="end" fill="#333">${x}</text>`;
    body += `<rect x="${barX}" y="${top + 42}" width="${wa}" height="34" rx="4" fill="#0b0b0c"/>`;
    body += `<text x="${barX + wa - 12}" y="${top + 66}" font-size="18" font-weight="600" text-anchor="end" fill="#fff">${y}</text>`;
    if (m !== null) body += `<text x="1128" y="${top + 52}" font-size="40" font-weight="700" text-anchor="end">${m}\xD7</text>`;
  });
  const p = Math.max(r.pValue.spd, r.pValue.mpd);
  const sig = p < 1e-3 ? "p &lt; 0.001" : `p = ${p.toFixed(3)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" font-family="Inter, Helvetica, Arial, sans-serif" fill="#0b0b0c">
<rect width="1200" height="675" fill="#fff"/>
<text x="72" y="96" font-size="44" font-weight="700">My Unmute Bench</text>
<text x="72" y="134" font-size="20" fill="#555">The benchmark that measures the human, not the model.</text>
<rect x="760" y="74" width="16" height="16" rx="3" fill="#d9d9d9"/><text x="784" y="88" font-size="17" fill="#333">Before</text>
<rect x="870" y="74" width="16" height="16" rx="3" fill="#0b0b0c"/><text x="894" y="88" font-size="17" fill="#333">After</text>
${body}
<line x1="72" y1="612" x2="1128" y2="612" stroke="#ececec"/>
<text x="72" y="642" font-size="15" fill="#8a8a8a">Median per active day \xB7 ${r.before.from} \u2192 ${r.after.to} \xB7 ${sig} \xB7 from my own local logs</text>
<text x="1128" y="642" font-size="15" fill="#8a8a8a" text-anchor="end">justunmute.me/bench</text>
</svg>
`;
}
function range(m) {
  const f = (s) => (/* @__PURE__ */ new Date(`${s}T00:00:00`)).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${f(m.from)}\u2013${f(m.to)}`;
}
function round1(x) {
  return Math.round(x * 10) / 10;
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}
function startOfDay2(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}
function fail(msg) {
  process.stderr.write(`unmute-bench: ${msg}
`);
  process.exit(1);
}
var HELP = `unmute-bench v0.1 \u2014 the benchmark that measures the human, not the model

Usage: node unmute-bench.mjs [--split YYYY-MM-DD] [--days N] [--card file.svg] [--json] [--no-index]
   or: curl -fsSL https://justunmute.me/unmute-bench.mjs | node --input-type=module - [options]

  --split   first day of "after" (default: your first Unmute session, else ${30} days ago)
  --days    length of each window, 7\u201390 (default 30)
  --card    write a shareable 1200\xD7675 SVG card
  --json    print machine-readable results
  --no-index  ignore Unmute's session index even if present

Reads ~/.claude/projects and ~/.codex (zstd archives need the zstd binary).
Nothing is uploaded. Method: https://justunmute.me/bench
`;
main();
