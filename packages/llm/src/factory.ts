import { AIProviderError, getLogger, type AIMigrationRequest, type AIMigrationResponse, type AIProvider, type CapibaraConfig } from "@capibara/shared";
import { FireworksAIProvider } from "./fireworks-provider.js";

const logger = getLogger("ai-factory");

/**
 * Provider used when no API key is configured.
 *
 * It fails loudly instead of returning a plausible-looking empty result, so a
 * deployment without AI credentials cannot silently degrade into "the AI said
 * there was nothing to do". The pipeline checks `enabled` and skips the fallback
 * stage entirely rather than calling this.
 */
export class DisabledAIProvider implements AIProvider {
  readonly name = "ai-disabled";
  readonly isReal = false;
  readonly enabled = false;

  async suggestMigration(_request: AIMigrationRequest): Promise<AIMigrationResponse> {
    throw new AIProviderError("AI fallback is disabled because no provider is configured", {
      code: "AI_NOT_CONFIGURED",
      publicMessage: "AI-assisted migration is not enabled."
    });
  }
}

/**
 * Deterministic in-memory provider for demo mode and tests.
 *
 * It applies a fixed rename table to the excerpt. It never reaches the network, and
 * its output goes through exactly the same validation as a real provider's.
 */
export class DemoAIProvider implements AIProvider {
  readonly name = "ai-demo";
  readonly isReal = false;
  readonly enabled = true;

  constructor(private readonly renames: ReadonlyMap<string, string> = new Map()) {}

  async suggestMigration(request: AIMigrationRequest): Promise<AIMigrationResponse> {
    const edits = [];
    for (const [from, to] of this.renames) {
      if (request.excerpt.includes(from)) {
        edits.push({ search: from, replace: to, reason: `demo rename ${from} -> ${to}` });
      }
    }
    return { edits, confidence: edits.length > 0 ? 0.5 : 0, model: "demo" };
  }
}

export function createAIProvider(config: CapibaraConfig): AIProvider {
  if (config.demoMode) {
    logger.info("using demo AI provider", { reason: "CAPIBARA_MODE=demo" });
    return new DemoAIProvider();
  }
  if (!config.ai.enabled) {
    logger.warn("AI fallback disabled: FIREWORKS_API_KEY is not set; migrations will be deterministic only");
    return new DisabledAIProvider();
  }
  logger.info("using Fireworks AI provider", { model: config.ai.model, timeoutMs: config.ai.timeoutMs });
  return new FireworksAIProvider(config.ai);
}
