import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { InMemoryPythonToolCatalog, SubprocessPythonToolRunner } from "../src/index.js";
import type { PythonToolManifest } from "../src/index.js";

const manifest: PythonToolManifest = {
  name: "echo_tool",
  description: "Echo an input value.",
  inputSchema: { type: "object" },
  entrypoint: "tests/fixtures/python-tool.py",
  permissions: [],
  version: "1.0.0",
  status: "active",
};

function runner(manifests = [manifest]) {
  return new SubprocessPythonToolRunner(new InMemoryPythonToolCatalog(manifests), { workspaceRoot: process.cwd(), defaultTimeoutMs: 1000 });
}

test("catalog validates and lists Python tool manifests", () => {
  const catalog = new InMemoryPythonToolCatalog([manifest]);
  assert.equal(catalog.list()[0]?.name, "echo_tool");
  assert.throws(() => new InMemoryPythonToolCatalog([{ ...manifest, name: "bad name" }]), /name is invalid/);
  assert.throws(() => new InMemoryPythonToolCatalog([manifest, manifest]), /already exists/);
});

test("runner executes Python in a separate process and parses JSON", async () => {
  const result = await runner().run("echo_tool", { value: "hello" });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { echo: "hello" });
});

test("runner rejects inactive, disallowed, and escaping tools", async () => {
  const inactive = await runner([{ ...manifest, status: "disabled" }]).run("echo_tool", {});
  assert.equal(inactive.ok, false);
  assert.equal(!inactive.ok && inactive.code, "tool_inactive");
  const permission = await runner([{ ...manifest, permissions: ["network"] }]).run("echo_tool", {});
  assert.equal(!permission.ok && permission.code, "tool_permission");
  const escaping = await runner([{ ...manifest, entrypoint: "../outside.py" }]).run("echo_tool", {});
  assert.equal(!escaping.ok && escaping.code, "tool_path");
});

test("runner reports non-zero output and honors abort", async () => {
  const failed = await runner().run("echo_tool", { fail: true });
  assert.equal(!failed.ok && failed.code, "tool_exit");
  const controller = new AbortController();
  controller.abort();
  const aborted = await runner().run("echo_tool", {}, controller.signal);
  assert.equal(!aborted.ok && aborted.code, "tool_aborted");
  assert.equal(path.isAbsolute(manifest.entrypoint), false);
});
