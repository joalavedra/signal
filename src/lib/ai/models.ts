import { createDeepSeek } from "@ai-sdk/deepseek";

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

export const llm = deepseek;
