/**
 * Loads only Pi's OpenAI provider subpath when a runtime initializes the gateway.
 */
import type { Provider } from "@earendil-works/pi-ai";

export async function loadOpenAIProvider(): Promise<
  Provider<"openai-responses">
> {
  const { openaiProvider } = await import(
    "@earendil-works/pi-ai/providers/openai"
  );
  return openaiProvider();
}
