/**
 * A model id, written the way a person would say it.
 *
 * `anthropic/claude-sonnet-4.6` is an identifier, not a name, and a menu full
 * of identifiers reads as a configuration file. The id itself is never lost --
 * it is what gets sent, what the receipt shows and what the price list is
 * keyed on -- this is only what the menu says.
 *
 * Conservative on purpose: it title-cases words and fixes the handful of
 * acronyms that would otherwise look wrong. Anything it does not recognise
 * keeps its own shape rather than being mangled into something confident and
 * incorrect.
 */

const ACRONYMS: Record<string, string> = {
  gpt: "GPT",
  llm: "LLM",
  ai: "AI",
  xai: "xAI",
  openai: "OpenAI",
  o1: "o1",
  o3: "o3",
  o4: "o4",
};

const VENDORS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "meta-llama": "Meta",
  mistralai: "Mistral",
  mistral: "Mistral",
  xai: "xAI",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  cohere: "Cohere",
  nvidia: "NVIDIA",
};

export function humaniseModel(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return id;

  const slash = trimmed.indexOf("/");
  const vendorSlug = slash === -1 ? null : trimmed.slice(0, slash).toLowerCase();
  const rest = slash === -1 ? trimmed : trimmed.slice(slash + 1);

  // A suffix like `:free` or `:beta` is a variant, not part of the name.
  const [base, variant] = splitVariant(rest);
  const name = base
    .split(/[-_]/)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(" ");

  const vendor = vendorSlug ? (VENDORS[vendorSlug] ?? titleCaseWord(vendorSlug)) : null;
  // Only prefix the vendor when the name does not already say it.
  const withVendor = vendor && !name.toLowerCase().startsWith(vendor.toLowerCase()) ? `${vendor} ${name}` : name;
  return variant ? `${withVendor} (${variant})` : withVendor;
}

function splitVariant(value: string): [string, string | null] {
  const colon = value.indexOf(":");
  if (colon === -1) return [value, null];
  return [value.slice(0, colon), value.slice(colon + 1).replace(/[-_]/g, " ") || null];
}

function titleCaseWord(word: string): string {
  const lower = word.toLowerCase();
  if (ACRONYMS[lower]) return ACRONYMS[lower];
  // A version number keeps exactly what it was: 4.6, 3.5, 20241022.
  if (/^[\d.]+$/.test(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}
