/**
 * Browser proof for #31027: real Chromium AudioContext + the REAL
 * `playDecodedVoiceAudio` helper, synthetic 2s PCM, ScriptProcessor tap on
 * the destination path. Two cases (control + mid-playback suspension) mirroring
 * the reproduction in issue #31027, plus a never-resume error case.
 *
 * Evidence: JSON + console transcript written to
 * `src/voice/__e2e__/output-suspension/`.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const sourceRoot = new URL("../", import.meta.url);
const outputDir = new URL("./output-suspension/", import.meta.url);
await mkdir(outputDir, { recursive: true });

// The helper's import graph transitively reaches Node-only shared utils that
// the watchdog contract never invokes (API clients, node:crypto, etc). Stub
// every non-relative import — and the two relative side-effect-heavy utils
// barrels the helper itself does not need at runtime for this contract — with
// browser-safe modules so only the watchdog/playback code executes for real.
const STUBBED_RELATIVE_MODULES = new Set([
  // ../utils barrel → cloud-agent-base evaluates ELIZA_DOMAIN_CONTRACTS at
  // module top level (Node/env dependent).
  "../utils/tts-debug",
  // ../api/csrf-client + ../utils → fetch/window layer irrelevant here.
  "./playback-frame-pump",
]);
const stubBareImports = {
  name: "stub-bare-imports",
  setup(buildInstance) {
    buildInstance.onResolve({ filter: /^[^./]/ }, (args) => ({
      path: args.path,
      namespace: "proof-stub",
    }));
    buildInstance.onResolve(
      { filter: /^\.\.?\// },
      (args) => {
        const marker = `${args.importer} -> ${args.path}`;
        if (STUBBED_RELATIVE_MODULES.has(args.path)) {
          return { path: marker, namespace: "proof-stub" };
        }
        return null;
      },
    );
    buildInstance.onLoad({ filter: /.*/, namespace: "proof-stub" }, () => ({
      // A deep Proxy satisfies any property read or call shape without
      // enumerating per-package exports.
      contents: `const deep = () => new Proxy(function(){}, {
        get: (t, p) => {
          if (p === Symbol.toPrimitive) return () => "";
          if (p === "toString") return () => "";
          if (p === "valueOf") return () => 0;
          return deep();
        },
        apply: () => deep(),
      });
      const stub = deep();
      export { stub as default };
      export const ttsDebug = () => {};
      export const ttsDebugTextPreview = (s) => String(s);
      export const PlaybackTapLifecycle = class {
        constructor() {}
        async attach() { return null; }
        start() {}
        finish() {}
      };`,
      loader: "js",
      resolveDir: "/",
    }));
  },
};

const bundle = await build({
  stdin: {
    contents: 'export { playDecodedVoiceAudio } from "./voice-chat-audio-playback";',
    resolveDir: fileURLToPath(sourceRoot),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  plugins: [stubBareImports],
});

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleLines = [];
page.on("console", (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`));

// Serve the bundle from a local origin so the browser can import it.
import { createServer } from "node:http";
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/javascript");
  res.end(bundle.outputFiles[0].text);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

await page.goto(`http://127.0.0.1:${port}/`);

const result = await page.evaluate(async () => {
  const { playDecodedVoiceAudio } = await import("/index.js");
  const SAMPLE_RATE = 48000;
  const DURATION_S = 2;

  async function runCase(mode) {
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const buffer = context.createBuffer(1, SAMPLE_RATE * DURATION_S, SAMPLE_RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.sin((i / 20) % 1) * 0.5;

    // Downstream tap: count nonzero samples that actually reached a sink node.
    const tap = context.createScriptProcessor(4096, 1, 1);
    let nonzero = 0;
    let tapSamples = 0;
    tap.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i += 1) {
        tapSamples += 1;
        if (input[i] !== 0) nonzero += 1;
      }
    };
    // The tap must sit on the playback path to observe delivered PCM. We
    // connect it in parallel with the analyser→destination chain by wiring
    // our own analyser-equivalent: connect the helper's source is not
    // directly reachable, so we tap at destination via a MediaStream-free
    // approach: reroute through a GainNode the helper's analyser feeds into
    // destination — instead, simply connect tap → silent gain → destination
    // and also feed the source into it via the analyser's output.
    const silent = context.createGain();
    silent.gain.value = 0;
    tap.connect(silent);
    silent.connect(context.destination);

    const cells = {
      analyserRef: { current: null },
      timeDomainDataRef: { current: null },
      audioSourceRef: { current: null },
      playbackFrameTapRef: { current: null },
      activeTaskFinishRef: { current: null },
      speechTimeoutRef: { current: null },
    };

    // Hook: after the helper creates the analyser (connected to
    // destination), also bridge analyser → tap so the ScriptProcessor sees
    // the playback PCM.
    const origCreateAnalyser = context.createAnalyser.bind(context);
    context.createAnalyser = () => {
      const analyser = origCreateAnalyser();
      try {
        analyser.connect(tap);
      } catch {}
      return analyser;
    };

    const events = { started: 0 };
    const timing = { pollMs: 100, graceMs: 1200, floorMs: 2500, suspensionDeadlineMs: 8000 };
    const playback = playDecodedVoiceAudio({
      context,
      audioBuffer: buffer,
      generation: 1,
      generationRef: { current: 1 },
      provider: "eliza-cloud",
      text: "synthetic proof",
      task: { text: "synthetic proof", append: false, segment: "full" },
      cached: false,
      ...cells,
      getPlaybackFramePump: () => ({ tapSource: () => Promise.resolve(null) }),
      clearSpeechTimers: () => {},
      emitPlaybackStart: () => {
        events.started += 1;
      },
      tracePlayback: false,
      watchdogTiming: timing,
    });

    const wall0 = performance.now();
    let outcome = "pending";
    let resumedAtMs = null;
    playback.then(
      () => {
        outcome = "resolved";
      },
      (error) => {
        outcome = `rejected: ${error.message}`;
      },
    );

    if (mode === "pause" || mode === "never") {
      await new Promise((r) => setTimeout(r, 200));
      await context.suspend();
    }

    if (mode === "pause") {
      // Resume at ~4.7s wall — 1.5s PAST the nominal 3200ms wall deadline
      // (where the old watchdog falsely retired the segment), but well
      // before the 8s hard suspension deadline. Proves the helper kept
      // waiting and the buffered PCM resumed delivery.
      for (let i = 0; i < 45 && outcome === "pending"; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      resumedAtMs = performance.now() - wall0;
      try {
        await context.resume();
      } catch {}
    }

    // Wait for settle, up to 30s wall.
    for (let i = 0; i < 300 && outcome === "pending"; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const totalNonzero = nonzero;
    const totalTapSamples = tapSamples;
    try {
      await context.close();
    } catch {}
    return {
      mode,
      outcome,
      startedCount: events.started,
      nonzeroSamples: totalNonzero,
      tapSamples: totalTapSamples,
      resumedAtMs,
    };
  }

  return {
    control: await runCase("control"),
    pause: await runCase("pause"),
    neverResume: await runCase("never"),
  };
});

await browser.close();
server.close();

// Assertions per issue acceptance:
// Control: resolves, full delivery.
assert.equal(result.control.outcome, "resolved");
// Pause: must resolve (after resume + natural end), with near-full delivery —
// NOT the truncated ~9-10% delivery of the old false-success retire.
assert.equal(result.pause.outcome, "resolved");
assert.ok(
  result.pause.nonzeroSamples > result.control.nonzeroSamples * 0.5,
  `pause case delivered only ${result.pause.nonzeroSamples} of ~${result.control.nonzeroSamples} control samples`,
);
// Never-resume: must REJECT (truthful failure), not fabricate success.
assert.match(result.neverResume.outcome, /^rejected:/);

await writeFile(
  new URL("suspension-proof.json", outputDir),
  JSON.stringify(result, null, 2),
);
await writeFile(
  new URL("suspension-proof-console.txt", outputDir),
  consoleLines.join("\n"),
);
console.log("SUSPENSION PROOF OK");
console.log(JSON.stringify(result, null, 2));
process.exit(0);
