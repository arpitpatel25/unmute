import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const SOURCE_ROOT = "/Users/zodpatel/tools/unmute/unmute-cloud";
export const SOURCE_REVISION = "2c3c22bd4049b11b8f030b96069423a945571c12";

const TYPESCRIPT_SOURCE = /(?:pill|notetaker).*\.(?:ts|tsx)$/i;
const TEST_SOURCE = /\.(?:test|spec)\.(?:ts|tsx)$/i;
const METRIC_CONTEXT = /(?:frame|padding|spacing|cornerRadius|font|opacity|offset|width|height|size|radius|inset|duration|delay|lineLimit|minimumScaleFactor)/i;
const TOKEN_CONTEXT = /(?:Color\.|NSColor\.|foregroundStyle|foregroundColor|background|fill\(|stroke\(|Material|material\b|shadow\(|opacity\()/;
const SYMBOL_CALL = /(?:systemName|systemImage|systemSymbolName)\s*:\s*"([^"]+)"/g;
const DECLARATION = /\b(?:struct|class|enum|actor|protocol|extension|func|var|let|typealias)\s+([A-Za-z_$][\w$]*)/;

async function git(args) {
  const { stdout } = await execFile("git", ["-C", SOURCE_ROOT, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function occurrenceId(category, source, line, ordinal = 1) {
  return `${category}:${source}:${line}:${ordinal}`;
}

function addOccurrence(target, category, source, line, value, symbol, ordinal = 1) {
  target.push({
    id: occurrenceId(category, source, line, ordinal),
    source,
    line,
    symbol,
    value,
  });
}

function scanFile(source, text, report) {
  const lines = text.split("\n");
  let symbol = "file scope";
  const enumDepths = [];
  let braceDepth = 0;

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    const declaration = line.match(DECLARATION);
    if (declaration) symbol = declaration[1];

    const enumDeclaration = line.match(/\benum\s+([A-Za-z_$][\w$]*)/);
    if (enumDeclaration) enumDepths.push({ depth: braceDepth, symbol: enumDeclaration[1] });

    if (enumDepths.length && /^case\s+/.test(line)) {
      const enumSymbol = enumDepths.at(-1).symbol;
      const values = line
        .replace(/^case\s+/, "")
        .split(",")
        .map((value) => value.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1])
        .filter(Boolean);
      values.forEach((value, ordinal) =>
        addOccurrence(report.enumCases, "enum", source, lineNumber, value, enumSymbol, ordinal + 1),
      );
    }

    const branchPatterns = [
      ["else-if", /\belse\s+if\s+(.+)/],
      ["if", /(?:^|[};]\s*)if\s+(.+)/],
      ["guard", /\bguard\s+(.+)/],
      ["else", /^}\s*else(?:\s*{)?$/],
      ["switch-case", /^case\s+(.+?):(?:\s|$)/],
      ["switch-default", /^default\s*:/],
    ];
    let branchOrdinal = 0;
    for (const [kind, pattern] of branchPatterns) {
      const match = line.match(pattern);
      if (match) {
        branchOrdinal += 1;
        addOccurrence(
          report.branches,
          "branch",
          source,
          lineNumber,
          `${kind}: ${(match[1] ?? line).replace(/\s*\{\s*$/, "").trim()}`,
          symbol,
          branchOrdinal,
        );
        break;
      }
    }

    let symbolMatch;
    let symbolOrdinal = 0;
    while ((symbolMatch = SYMBOL_CALL.exec(rawLine)) !== null) {
      symbolOrdinal += 1;
      addOccurrence(
        report.sfSymbols,
        "sf-symbol",
        source,
        lineNumber,
        symbolMatch[1],
        symbol,
        symbolOrdinal,
      );
    }
    SYMBOL_CALL.lastIndex = 0;

    if (METRIC_CONTEXT.test(line)) {
      const literals = line.match(/(?<![\w.])-?\d+(?:\.\d+)?/g) ?? [];
      literals.forEach((value, ordinal) =>
        addOccurrence(report.metrics, "metric", source, lineNumber, value, symbol, ordinal + 1),
      );
    }

    if (TOKEN_CONTEXT.test(line)) {
      const tokens = line.match(/(?:Color|NSColor)\.[A-Za-z]+|\.(?:ultraThin|thin|regular|thick|ultraThick)Material|\.(?:primary|secondary|tertiary|quaternary)\b/g) ?? [];
      tokens.forEach((value, ordinal) =>
        addOccurrence(report.tokens, "token", source, lineNumber, value, symbol, ordinal + 1),
      );
    }

    const opens = (rawLine.match(/{/g) ?? []).length;
    const closes = (rawLine.match(/}/g) ?? []).length;
    braceDepth += opens - closes;
    while (enumDepths.length && braceDepth <= enumDepths.at(-1).depth) enumDepths.pop();
  });
}

export async function auditSource() {
  const listed = (await git(["ls-tree", "-r", "--name-only", SOURCE_REVISION]))
    .trim()
    .split("\n");
  const files = listed.filter(
    (source) =>
      (source.startsWith("desktop/native-notch/Sources/") && source.endsWith(".swift")) ||
      (TYPESCRIPT_SOURCE.test(source) && !TEST_SOURCE.test(source)),
  );
  const report = {
    sourceRevision: SOURCE_REVISION,
    files,
    enumCases: [],
    branches: [],
    sfSymbols: [],
    metrics: [],
    tokens: [],
  };

  for (const source of files) {
    scanFile(source, await git(["show", `${SOURCE_REVISION}:${source}`]), report);
  }
  return report;
}

export function validateManifest(manifest, audit) {
  const errors = [];
  if (!manifest.sourceRevision) errors.push("Missing source revision");
  else if (manifest.sourceRevision !== audit.sourceRevision) {
    errors.push(`Source revision ${manifest.sourceRevision} does not match ${audit.sourceRevision}`);
  }

  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const fixtures = new Set(Object.keys(manifest.fixtures ?? {}));
  const ids = new Set();
  const coveredBranches = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) errors.push(`Duplicate entry id: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.source || !entry.symbol || !entry.condition) {
      errors.push(`Absent citation on entry: ${entry.id ?? "<missing id>"}`);
    }
    if (!fixtures.has(entry.fixture)) {
      errors.push(`Unknown fixture id ${entry.fixture} on entry ${entry.id}`);
    }
    for (const branchId of entry.audit ?? []) coveredBranches.add(branchId);
  }

  for (const branch of audit.branches) {
    if (!coveredBranches.has(branch.id)) errors.push(`Uncovered audited branch: ${branch.id}`);
  }
  return errors;
}

function familyFor(source) {
  const lower = source.toLowerCase();
  if (lower.includes("notetaker")) return "notetaker";
  if (lower.includes("pill")) return "pill";
  if (lower.includes("pocket")) return "pocket";
  if (lower.includes("conversation") || lower.includes("composer") || lower.includes("stage")) return "conversation";
  if (lower.includes("wall")) return "cockpit";
  if (lower.includes("scratchpad")) return "scratchpad";
  return "native-notch";
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function createManifest(audit) {
  const fixtures = {};
  const entries = audit.branches.map((branch, index) => {
    const id = `${familyFor(branch.source)}-${slug(branch.symbol)}-${branch.line}-${index + 1}`;
    const fixture = `fixture-${id}`;
    fixtures[fixture] = { auditBranch: branch.id };
    return {
      id,
      family: familyFor(branch.source),
      source: branch.source,
      symbol: branch.symbol,
      condition: branch.value,
      fixture,
      interactions: [],
      baseline: `native/baselines/${id}.png`,
      audit: [branch.id],
    };
  });
  return { sourceRevision: audit.sourceRevision, fixtures, entries };
}

async function main() {
  const audit = await auditSource();
  if (process.argv.includes("--write-manifest")) {
    const output = new URL("../fixtures/manifest.json", import.meta.url);
    await mkdir(new URL("../fixtures/", import.meta.url), { recursive: true });
    await writeFile(output, `${JSON.stringify(createManifest(audit), null, 2)}\n`);
    return;
  }
  if (process.argv.includes("--manifest")) {
    process.stdout.write(`${JSON.stringify(createManifest(audit), null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
