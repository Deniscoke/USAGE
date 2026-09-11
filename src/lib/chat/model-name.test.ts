import { describe, expect, it } from "vitest";
import { humaniseModel } from "./model-name";

/**
 * The menu says a name; everything that matters still uses the id.
 */

describe("humaniseModel", () => {
  it("writes the models this deployment actually prices", () => {
    expect(humaniseModel("anthropic/claude-sonnet-4.6")).toBe("Anthropic Claude Sonnet 4.6");
    expect(humaniseModel("anthropic/claude-opus-5")).toBe("Anthropic Claude Opus 5");
    expect(humaniseModel("anthropic/claude-haiku-4.5")).toBe("Anthropic Claude Haiku 4.5");
    expect(humaniseModel("openai/gpt-5.4")).toBe("OpenAI GPT 5.4");
    expect(humaniseModel("openai/gpt-5-nano")).toBe("OpenAI GPT 5 Nano");
  });

  it("does not repeat a vendor the name already carries", () => {
    expect(humaniseModel("mistralai/mistral-large")).toBe("Mistral Large");
    expect(humaniseModel("qwen/qwen-2.5-72b")).toBe("Qwen 2.5 72b");
  });

  it("shows a variant as a variant", () => {
    expect(humaniseModel("liquid/lfm-2.5-2.6b:free")).toBe("Liquid Lfm 2.5 2.6b (free)");
  });

  it("keeps version numbers exactly as they were", () => {
    expect(humaniseModel("anthropic/claude-3-haiku")).toBe("Anthropic Claude 3 Haiku");
    expect(humaniseModel("openai/gpt-4o-mini-2024-07-18")).toBe("OpenAI GPT 4o Mini 2024 07 18");
  });

  it("copes with an id that has no vendor, and never returns nothing", () => {
    expect(humaniseModel("some-local-model")).toBe("Some Local Model");
    expect(humaniseModel("")).toBe("");
    expect(humaniseModel("   ")).toBe("   ");
  });
});
