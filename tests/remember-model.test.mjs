/**
 * Dependency-free tests for pi-remember-model.
 *
 * Run with:  node --test tests/remember-model.test.mjs
 * (Node >= 22.6 for native TypeScript type-stripping; no compiler, no loader
 * package, no new dependency.)
 *
 * The extension is imported as real TypeScript (Node strips the types). A tiny
 * `module.register()` resolve hook maps the bare specifier
 * `@earendil-works/pi-coding-agent` to the Pi install that already provides it
 * at runtime, so nothing is added to the repository. Each case points
 * `PI_CODING_AGENT_DIR` at a throwaway directory, so the real
 * `~/.pi/agent/last-model.json` is never read or written.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { register } from "node:module";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** Locate the real Pi package without assuming a fixed install path. */
function findPiPackage() {
  const candidates = [];
  // Global npm/npx install used by this machine.
  candidates.push(
    "C:/Users/carlorfeo/AppData/Roaming/npm/node_modules",
    join(process.env.APPDATA ?? "", "npm", "node_modules"),
  );
  // Ask the pi binary's own resolution if available.
  try {
    const req = createRequire(import.meta.url);
    candidates.push(dirname(req.resolve(PI_PACKAGE)));
  } catch {
    // not resolvable from here; keep looking
  }
  for (const base of candidates) {
    if (!base) continue;
    const direct = join(base, ...PI_PACKAGE.split("/"));
    if (existsSync(join(direct, "package.json"))) return direct;
  }
  // Fall back to a global root reported by npm.
  return undefined;
}

const piDir = findPiPackage();
if (!piDir) {
  throw new Error(
    `Could not locate ${PI_PACKAGE}. Install it (pi provides it at runtime) before running tests.`,
  );
}

let extModule;

before(async () => {
  // Resolve hook: map the bare Pi specifier to the real install.
  const hookSource = `
    export async function resolve(specifier, context, next) {
      if (specifier === ${JSON.stringify(PI_PACKAGE)}) {
        return next(${JSON.stringify(
          pathToFileURL(join(piDir, "dist", "index.js")).href,
        )}, context);
      }
      return next(specifier, context);
    }
  `;
  const hookUrl =
    "data:text/javascript;base64," + Buffer.from(hookSource).toString("base64");
  register(hookUrl);

  extModule = await import(
    new URL("../extensions/remember-model.ts", import.meta.url).href
  );
});

/**
 * Install the extension against a throwaway agent dir and a controllable
 * process.argv. Returns the captured `session_start` handler and spies.
 */
function loadExtension({ argv, state }) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-remember-model-"));
  mkdirSync(agentDir, { recursive: true });
  const stateFile = join(agentDir, "last-model.json");
  if (state !== undefined) {
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf-8");
  }

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.argv = argv;

  const setModelCalls = [];
  const setThinkingCalls = [];
  let sessionStart;

  const pi = {
    getThinkingLevel: () => "off",
    setModel: async (model) => {
      setModelCalls.push(model);
      return true;
    },
    setThinkingLevel: (level) => setThinkingCalls.push(level),
    on: (event, handler) => {
      if (event === "session_start") sessionStart = handler;
    },
  };

  extModule.default(pi);

  return {
    stateFile,
    setModelCalls,
    setThinkingCalls,
    callSessionStart: (event, ctx) => {
      // The handler reads process.argv at call time to detect CLI flags.
      const previous = process.argv;
      process.argv = argv;
      try {
        return sessionStart(event, ctx);
      } finally {
        process.argv = previous;
      }
    },
  };
}

const REMEMBERED = {
  provider: "openai-codex",
  model: "gpt-6-sol",
  thinkingLevel: "off",
};

function model(provider, id) {
  return { provider, id };
}

function makeCtx({ current, registryModel, entries = [] } = {}) {
  const notifications = [];
  return {
    notifications,
    ctx: {
      getModel: () => current,
      sessionManager: { getEntries: () => entries },
      modelRegistry: { find: () => registryModel ?? null },
      ui: { notify: (msg, kind) => notifications.push({ msg, kind }) },
    },
  };
}

test("(a) explicit different current model => remembered NOT applied", async () => {
  const ext = loadExtension({
    argv: ["node", "pi", "--model", "deepseek/deepseek-flash"],
    state: REMEMBERED,
  });
  const { ctx } = makeCtx({
    current: model("deepseek", "deepseek-flash"),
    registryModel: model("openai-codex", "gpt-6-sol"),
  });

  await ext.callSessionStart({ reason: "startup" }, ctx);

  assert.equal(ext.setModelCalls.length, 0, "setModel must not be called");
  assert.equal(ext.setThinkingCalls.length, 0);
});

test("(b) fresh session, no explicit difference => remembered applied", async () => {
  const ext = loadExtension({ argv: ["node", "pi"], state: REMEMBERED });
  const remembered = model("openai-codex", "gpt-6-sol");
  const { ctx } = makeCtx({ current: undefined, registryModel: remembered });

  await ext.callSessionStart({ reason: "startup" }, ctx);

  assert.equal(ext.setModelCalls.length, 1, "setModel must be called once");
  assert.equal(ext.setModelCalls[0], remembered);
  assert.equal(ext.setThinkingCalls.length, 1);
  assert.equal(ext.setThinkingCalls[0], "off");
});

test("(b2) plain startup where fallback default == remembered => applied", async () => {
  const ext = loadExtension({ argv: ["node", "pi"], state: REMEMBERED });
  const remembered = model("openai-codex", "gpt-6-sol");
  const { ctx } = makeCtx({ current: remembered, registryModel: remembered });

  await ext.callSessionStart({ reason: "startup" }, ctx);

  assert.equal(ext.setModelCalls.length, 1);
});

test("(b3) explicit flag resolving to the remembered model => not overridden", async () => {
  const ext = loadExtension({
    argv: ["node", "pi", "--model", "openai-codex/gpt-6-sol"],
    state: REMEMBERED,
  });
  const remembered = model("openai-codex", "gpt-6-sol");
  const { ctx } = makeCtx({ current: remembered, registryModel: remembered });

  await ext.callSessionStart({ reason: "startup" }, ctx);

  assert.equal(ext.setModelCalls.length, 0, "explicit flag wins even if identical");
});

test("(c) resumed session => untouched", async () => {
  const ext = loadExtension({ argv: ["node", "pi"], state: REMEMBERED });
  const remembered = model("openai-codex", "gpt-6-sol");
  const { ctx } = makeCtx({
    current: model("deepseek", "deepseek-flash"),
    registryModel: remembered,
  });

  await ext.callSessionStart({ reason: "resume" }, ctx);

  assert.equal(ext.setModelCalls.length, 0);
});

test("(c2) forked session => untouched", async () => {
  const ext = loadExtension({ argv: ["node", "pi"], state: REMEMBERED });
  const remembered = model("openai-codex", "gpt-6-sol");
  const { ctx } = makeCtx({ current: undefined, registryModel: remembered });

  await ext.callSessionStart({ reason: "fork" }, ctx);

  assert.equal(ext.setModelCalls.length, 0);
});

test("(c3) reloaded session => untouched", async () => {
  const ext = loadExtension({ argv: ["node", "pi"], state: REMEMBERED });
  const remembered = model("openai-codex", "gpt-6-sol");
  const { ctx } = makeCtx({ current: undefined, registryModel: remembered });

  await ext.callSessionStart({ reason: "reload" }, ctx);

  assert.equal(ext.setModelCalls.length, 0);
});

test("(c4) startup with existing messages => untouched", async () => {
  const ext = loadExtension({ argv: ["node", "pi"], state: REMEMBERED });
  const remembered = model("openai-codex", "gpt-6-sol");
  const { ctx } = makeCtx({
    current: undefined,
    registryModel: remembered,
    entries: [{ type: "message" }],
  });

  await ext.callSessionStart({ reason: "startup" }, ctx);

  assert.equal(ext.setModelCalls.length, 0);
});

test("(d) remembered model absent from registry => warning, no crash", async () => {
  const ext = loadExtension({ argv: ["node", "pi"], state: REMEMBERED });
  const { ctx, notifications } = makeCtx({ current: undefined, registryModel: null });

  await ext.callSessionStart({ reason: "startup" }, ctx);

  assert.equal(ext.setModelCalls.length, 0);
  assert.equal(notifications.length, 1, "one warning expected");
  assert.equal(notifications[0].kind, "warning");
  assert.match(notifications[0].msg, /openai-codex\/gpt-6-sol/);
});

test("(d2) new session in existing process => remembered applied (flag only guards startup)", async () => {
  const ext = loadExtension({
    argv: ["node", "pi", "--model", "deepseek/deepseek-flash"],
    state: REMEMBERED,
  });
  const remembered = model("openai-codex", "gpt-6-sol");
  const { ctx } = makeCtx({
    current: model("deepseek", "deepseek-flash"),
    registryModel: remembered,
  });

  await ext.callSessionStart({ reason: "new" }, ctx);

  assert.equal(ext.setModelCalls.length, 1, "new session still restores remembered model");
});

test("(e) no state file => handler is a no-op", async () => {
  const ext = loadExtension({ argv: ["node", "pi"], state: undefined });
  const { ctx } = makeCtx({ current: undefined, registryModel: model("openai-codex", "gpt-6-sol") });

  await ext.callSessionStart({ reason: "startup" }, ctx);

  assert.equal(ext.setModelCalls.length, 0);
});

test("(f) setModel returning false => warning, no crash", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-remember-model-"));
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "last-model.json"),
    JSON.stringify(REMEMBERED) + "\n",
    "utf-8",
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  let sessionStart;
  extModule.default({
    getThinkingLevel: () => "off",
    setModel: async () => false,
    setThinkingLevel: () => {},
    on: (event, handler) => {
      if (event === "session_start") sessionStart = handler;
    },
  });

  const remembered = model("openai-codex", "gpt-6-sol");
  const { ctx, notifications } = makeCtx({ current: undefined, registryModel: remembered });

  await sessionStart({ reason: "startup" }, ctx);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, "warning");
});
