import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifestUrl = new URL("../fixtures/manifest.json", import.meta.url);

test("the state manifest is complete and rejects invalid inventory mutations", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const { auditSource, validateManifest } = await import(
    "../scripts/audit-source.mjs"
  );
  const audit = await auditSource();

  assert.deepEqual(validateManifest(manifest, audit), []);

  const mutations = [
    {
      name: "missing source revision",
      alter(value) {
        delete value.sourceRevision;
      },
      error: /source revision/i,
    },
    {
      name: "duplicate IDs",
      alter(value) {
        value.entries.push(structuredClone(value.entries[0]));
      },
      error: /duplicate entry id/i,
    },
    {
      name: "absent citations",
      alter(value) {
        value.entries[0].source = "";
      },
      error: /citation/i,
    },
    {
      name: "unknown fixture IDs",
      alter(value) {
        value.entries[0].fixture = "fixture-that-does-not-exist";
      },
      error: /unknown fixture/i,
    },
    {
      name: "uncovered audited branches",
      alter(value) {
        const covered = value.entries.find((entry) => entry.audit.length > 0);
        covered.audit = covered.audit.slice(1);
      },
      error: /uncovered audited branch/i,
    },
  ];

  for (const mutation of mutations) {
    const candidate = structuredClone(manifest);
    mutation.alter(candidate);
    assert.match(
      validateManifest(candidate, audit).join("\n"),
      mutation.error,
      mutation.name,
    );
  }
});
