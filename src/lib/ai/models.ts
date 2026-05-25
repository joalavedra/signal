import { createDeepSeek } from "@ai-sdk/deepseek";
import { wrapLanguageModel, defaultSettingsMiddleware } from "ai";

const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
});

export const MODELS = {
  AGENT: "deepseek-v4-flash",
  CHAT: "deepseek-v4-flash",

  EMAIL: "deepseek-v4-flash",

  BROWSER: "gemini-2.5-flash",
  STRUCTURED: "deepseek-v4-flash",

  LIGHT: "deepseek-v4-flash",
} as const;

// deepseek-v4-flash enables "thinking" mode by default. The agent is tool-
// driven and runs many steps per turn, so we disable thinking to keep latency
// and output-token cost down (matches the old deepseek-chat behavior).
const noThinking = defaultSettingsMiddleware({
  settings: {
    providerOptions: { deepseek: { thinking: { type: "disabled" } } },
  },
});

export const llm = (modelId: string) =>
  wrapLanguageModel({ model: deepseek(modelId), middleware: noThinking });
