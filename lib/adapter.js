/**
 * The pi-ai adapter that makes the shim look like a model provider to DSH.
 *
 * The profile object here is not free-form: `PiAiAdapter.current()` reads
 * `piProvider` to build the model collection, and `modelOf()` dereferences
 * `profile.modelErrors` for every request. A profile missing those throws on
 * the first turn with a misleading error, so the shape is reproduced faithfully
 * rather than approximated.
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { bridgeOptionsImages } from './image-bridge.js'

export const ACCIO_PROVIDER = 'accio'
export const ACCIO_DISPLAY_NAME = 'Accio'

/**
 * Conservative context window for a catalog row that states none. A row without
 * a window would otherwise fail the whole provider route with
 * `INVALID_MODEL_CONTEXT`, which is a worse outcome than a modest default.
 */
const FALLBACK_CONTEXT_WINDOW = 200_000

/** Idle timeout for the streamed response, matching the other connectors. */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * The adapter does not own a pi-ai credential lifecycle, but `createModels()`
 * requires an auth object. Every method is deliberately inert: the shim's bearer
 * token is supplied per request through `resolveApiKey` instead.
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return [] },
    async modify() { throw new Error('dsh-connect-accio has no pi-ai credential lifecycle') },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() { return false },
  },
}

/**
 * Describe one catalog entry in pi-ai's model shape.
 *
 * The field names are pi-ai's, not DSH's: the model descriptor carries `input`
 * (an array of modalities), a required `cost`, and a required `maxTokens`.
 * `PiAiAdapter.listModels` spreads `model.input` directly, so a descriptor
 * missing it throws `model.input is not iterable` before any request is made.
 *
 * RC1: keep the upstream `multimodal` flag so DSH's picker allows attaching a
 * picture to a model that claims to understand one. Image blocks are rewritten
 * by `bridgeOptionsImages()` into short text markers before pi-ai's checks; the
 * shim turns those markers into real `inlineData` parts, so pixels do reach the
 * gateway. See ./image-bridge.js for the wire contract and its limits. */
export function toPiModel(model, baseUrl, providerId) {
  const input = model.multimodal === true ? ['text', 'image'] : ['text']
  const reasoning = Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0
  return {
    id: model.id,
    name: model.name || model.id,
    provider: providerId,
    api: 'openai-completions',
    baseUrl: `${baseUrl}/v1`,
    reasoning,
    input,
    contextWindow: typeof model.contextWindow === 'number' && model.contextWindow > 0
      ? model.contextWindow
      : FALLBACK_CONTEXT_WINDOW,
    maxTokens: typeof model.maxTokens === 'number' && model.maxTokens > 0
      ? model.maxTokens
      : Math.min(32_768, typeof model.contextWindow === 'number' && model.contextWindow > 0 ? model.contextWindow : FALLBACK_CONTEXT_WINDOW),
    // Accio does not bill per token through this route, and a zeroed cost keeps
    // DSH's usage display from inventing a price. ALL FOUR rates are required:
    // pi-ai reads `cacheRead`/`cacheWrite` unconditionally, and omitting them
    // fails request construction with a bare "reading 'length'" TypeError.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsReasoningEffort: reasoning },
  }
}

/**
 * Build the adapter.
 *
 * @param options.shim - the loopback shim (`baseUrl()`, `token()`).
 * @param options.catalog - `{ current(): ModelInfo[] }`.
 */
export function createAccioAdapter(options) {
  const providerId = options.provider ?? ACCIO_PROVIDER
  const providerName = options.displayName ?? ACCIO_DISPLAY_NAME

  const buildModels = () => options.catalog.current().map((m) => toPiModel(m, options.shim.baseUrl(), providerId))

  const makeProfile = () => {
    const provider = {
      ...createProvider({
        id: providerId,
        name: providerName,
        auth: {
          apiKey: {
            name: 'Accio loopback secret',
            async resolve({ credential }) {
              const key = credential?.key
              return key === undefined || key.length === 0
                ? undefined
                : { auth: { apiKey: key }, source: 'Accio loopback' }
            },
          },
        },
        // Evaluated HERE, inside makeProfile: createProvider captures the models
        // array it is handed, so a provider built once at setup time would serve
        // that first snapshot forever — a catalog refresh would update the
        // discovery reply while the picker kept the stale names and order.
        models: buildModels(),
        api: openAICompletionsApi(),
      }),
      getModels: () => buildModels(),
    }

    return {
      provider,
      profile: {
        provider: providerId,
        displayName: providerName,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        configuredMaxTokens: new Map(),
        // Read unconditionally by `modelOf()`; must exist even when empty.
        modelErrors: new Map(),
        defaultContextWindow: FALLBACK_CONTEXT_WINDOW,
        piProvider: provider,
      },
    }
  }

  // A NEW Map AND a NEW provider each time. The adapter memoizes its snapshot by
  // the profiles object's identity, so rebuilding the Map alone is not enough:
  // the piProvider inside it must be rebuilt too, because pi-ai derives the
  // picker's models from `catalog.models` captured at provider-construction
  // time, not from a later getModels() call.
  const makeProfiles = () => {
    const { profile } = makeProfile()
    return new Map([[providerId, profile]])
  }

  let profiles = makeProfiles()

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => options.shim.token(),
  })

  // pi-ai throws `UNSUPPORTED_CONTENT` when a message contains an `image`
  // block but the adapter has no durable attachment service. Rewriting first
  // keeps every request on the text path; the shim expands the marker back
  // into a Gemini `inlineData` part. Both `stream()` and `resolveModel().stream`
  // funnel through this one method, so one override covers every path.
  const baseStream = adapter.streamWithSnapshot.bind(adapter)
  adapter.streamWithSnapshot = (options, snapshot) => baseStream(bridgeOptionsImages(options), snapshot)

  return {
    adapter,
    /** Rebuild the profile map after the catalog changes. */
    invalidate() {
      profiles = makeProfiles()
    },
  }
}

// Image-block rewriting lives in ./image-bridge.js (pure, unit-testable).
