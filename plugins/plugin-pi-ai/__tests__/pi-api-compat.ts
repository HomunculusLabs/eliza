/**
 * Compile-only coverage pins every Pi 0.84.1 root and provider-subpath API used
 * by the package foundation; dependency upgrades must satisfy this fixture.
 */
import {
  type AnthropicOptions,
  type Api,
  type ApiStreamOptions,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type AuthContext,
  type AuthOperationOptions,
  type Context,
  type CreateModelsOptions,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  createModels,
  type ImageContent,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsRequestTransforms,
  type MutableModels,
  type OpenAIResponsesOptions,
  type Provider,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolResultMessage,
  type Usage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

class CompileOnlyCredentialStore implements CredentialStore {
  async read(
    _providerId: string,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return undefined;
  }

  async list(
    _options?: AuthOperationOptions,
  ): Promise<readonly CredentialInfo[]> {
    return [];
  }

  async modify(
    _providerId: string,
    _modify: (
      current: Credential | undefined,
    ) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return undefined;
  }

  async delete(
    _providerId: string,
    _options?: AuthOperationOptions,
  ): Promise<void> {}
}

const authContext: AuthContext = {
  async env(_name: string): Promise<undefined> {
    return undefined;
  },
  async fileExists(_path: string): Promise<false> {
    return false;
  },
};
const options: CreateModelsOptions = {
  credentials: new CompileOnlyCredentialStore(),
  authContext,
};
const mutableModels: MutableModels = createModels(options);
const models: Models = mutableModels;
const openai: Provider<"openai-responses"> = openaiProvider();
const anthropic: Provider<"anthropic-messages"> = anthropicProvider();

type OpenAIOptions = ApiStreamOptions<"openai-responses">;
type AnthropicStreamOptions = ApiStreamOptions<"anthropic-messages">;
type UsedApiSurface =
  | AnthropicOptions
  | AnthropicStreamOptions
  | Api
  | AssistantMessageEvent
  | AssistantMessageEventStream
  | Context
  | Model<"openai-responses">
  | ModelsApiStreamOptions<Api>
  | ModelsRequestTransforms
  | ImageContent
  | OpenAIOptions
  | OpenAIResponsesOptions
  | TextContent
  | ThinkingContent
  | Tool
  | ToolResultMessage
  | Usage
  | UserMessage;

void models;
void openai;
void anthropic;
declare const usedApiSurface: UsedApiSurface;
void usedApiSurface;
