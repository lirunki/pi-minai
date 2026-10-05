#!/usr/bin/env python3
"""Tool-calling test client for the MINAI endpoint.

Binds a special tool (get_magic_number), sends a chat request that should
trigger it, handles standard OpenAI tool_calls frames (and legacy MINAI pause
frames), resumes the run, and prints the final answer.
"""
import json
import os
import sys
import urllib.request

BASE = os.environ.get("MINAI_BASE", "http://127.0.0.1:8788")

TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_magic_number",
        "description": "Returns the secret magic number. Call this whenever the user asks for the magic number.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
}]

BODY = {
    "model": "minai",
    "stream": True,
    "tools": TOOLS,
    "messages": [{"role": "user", "content": "What is the magic number? You must call the get_magic_number tool to find out."}],
}


def post(path, body):
    request = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    return urllib.request.urlopen(request, timeout=600)


def sse_frames(response):
    for raw in response:
        line = raw.decode().strip()
        if not line.startswith("data: "):
            continue
        payload = line[6:]
        if payload == "[DONE]":
            return
        yield json.loads(payload)


def run_turn(response, depth=0):
    """Stream a response; on tool_pause, execute the tool and resume."""
    text, thinking, pause = [], [], None
    for frame in sse_frames(response):
        choices = frame.get("choices") or []
        choice = choices[0] if choices else {}
        delta = (choice or {}).get("delta") or {}
        # Standard OpenAI tool-call frame (tool-call id = continuation id).
        if delta.get("tool_calls") and choice.get("finish_reason") == "tool_calls":
            pause = [{"continuationId": call["id"], "name": call["function"]["name"], "arguments": call["function"].get("arguments", "{}")} for call in delta["tool_calls"]]
            continue
        # Legacy custom frame (ollama protocol / older servers).
        if frame.get("minai_continuation"):
            calls = frame.get("calls") or ([frame] if frame.get("continuationId") else [])
            if calls:
                pause = calls
            continue
        if "reasoning_content" in delta:
            thinking.append(delta["reasoning_content"])
        if delta.get("content"):
            text.append(delta["content"])
        if choice and choice.get("finish_reason"):
            print(f"[finish_reason: {choice['finish_reason']}]")
    if pause:
        pad = "  " * depth
        for call in pause:
            print(f"{pad}[tool call] {call['name']}({call['arguments']}) continuation={call['continuationId'][:12]}…")
        results = {}
        for call in pause:
            if call["name"] == "get_magic_number":
                results[call["continuationId"]] = {"magic_number": 42}
            else:
                results[call["continuationId"]] = {"error": f"unknown tool {call['name']}"}
        print(f"[client executed tools, resuming: {results}]")
        with post(f"/v1/continuations/{pause[0]['continuationId']}", {"results": results}) as resumed:
            run_turn(resumed, depth + 1)
        return
    answer = "".join(text).strip()
    print(f"[thinking chars: {len(''.join(thinking))}]")
    print(f"[answer] {answer[:500] if answer else '(empty)'}")


def main():
    planning = "--no-plan" not in sys.argv
    if not planning:
        BODY["x-minai-planning"] = False
    print(f"POST {BASE}/v1/chat/completions (tools bound: get_magic_number)")
    with post("/v1/chat/completions", BODY) as response:
        print(f"HTTP {response.status}")
        if response.status != 200:
            print(response.read().decode()[:500])
            sys.exit(1)
        run_turn(response)


if __name__ == "__main__":
    main()
