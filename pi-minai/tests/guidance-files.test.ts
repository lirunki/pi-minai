import assert from "node:assert/strict";
import test from "node:test";
import { loadGuidanceCatalog } from "../src/index.js";

test("loads the existing Python MINAI guidance catalog", async () => {
  const catalog = await loadGuidanceCatalog("../guidances");
  assert.ok(catalog.list().length >= 15);
  assert.equal(catalog.get("code_review")?.description.includes("structured review"), true);
  assert.ok(catalog.resolve("code_review", "any-model").instructions.length > 20);
  assert.ok(catalog.resolve("plan_query", "any-model").instructions.length > 20);
});
