import type {
  ExtensionAPI,
  ThinkingLevel,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

import { join } from "node:path";

interface SavedConfig {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export default function rememberModelAndThinking(pi: ExtensionAPI) {
  const stateFile = join(getAgentDir(), "last-model.json");

  let lastConfig: SavedConfig | undefined;
  let restoring = false;

  function save() {
    if (!lastConfig) return;

    try {
      writeFileSync(
        stateFile,
        JSON.stringify(lastConfig, null, 2) + "\n",
        "utf-8",
      );
    } catch {
      // non bloccare Pi
    }
  }

  if (existsSync(stateFile)) {
    try {
      lastConfig = JSON.parse(
        readFileSync(stateFile, "utf-8"),
      ) as SavedConfig;
    } catch {
      // ignora stato non valido
    }
  }

  pi.on("model_select", async (event) => {
    if (restoring || event.source === "restore") {
      return;
    }

    lastConfig = {
      provider: event.model.provider,
      model: event.model.id,
      thinkingLevel: pi.getThinkingLevel(),
    };

    save();
  });

  pi.on("thinking_level_select", async (event) => {
    if (restoring || !lastConfig) {
      return;
    }

    lastConfig.thinkingLevel = event.level;
    save();
  });

  pi.on("session_start", async (event, ctx) => {
    if (!lastConfig) {
      return;
    }

    // Apply the saved choice to new sessions, including a fresh startup.
    // Existing, resumed, forked, and reloaded sessions keep their own model.
    const isFreshStartup =
      event.reason === "startup" &&
      !ctx.sessionManager.getEntries().some((entry) => entry.type === "message");

    if (event.reason !== "new" && !isFreshStartup) {
      return;
    }

    const model = ctx.modelRegistry.find(
      lastConfig.provider,
      lastConfig.model,
    );

    if (!model) {
      ctx.ui.notify(
        `Modello non trovato: ${lastConfig.provider}/${lastConfig.model}`,
        "warning",
      );
      return;
    }

    restoring = true;

    try {
      const ok = await pi.setModel(model);

      if (!ok) {
        ctx.ui.notify(
          `Impossibile usare ${lastConfig.provider}/${lastConfig.model}`,
          "warning",
        );
        return;
      }

      pi.setThinkingLevel(lastConfig.thinkingLevel);
    } finally {
      restoring = false;
    }
  });
}