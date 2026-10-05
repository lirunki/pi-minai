import assert from "node:assert/strict";
import test from "node:test";
import { parseOllamaChat, parseOllamaGenerate, parseOpenAIChat, serializeOllamaChat, serializeOllamaGenerate, serializeOllamaStream, serializeOpenAIChat, serializeOpenAIStream } from "../src/index.js";
import type { NormalizedChatResult } from "../src/index.js";

const result: NormalizedChatResult = { requestId: "r1", model: { provider: "openai", id: "m" }, text: "hello", finishReason: "stop", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } };

test("parses OpenAI chat messages, tools, limits, and reasoning", () => {
  const request = parseOpenAIChat({ model: "openai/m", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }], max_completion_tokens: 20, reasoning_effort: "high" }, "r1");
  assert.deepEqual(request.model, { provider: "openai", id: "m" });
  assert.equal(request.tools?.[0]?.name, "lookup");
  assert.equal(request.maxOutputTokens, 20);
  assert.deepEqual(request.thinking, { effort: "high" });
});

test("flattens OpenAI text content parts instead of rendering objects", () => {
  const request = parseOpenAIChat({ model: "openai/m", messages: [{ role: "user", content: [{ type: "text", text: "hi " }, { type: "text", text: "Luis" }] }] }, "r-content");
  assert.equal(request.messages[0]?.content, "hi Luis");
});

test("parses Ollama chat and generate defaults", () => {
  const chat = parseOllamaChat({ model: "qwen", messages: [{ role: "user", content: "hi" }], think: "medium" }, "r2");
  assert.equal(chat.stream, true);
  assert.deepEqual(chat.thinking, { think: "medium" });
  const generate = parseOllamaGenerate({ model: "qwen", system: "Be concise", prompt: "hi" }, "r3");
  assert.deepEqual(generate.messages.map((message) => message.role), ["system", "user"]);
});

test("serializes normalized results for OpenAI and Ollama", () => {
  assert.equal(serializeOpenAIChat(result).choices instanceof Array, true);
  assert.equal((serializeOllamaChat(result) as { done: boolean }).done, true);
  assert.equal((serializeOllamaGenerate(result) as { response: string }).response, "hello");
});

test("serializes stream deltas and usage", () => {
  const text = serializeOpenAIStream({ type: "text_delta", requestId: "r1", model: result.model, delta: "hi" });
  assert.equal((text.choices as Array<{ delta: { content: string } }>)[0]!.delta.content, "hi");
  const done = serializeOpenAIStream({ type: "done", result });
  assert.deepEqual(done.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.equal((serializeOllamaStream({ type: "text_delta", requestId: "r1", model: result.model, delta: "x" })).done, false);
  assert.equal((serializeOllamaStream({ type: "text_delta", requestId: "r1", model: result.model, delta: "x" }, true)).response, "x");
});
