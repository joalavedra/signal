import { createDeepSeek } from "@ai-sdk/deepseek";

const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
});

export const MODELS = {
  AGENT: "deepseek-chat",
  CHAT: "deepseek-chat",

  EMAIL: "deepseek-chat",

  BROWSER: "gemini-2.0-flash-exp",
  STRUCTURED: "deepseek-chat",

  LIGHT: "deepseek-chat",
} as const;

export const llm = deepseek;
