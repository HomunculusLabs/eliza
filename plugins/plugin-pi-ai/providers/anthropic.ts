/**
 * Loads only Pi's Anthropic provider subpath when a runtime initializes the gateway.
 */
import type { Provider } from "@earendil-works/pi-ai";

export async function loadAnthropicProvider(): Promise<
  Provider<"anthropic-messages">
> {
  const { anthropicProvider } = await import(
    "@earendil-works/pi-ai/providers/anthropic"
  );
  return anthropicProvider();
}
