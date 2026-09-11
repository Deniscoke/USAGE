/**
 * Personal instructions: what this person always wants the assistant to know.
 *
 * The nearest honest thing to the "projects" idea a hosted chat offers. It is
 * bounded text, stored in the reader's own browser, sent with each message and
 * appended to the server's system prompt in a clearly labelled section.
 *
 * The distinction that matters: the browser still cannot REPLACE the system
 * message, only add a preference block inside it, introduced as the user's own
 * words. So a page that was tampered with can change the assistant's tone; it
 * cannot dissolve the rules the server set, and it can never touch what USAGE
 * measures, prices or rewards -- none of which the model has any say in.
 */

export const PREFERENCES_KEY = "usage.chat.preferences.v1";
export const MAX_PREFERENCES_CHARS = 1_000;

/** The preference block, or null when there is nothing worth adding. */
export function preferenceSection(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, MAX_PREFERENCES_CHARS);
  if (!trimmed) return null;
  return [
    "",
    "THE USER'S OWN STANDING INSTRUCTIONS",
    "The lines below were written by the user about how they want to be helped.",
    "Honour them where they do not conflict with the rules above; the rules above win.",
    "---",
    trimmed,
    "---",
  ].join("\n");
}

export function systemPromptWith(base: string, preferences: unknown): string {
  const section = preferenceSection(preferences);
  return section ? `${base}\n${section}` : base;
}
