import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDedicatedStreamRequest,
  buildOpenAiRequestBody,
  buildProofPrompt,
  consumeAgentEvent,
  consumeOpenAiEvent,
  parseProbeCase,
  parseServerTiming,
  probeDedicated,
  probeOpenAi,
  readSse,
  runCli,
  runPairedProbes,
  safeHttpError,
  safeTerminalTelemetry,
  selectedResponseHeaders,
  summarizeLatencyRecords,
} from "./chat-latency.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function openAiSse(events, { done = true, status = 200, headers } = {}) {
  const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (done) frames.push("data: [DONE]\n\n");
  return new Response(frames.join(""), {
    status,
    headers: {
      "content-type": "text/event-stream",
      ...headers,
    },
  });
}

function successfulOpenAiResponse(proof, options) {
  return openAiSse(
    [
      { choices: [{ delta: { content: proof }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    ],
    options,
  );
}

test("parseProbeCase preserves model, reasoning mode, and token cap", () => {
  assert.deepEqual(parseProbeCase("zai-glm-4.7@none@512"), {
    model: "zai-glm-4.7",
    reasoningEffort: "none",
    maxTokens: 512,
  });
  assert.deepEqual(parseProbeCase("gemma-4-31b"), {
    model: "gemma-4-31b",
    reasoningEffort: "omit",
    maxTokens: 512,
  });
  assert.throws(
    () => parseProbeCase("zai-glm-4.7@invalid@512"),
    /Unsupported reasoning effort/,
  );
  assert.throws(
    () => parseProbeCase("gemma-4-31b@none@0"),
    /max_tokens must be an integer/,
  );
});

test("buildOpenAiRequestBody omits rather than fabricates reasoning_effort", () => {
  const omitted = buildOpenAiRequestBody(
    parseProbeCase("gemma-4-31b@omit@512"),
    "private prompt",
  );
  assert.equal("reasoning_effort" in omitted, false);
  assert.equal(omitted.max_tokens, 512);

  const disabled = buildOpenAiRequestBody(
    parseProbeCase("zai-glm-4.7@none@512"),
    "private prompt",
  );
  assert.equal(disabled.reasoning_effort, "none");

  const cached = buildOpenAiRequestBody(
    parseProbeCase("gemma-4-31b@omit@512"),
    "private prompt",
    "stable-benchmark-session",
  );
  assert.equal(cached.prompt_cache_key, "stable-benchmark-session");
});

test("parseServerTiming returns only valid non-negative durations", () => {
  assert.deepEqual(
    parseServerTiming(
      'gateway_auth;dur=2.25, gateway_middle;dur="10", bad;dur=-1, no-duration',
    ),
    {
      gateway_auth: 2.25,
      gateway_middle: 10,
    },
  );
});

test("selectedResponseHeaders excludes authorization and arbitrary headers", () => {
  const selected = selectedResponseHeaders(
    new Headers({
      authorization: "Bearer secret",
      "cf-placement": "remote-ATL",
      "cf-ray": "ray-id",
      "server-timing": "gateway_auth;dur=2",
      "x-untrusted": "private",
    }),
  );
  assert.deepEqual(selected, {
    "cf-placement": "remote-ATL",
    "cf-ray": "ray-id",
    "server-timing": "gateway_auth;dur=2",
  });
});

test("consumeOpenAiEvent separates hidden reasoning from visible content", () => {
  assert.deepEqual(
    consumeOpenAiEvent({
      choices: [
        {
          delta: {
            reasoning_content: "hidden",
            content: "visible",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
        total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 4, private: 99 },
        private_internal_counter: 99,
      },
      time_info: {
        queue_time: 0.001,
        prompt_time: 0.02,
        completion_time: 0.03,
        total_time: 0.051,
        private_internal_timing: 99,
      },
    }),
    {
      content: "visible",
      reasoning: "hidden",
      finishReason: "stop",
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
        total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 4 },
      },
      providerTimeInfo: {
        queue_time: 0.001,
        prompt_time: 0.02,
        completion_time: 0.03,
        total_time: 0.051,
      },
      providerError: null,
    },
  );
});

test("readSse records first event, reasoning, visible token, and usage", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"proof"}}],"usage":{"total_tokens":9}}\n',
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const readings = [110, 112, 130];
  const result = await readSse(body, 100, consumeOpenAiEvent, () =>
    readings.shift(),
  );

  assert.equal(result.firstEventMs, 10);
  assert.equal(result.firstReasoningMs, 12);
  assert.equal(result.firstTokenMs, 30);
  assert.equal(result.reasoningCharacters, 5);
  assert.equal(result.outputCharacters, 5);
  assert.equal(result.outputText, "proof");
  assert.deepEqual(result.usage, { total_tokens: 9 });
});

test("safeHttpError never returns an upstream message or body", async () => {
  const response = new Response(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "bad_model",
        message: "prompt and credential-like detail must stay private",
      },
    }),
    { status: 400 },
  );
  const error = await safeHttpError(response);
  assert.deepEqual(error, {
    status: 400,
    type: "invalid_request_error",
    code: "bad_model",
  });
  assert.equal("message" in error, false);
});

test("buildProofPrompt preserves a custom prompt and always adds the nonce", () => {
  assert.equal(
    buildProofPrompt("Use a table", "proof-123"),
    "Use a table\n\nInclude this exact token in the answer: proof-123",
  );
  assert.match(buildProofPrompt(undefined, "proof-456"), /proof-456/);
});

test("probeOpenAi requires a clean terminal frame and never records prompt text", async () => {
  let requestBody = null;
  const result = await probeOpenAi({
    target: "gateway",
    probeCase: parseProbeCase("zai-glm-4.7@none@512"),
    baseUrl: "https://gateway.example",
    apiKey: "super-secret",
    promptOverride: "Custom private instruction",
    proof: "proof-clean",
    timeoutMs: 5_000,
    sequence: 4,
    metadata: { phase: "warm", pairId: "pair-1" },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return successfulOpenAiResponse("proof-clean", {
        headers: {
          "x-eliza-preforward-ms": "total=12;auth=2;mid=3;reserve=4;setup=3",
          "x-eliza-trace-id": "trace-safe",
          "x-private": "must-not-escape",
        },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.cleanCompletion, true);
  assert.equal(result.sawDone, true);
  assert.equal(result.phase, "warm");
  assert.deepEqual(result.preforward, {
    total: 12,
    auth: 2,
    mid: 3,
    reserve: 4,
    setup: 3,
  });
  assert.match(requestBody.messages[0].content, /Custom private instruction/);
  assert.match(requestBody.messages[0].content, /proof-clean/);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /super-secret/);
  assert.doesNotMatch(serialized, /Custom private instruction/);
  assert.doesNotMatch(serialized, /must-not-escape/);
});

test("probeOpenAi rejects truncated, malformed, and provider-error streams", async () => {
  const common = {
    target: "direct",
    probeCase: parseProbeCase("gemma-4-31b@omit@512"),
    baseUrl: "https://direct.example",
    apiKey: "secret",
    proof: "proof-token",
    timeoutMs: 5_000,
    sequence: 1,
  };
  const truncated = await probeOpenAi({
    ...common,
    fetchImpl: async () =>
      successfulOpenAiResponse("proof-token", { done: false }),
  });
  assert.equal(truncated.proofMatched, true);
  assert.equal(truncated.sawDone, false);
  assert.equal(truncated.ok, false);

  const malformed = await probeOpenAi({
    ...common,
    fetchImpl: async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"proof-token"}}]}\n\n',
          "data: not-json\n\n",
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
      ),
  });
  assert.equal(malformed.malformedEvents, 1);
  assert.equal(malformed.ok, false);

  const providerError = await probeOpenAi({
    ...common,
    fetchImpl: async () =>
      openAiSse([
        { choices: [{ delta: { content: "proof-token" } }] },
        { error: { type: "provider_error", code: "overloaded" } },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
  });
  assert.deepEqual(providerError.providerError, {
    type: "provider_error",
    code: "overloaded",
  });
  assert.equal(providerError.ok, false);
});

test("probeOpenAi reduces HTTP and network errors to safe metadata", async () => {
  const common = {
    target: "gateway",
    probeCase: parseProbeCase("gemma-4-31b@omit@512"),
    baseUrl: "https://gateway.example",
    apiKey: "secret",
    timeoutMs: 5_000,
    sequence: 1,
  };
  const http = await probeOpenAi({
    ...common,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "bad_model",
            message: "private upstream detail",
          },
        }),
        { status: 400 },
      ),
  });
  assert.deepEqual(http.error, {
    status: 400,
    type: "invalid_request_error",
    code: "bad_model",
  });
  assert.doesNotMatch(JSON.stringify(http), /private upstream detail/);

  const network = await probeOpenAi({
    ...common,
    fetchImpl: async () => {
      const error = new Error("URL and private details");
      error.name = "TimeoutError";
      throw error;
    },
  });
  assert.equal(network.networkError, "TimeoutError");
  assert.doesNotMatch(JSON.stringify(network), /private details/);
});

test("safeTerminalTelemetry uses exact numeric paths and drops arbitrary strings", () => {
  assert.deepEqual(
    safeTerminalTelemetry({
      agentRoute: {
        ingressToSseOpenMs: 5,
        ingressToDoneMs: 20,
        requestBody: "private",
      },
      runtime: {
        totalMs: 18,
        provider: "cerebras",
        providerResponse: "private generated text",
        contributions: { model: 12, hooks: 3 },
        marks: { "first-token": 9 },
        timeline: [{ prompt: "private" }],
      },
    }),
    {
      agentRoute: {
        ingressToSseOpenMs: 5,
        ingressToDoneMs: 20,
      },
      runtime: {
        totalMs: 18,
        provider: "cerebras",
        contributions: { model: 12, hooks: 3 },
        marks: { "first-token": 9 },
      },
    },
  );
});

test("probeDedicated requires a done terminal and sanitizes telemetry", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method });
    if (calls.length === 1) {
      return Response.json({ conversation: { id: "conversation-1" } });
    }
    if (calls.length === 2) {
      return new Response(
        [
          'data: {"type":"token","text":"proof-agent"}\n\n',
          'data: {"type":"done","telemetry":{"agentRoute":{"ingressToDoneMs":25,"requestBody":"private"},"runtime":{"totalMs":20,"provider":"cerebras","providerResponse":"private"}}}\n\n',
        ].join(""),
        { status: 200 },
      );
    }
    return new Response(null, { status: 204 });
  };

  const result = await probeDedicated({
    agentId: "agent-1",
    baseUrl: "https://agent.example",
    apiKey: "secret",
    proof: "proof-agent",
    timeoutMs: 5_000,
    sequence: 1,
    keepConversation: false,
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.terminalType, "done");
  assert.deepEqual(result.terminalTelemetry, {
    agentRoute: { ingressToDoneMs: 25 },
    runtime: { totalMs: 20, provider: "cerebras" },
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].method, "DELETE");

  const errorResult = await probeDedicated({
    agentId: "agent-2",
    baseUrl: "https://agent.example",
    apiKey: "secret",
    proof: "proof-agent",
    timeoutMs: 5_000,
    sequence: 1,
    keepConversation: true,
    fetchImpl: async (url) =>
      url.endsWith("/api/conversations")
        ? Response.json({ id: "conversation-2" })
        : new Response(
            [
              'data: {"type":"token","text":"proof-agent"}\n\n',
              'data: {"type":"error","message":"private"}\n\n',
            ].join(""),
          ),
  });
  assert.equal(errorResult.proofMatched, true);
  assert.equal(errorResult.terminalType, "error");
  assert.equal(errorResult.ok, false);
  assert.doesNotMatch(JSON.stringify(errorResult), /private/);
});

test("probeDedicated never records an arbitrary transport error message", async () => {
  const result = await probeDedicated({
    agentId: "agent-privacy",
    baseUrl: "https://agent.example",
    apiKey: "private-api-key",
    timeoutMs: 1_000,
    sequence: 1,
    keepConversation: false,
    fetchImpl: async () => {
      throw new Error("private-api-key");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, null);
  assert.doesNotMatch(JSON.stringify(result), /private-api-key/);
});

test("buildDedicatedStreamRequest matches the frontend SSE wire contract", () => {
  const request = buildDedicatedStreamRequest({
    baseUrl: "https://agent.example",
    conversationId: "conversation-1",
    apiKey: "secret-key",
    prompt: "private prompt",
    traceId: "latency_trace",
  });

  assert.equal(
    request.url,
    "https://agent.example/api/conversations/conversation-1/messages/stream",
  );
  assert.equal(request.method, "POST");
  assert.equal(
    headerValue(request.headers, "Authorization"),
    "Bearer secret-key",
  );
  assert.equal(
    headerValue(request.headers, "Content-Type"),
    "application/json",
  );
  assert.equal(headerValue(request.headers, "Accept"), "text/event-stream");
  assert.equal(
    headerValue(request.headers, "X-Eliza-Trace-Id"),
    "latency_trace",
  );
  assert.equal(headerValue(request.headers, "X-Eliza-Telemetry"), "full");
  assert.equal(
    headerValue(request.headers, "User-Agent"),
    "eliza-chat-latency/1.0",
  );

  const correlation = headerValue(
    request.headers,
    "X-ElizaOS-Turn-Correlation",
  );
  assert.match(correlation, UUID_RE);

  const body = JSON.parse(request.body);
  assert.equal(body.text, "private prompt");
  assert.equal(body.channelType, "DM");
  assert.match(body.clientMessageId, UUID_RE);
  assert.equal(body.streamProtocol, "delta-v2");

  // The correlation id is opaque per-turn: two invocations never share one.
  const second = buildDedicatedStreamRequest({
    baseUrl: "https://agent.example",
    conversationId: "conversation-1",
    apiKey: "secret-key",
    prompt: "private prompt",
    traceId: "latency_trace",
  });
  assert.notEqual(
    correlation,
    headerValue(second.headers, "X-ElizaOS-Turn-Correlation"),
  );
  assert.notEqual(
    body.clientMessageId,
    JSON.parse(second.body).clientMessageId,
  );
});

test("probeDedicated sends the frontend-equivalent delta-v2 stream request", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    if (calls.length === 1) {
      return Response.json({ conversation: { id: "conversation-wire" } });
    }
    if (calls.length === 2) {
      return new Response(
        [
          'data: {"type":"token","delta":"proof-wire"}\n\n',
          'data: {"type":"done","telemetry":{"runtime":{"totalMs":21}}}\n\n',
        ].join(""),
        { status: 200 },
      );
    }
    return new Response(null, { status: 204 });
  };

  const result = await probeDedicated({
    agentId: "agent-wire",
    baseUrl: "https://agent.example",
    apiKey: "wire-secret-key",
    proof: "proof-wire",
    timeoutMs: 5_000,
    sequence: 1,
    keepConversation: false,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  const streamCall = calls[1];
  assert.equal(
    streamCall.url,
    "https://agent.example/api/conversations/conversation-wire/messages/stream",
  );
  assert.equal(streamCall.method, "POST");
  // Full preserved header contract on the captured stream call.
  const correlation = headerValue(
    streamCall.headers,
    "X-ElizaOS-Turn-Correlation",
  );
  assert.match(correlation, UUID_RE);
  assert.equal(
    headerValue(streamCall.headers, "Authorization"),
    "Bearer wire-secret-key",
  );
  assert.equal(
    headerValue(streamCall.headers, "Content-Type"),
    "application/json",
  );
  assert.equal(headerValue(streamCall.headers, "Accept"), "text/event-stream");
  assert.match(
    headerValue(streamCall.headers, "X-Eliza-Trace-Id"),
    /^latency_/,
  );
  assert.equal(headerValue(streamCall.headers, "X-Eliza-Telemetry"), "full");
  assert.equal(
    headerValue(streamCall.headers, "User-Agent"),
    "eliza-chat-latency/1.0",
  );
  const body = JSON.parse(streamCall.body);
  assert.equal(body.text.includes("Include this exact token"), true);
  assert.equal(body.streamProtocol, "delta-v2");
  assert.equal(body.channelType, "DM");
  assert.match(body.clientMessageId, UUID_RE);
  // Privacy: the generated correlation value, the API key, and the prompt
  // never reach probe records.
  const serialized = JSON.stringify(result);
  assert.ok(correlation);
  assert.doesNotMatch(serialized, new RegExp(correlation));
  assert.doesNotMatch(serialized, /wire-secret-key/);
  assert.doesNotMatch(serialized, /exact token/);
});

test("consumeAgentEvent accumulates bare deltas and treats fullText-only frames as authoritative snapshots", async () => {
  const bare = consumeAgentEvent({ type: "token", delta: "wor" });
  assert.equal(bare.content, "wor");
  assert.equal(bare.snapshot, undefined);
  const legacy = consumeAgentEvent({ type: "token", text: "ld" });
  assert.equal(legacy.content, "ld");
  assert.equal(legacy.snapshot, undefined);

  // delta-v2 snapshot: no incremental field, fullText = whole reply.
  const snapshot = consumeAgentEvent({
    type: "token",
    fullText: "whole reply",
  });
  assert.equal(snapshot.content, "");
  assert.equal(snapshot.snapshot, "whole reply");

  // delta-v2 PERIODIC self-heal frame: carries BOTH the incremental text
  // chunk and the authoritative accumulated fullText (server writeChunk on
  // its geometric snapshot cadence). fullText wins; the chunk must not also
  // be appended.
  const periodic = consumeAgentEvent({
    type: "token",
    text: "wire",
    fullText: "proof-missing-wire",
  });
  assert.equal(periodic.content, "");
  assert.equal(periodic.snapshot, "proof-missing-wire");

  // End-to-end accumulation through readSse: bare deltas append, a snapshot
  // replaces (self-heal after a dropped delta), and a snapshot-only turn
  // still yields the full reply for proof matching.
  const stream = new Response(
    [
      'data: {"type":"token","delta":"proof-"}\n\n',
      // Dropped delta implied: accumulated text is wrong until the snapshot.
      'data: {"type":"token","fullText":"proof-snap"}\n\n',
      'data: {"type":"token","delta":"!"}\n\n',
      'data: {"type":"done"}\n\n',
    ].join(""),
    { status: 200 },
  );
  const result = await readSse(stream.body, 0, consumeAgentEvent);
  assert.equal(result.outputText, "proof-snap!");
  assert.equal(result.outputCharacters, "proof-snap!".length);
  assert.equal(result.terminal.type, "done");

  // R2 reproduction: a periodic self-heal frame ({text, fullText} both)
  // after a dropped delta must replace, not append, the accumulated text.
  const periodicStream = await readSse(
    new Response(
      [
        'data: {"type":"token","text":"proof-"}\n\n',
        'data: {"type":"token","text":"wire","fullText":"proof-missing-wire"}\n\n',
        'data: {"type":"done"}\n\n',
      ].join(""),
      { status: 200 },
    ).body,
    0,
    consumeAgentEvent,
  );
  assert.equal(periodicStream.outputText, "proof-missing-wire");

  // A single-frame snapshot-only turn (e.g. wallet guidance) must still
  // produce the full text — the delta-v2 framing the probe now negotiates.
  const single = await readSse(
    new Response(
      [
        'data: {"type":"token","fullText":"single-frame reply"}\n\n',
        'data: {"type":"done"}\n\n',
      ].join(""),
      { status: 200 },
    ).body,
    0,
    consumeAgentEvent,
  );
  assert.equal(single.outputText, "single-frame reply");
});

test("probeDedicated lets the done frame's fullText authority repair a dropped delta", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/api/conversations")) {
      return Response.json({ conversation: { id: "conversation-done" } });
    }
    if (url.includes("/messages/stream")) {
      // A delta drops a character; the done frame carries the true reply.
      return new Response(
        [
          'data: {"type":"token","delta":"proof dne"}\n\n',
          'data: {"type":"done","fullText":"proof done","telemetry":{}}\n\n',
        ].join(""),
        { status: 200 },
      );
    }
    return new Response(null, { status: 204 });
  };

  const result = await probeDedicated({
    agentId: "agent-done",
    baseUrl: "https://agent.example",
    apiKey: "secret-key",
    proof: "proof done",
    timeoutMs: 5_000,
    sequence: 1,
    keepConversation: true,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.proofMatched, true);
  assert.equal(result.outputCharacters, "proof done".length);
});

test("runPairedProbes reuses prompts, runs targets in parallel, and labels phases", async () => {
  const seenPrompts = new Map();
  const sleeps = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const records = await runPairedProbes({
    cases: [parseProbeCase("gemma-4-31b@omit@512")],
    repeats: 2,
    direct: { baseUrl: "https://direct.example", apiKey: "direct-secret" },
    gateway: { baseUrl: "https://gateway.example", apiKey: "gateway-secret" },
    timeoutMs: 5_000,
    idleMs: 1,
    pairIntervalMs: 2,
    seed: "fixed-seed",
    sleepImpl: async (durationMs) => sleeps.push(durationMs),
    fetchImpl: async (url, init) => {
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      const body = JSON.parse(init.body);
      assert.equal(body.prompt_cache_key, "fixed-seed");
      const prompt = body.messages[0].content;
      const proof = prompt.match(/latency-proof-[a-f0-9-]+/)?.[0];
      assert.ok(proof);
      const target = url.includes("direct.example") ? "direct" : "gateway";
      const key = prompt;
      const targets = seenPrompts.get(key) || new Set();
      targets.add(target);
      seenPrompts.set(key, targets);
      await new Promise((resolve) => setImmediate(resolve));
      activeRequests--;
      return successfulOpenAiResponse(proof);
    },
  });

  assert.equal(records.length, 8);
  assert.equal(maxActiveRequests, 2);
  assert.deepEqual(
    new Set(records.map((record) => record.phase)),
    new Set(["cold", "warm", "post-idle"]),
  );
  for (const targets of seenPrompts.values()) {
    assert.deepEqual(targets, new Set(["direct", "gateway"]));
  }
  const pairs = Map.groupBy(records, (record) => record.pairId);
  for (const pair of pairs.values()) {
    assert.equal(pair.length, 2);
    assert.equal(pair[0].targetOrder, pair[1].targetOrder);
  }
  assert.deepEqual(
    Object.fromEntries(
      Map.groupBy(records, (record) => record.targetOrder)
        .entries()
        .map(([order, orderRecords]) => [order, orderRecords.length / 2]),
    ),
    { parallel: 4 },
  );
  assert.deepEqual(sleeps, [2, 2, 1]);
  assert.deepEqual(
    records
      .filter((record) => record.phase === "post-idle")
      .map((record) => record.idleBeforeTargetMs),
    [1, 1],
  );
  assert.ok(
    records
      .filter((record) => record.phase !== "post-idle")
      .every((record) => record.idleBeforeTargetMs === 0),
  );
  assert.ok(
    records
      .filter((record) => record.phase === "warm")
      .every((record) => record.pairIntervalMs === 2),
  );
  assert.ok(
    records
      .filter((record) => record.phase !== "warm")
      .every((record) => record.pairIntervalMs === 0),
  );
});

test("summarizeLatencyRecords reports warm p50, p90, and p95", () => {
  const records = [10, 20, 30].flatMap((firstTokenMs, index) => [
    {
      phase: "warm",
      target: "direct",
      model: "gemma-4-31b",
      reasoningEffort: "omit",
      maxTokens: 512,
      ok: true,
      responseHeadersMs: firstTokenMs - 1,
      firstTokenMs,
      totalMs: firstTokenMs + 5,
      preforward: {},
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: firstTokenMs },
      },
      providerTimeInfo: { prompt_time: firstTokenMs / 1_000 },
      sequence: index + 1,
    },
  ]);
  records.push({ ...records[0], phase: "cold", firstTokenMs: 999 });
  const [summary] = summarizeLatencyRecords(records);
  assert.equal(summary.samples, 3);
  assert.equal(summary.failures, 0);
  assert.deepEqual(summary.firstTokenMs, { p50: 20, p90: 28, p95: 29 });
  assert.deepEqual(summary.preforwardMs, {
    p50: null,
    p90: null,
    p95: null,
  });
  assert.deepEqual(summary.cacheRatePercent, {
    p50: 20,
    p90: 28,
    p95: 29,
  });
  assert.deepEqual(summary.providerPromptMs, {
    p50: 20,
    p90: 28,
    p95: 29,
  });
});

test("paired CLI reports proof misses without a numeric acceptance gate", async () => {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const testEnv = process.env;
  testEnv.TEST_DIRECT_CHAT_KEY = "direct-secret";
  testEnv.TEST_GATEWAY_CHAT_KEY = "gateway-secret";
  globalThis.fetch = async () => successfulOpenAiResponse("wrong-proof");
  process.stdout.write = () => true;
  const args = [
    "--target",
    "paired",
    "--case",
    "gemma-4-31b@omit@512",
    "--repeat",
    "1",
    "--idle-ms",
    "0",
    "--direct-api-key-env",
    "TEST_DIRECT_CHAT_KEY",
    "--gateway-api-key-env",
    "TEST_GATEWAY_CHAT_KEY",
    "--seed",
    "cli-threshold-test",
  ];
  try {
    assert.equal(await runCli(args), 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    delete testEnv.TEST_DIRECT_CHAT_KEY;
    delete testEnv.TEST_GATEWAY_CHAT_KEY;
  }
});
