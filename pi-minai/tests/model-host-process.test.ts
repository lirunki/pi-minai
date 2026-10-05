import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execPath } from "node:process";
import test from "node:test";
import { ModelHostProcess } from "../src/index.js";

test("managed model host process starts, waits for readiness, and stops", async () => {
  let checks = 0;
  const process = new ModelHostProcess({ command: execPath, args: ["-e", "setInterval(() => {}, 1000)"], startupTimeoutMs: 2_000, shutdownTimeoutMs: 500 }, async () => ++checks > 1);
  await process.start(); assert.equal(process.running, true); assert.ok(checks >= 2); await process.stop(); assert.equal(process.running, false);
});

test("managed model host process writes child output to the log file", async () => {
  const logFile = path.join(os.tmpdir(), `minai-test-${Date.now()}.log`);
  let checks = 0;
  const process = new ModelHostProcess({ command: execPath, args: ["-e", "console.error('llama says hi'); setInterval(() => {}, 1000)"], logFile, startupTimeoutMs: 2_000, shutdownTimeoutMs: 500 }, async () => ++checks > 2);
  await process.start();
  assert.equal(process.logPath, logFile);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const log = readFileSync(logFile, "utf8");
  assert.match(log, /llama says hi/);
  await process.stop();
  rmSync(logFile, { force: true });
});
