declare module "openclaw/plugin-sdk/provider-model-shared" {
  import type {
    ProviderPlugin,
    ProviderRuntimeModel,
  } from "openclaw/plugin-sdk/plugin-entry";

  export type ModelCompatConfig = NonNullable<ProviderRuntimeModel["compat"]>;

  export type ModelDefinitionConfig = Omit<
    ProviderRuntimeModel,
    "provider" | "api" | "baseUrl"
  > & {
    api?: ProviderRuntimeModel["api"];
    baseUrl?: string;
  };

  export type ModelProviderConfig = {
    baseUrl: string;
    api?: ProviderRuntimeModel["api"];
    models: ModelDefinitionConfig[];
  };

  export function buildProviderReplayFamilyHooks(options: {
    family: "openai-compatible";
    dropReasoningFromHistory?: boolean;
  }): Pick<
    ProviderPlugin,
    "buildReplayPolicy" | "sanitizeReplayHistory" | "resolveReasoningOutputMode"
  >;
}

declare module "openclaw/plugin-sdk/provider-catalog-shared" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
  import type {
    ModelDefinitionConfig,
  } from "openclaw/plugin-sdk/provider-model-shared";

  export type ConfiguredProviderCatalogEntry = {
    id: string;
    name: string;
    provider: string;
    contextWindow?: number;
    reasoning?: boolean;
    input?: Array<"text" | "image" | "audio" | "video" | "document">;
  };

  export function buildManifestModelDefinition(params: {
    providerId: string;
    catalog: unknown;
    decorate?: (model: ModelDefinitionConfig) => ModelDefinitionConfig;
  }): (model: unknown) => ModelDefinitionConfig;

  export function readConfiguredProviderCatalogEntries(params: {
    config?: OpenClawConfig;
    providerId: string;
    publishedProviderId?: string;
  }): ConfiguredProviderCatalogEntry[];

  export function readManifestProviderDefaultModelRef(
    manifest: unknown,
    providerId: string,
  ): string | undefined;
}

declare module "openclaw/plugin-sdk/provider-entry" {
  import type {
    OpenClawConfig,
    OpenClawPluginDefinition,
    ProviderPlugin,
  } from "openclaw/plugin-sdk/plugin-entry";
  import type {
    ModelDefinitionConfig,
    ModelProviderConfig,
  } from "openclaw/plugin-sdk/provider-model-shared";

  type SingleProviderDefinition = Omit<
    ProviderPlugin,
    "id" | "label" | "docsPath" | "aliases" | "envVars" | "auth" | "catalog" | "staticCatalog"
  > & {
    id?: string;
    label: string;
    docsPath: string;
    aliases?: string[];
    envVars?: string[];
    manifestAuth?: {
      applyConfig?: (config: OpenClawConfig) => OpenClawConfig;
      noteTitle?: string;
      noteMessage?: string;
    };
    catalog: {
      buildProvider?: () => ModelProviderConfig;
      buildStaticProvider?: () => ModelProviderConfig;
      allowExplicitBaseUrl?: boolean;
      liveModelDiscovery?:
        | true
        | {
            timeoutMs?: number;
            ttlMs?: number;
            projectRows?: (rows: readonly unknown[]) => ModelDefinitionConfig[];
          };
    };
  };

  export function defineSingleProviderPluginEntry(options: {
    id: string;
    name: string;
    description: string;
    manifest?: unknown;
    provider?: SingleProviderDefinition;
  }): OpenClawPluginDefinition;
}

declare module "openclaw/plugin-sdk/provider-tools" {
  import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

  export function buildProviderToolCompatFamilyHooks(
    family: "deepseek" | "gemini" | "llamacpp-gbnf" | "openai",
  ): Pick<ProviderPlugin, "normalizeToolSchemas" | "inspectToolSchemas">;
}

declare module "openclaw/plugin-sdk/provider-onboard" {
  import type {
    OpenClawConfig as PluginOpenClawConfig,
    ProviderRuntimeModel,
  } from "openclaw/plugin-sdk/plugin-entry";
  import type {
    ModelDefinitionConfig,
  } from "openclaw/plugin-sdk/provider-model-shared";

  export type OpenClawConfig = PluginOpenClawConfig;

  export function createModelCatalogPresetAppliers<TArgs extends unknown[]>(params: {
    primaryModelRef: string;
    resolveParams: (
      config: PluginOpenClawConfig,
      ...args: TArgs
    ) =>
      | {
          providerId: string;
          api: ProviderRuntimeModel["api"];
          baseUrl: string;
          catalogModels: ModelDefinitionConfig[];
        }
      | null
      | undefined;
  }): {
    applyProviderConfig: (
      config: PluginOpenClawConfig,
      ...args: TArgs
    ) => PluginOpenClawConfig;
    applyConfig: (config: PluginOpenClawConfig, ...args: TArgs) => PluginOpenClawConfig;
  };

  export function resolveAgentModelPrimaryValue(value: unknown): string | undefined;
}

declare module "openclaw/plugin-sdk/agent-core" {
  import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";

  export type StreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>;
}

declare module "openclaw/plugin-sdk/llm" {
  import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";

  type StreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>;
  type AsyncFunctionResult<T> = T extends (...args: infer _Args) => infer Result
    ? Awaited<Result>
    : never;
  type EventStream = AsyncFunctionResult<StreamFn>;

  export type AssistantMessageEvent = EventStream extends AsyncIterable<infer Event>
    ? Event
    : never;

  export const streamSimple: StreamFn;
  export function createAssistantMessageEventStream(): EventStream & {
    end(result?: never): void;
  };
}
