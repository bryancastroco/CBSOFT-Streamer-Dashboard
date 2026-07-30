import { NO_READABLE_COMMENTS, NO_SIGNIFICANT_FINDINGS } from "@/lib/ai/contract";

/**
 * Mocked Anthropic responses.
 *
 * The provider is reached through the abstraction in `lib/ai/provider.ts`, so
 * these are the *analysis objects* it returns rather than raw SDK message
 * payloads — the SDK's own wire format is its concern, not this application's.
 *
 * `API_KEY_PLACEHOLDER` is not a credential and matches no real key format.
 */

export const API_KEY_PLACEHOLDER = "test-anthropic-key";

/** A well-formed analysis with findings in every category. */
export const RICH_ANALYSIS = {
  summary: "Viewers enjoyed the gameplay but the audio dropped out twice during the stream.",
  sentiment: "mixed" as const,
  positive_points: ["Great clutch plays", "Friendly chat moderation"],
  concerns: ["Audio dropped twice", "Frame drops during the final fight"],
  suggestions: ["Test the microphone before going live"],
  questions: ["What is the sensitivity setting?"],
  urgent_issues: ["A viewer says their stream key appeared on screen"],
};

/**
 * A valid analysis with nothing to report.
 *
 * Note the placeholder in every list rather than an empty array — that is the
 * shape the prompt asks the model for, and the shape the presentation layer has
 * to recognise as *absence*. A test that used `[]` here would never exercise the
 * placeholder handling.
 */
export const EMPTY_FINDINGS_ANALYSIS = {
  summary: "Chat was quiet and mostly greetings.",
  sentiment: "neutral" as const,
  positive_points: [NO_SIGNIFICANT_FINDINGS],
  concerns: [NO_SIGNIFICANT_FINDINGS],
  suggestions: [NO_SIGNIFICANT_FINDINGS],
  questions: [NO_SIGNIFICANT_FINDINGS],
  urgent_issues: [NO_SIGNIFICANT_FINDINGS],
};

/** What the model is asked to produce when nothing was analysable. */
export const NO_READABLE_ANALYSIS = {
  summary: NO_READABLE_COMMENTS,
  sentiment: "no_comments" as const,
  positive_points: [NO_SIGNIFICANT_FINDINGS],
  concerns: [NO_SIGNIFICANT_FINDINGS],
  suggestions: [NO_SIGNIFICANT_FINDINGS],
  questions: [NO_SIGNIFICANT_FINDINGS],
  urgent_issues: [NO_SIGNIFICANT_FINDINGS],
};

// ---------------------------------------------------------------------------
// Malformed responses
// ---------------------------------------------------------------------------

/**
 * Responses that must be rejected by the Zod contract.
 *
 * A structured-output request makes these unlikely, not impossible: a provider
 * can refuse, truncate at max_tokens mid-object, or return a sentiment value
 * from a newer enum. Each has to become a `failed` summary rather than a
 * malformed row.
 */
export const MALFORMED_RESPONSES: { label: string; value: unknown }[] = [
  { label: "not an object", value: "the chat seemed happy" },
  { label: "null", value: null },
  { label: "missing summary", value: { ...RICH_ANALYSIS, summary: undefined } },
  { label: "unknown sentiment", value: { ...RICH_ANALYSIS, sentiment: "euphoric" } },
  { label: "findings as a string", value: { ...RICH_ANALYSIS, concerns: "audio dropped" } },
  { label: "findings containing a number", value: { ...RICH_ANALYSIS, questions: [42] } },
  { label: "empty summary", value: { ...RICH_ANALYSIS, summary: "" } },
];

/**
 * A summary that names a person.
 *
 * The prompt forbids this, and the model is reliable about it — but "the model
 * was told not to" is not a control. Used to assert that nothing downstream
 * *depends* on names being absent from the summary text, since the real
 * guarantee is that no commenter identity is ever collected in the first place.
 */
export const ANALYSIS_MENTIONING_A_NAME = {
  ...RICH_ANALYSIS,
  summary: "One viewer, Alex Morgan, complained about the audio.",
};

/** A provider that returns whatever it is given, for injecting into the service. */
export function stubProvider(result: unknown) {
  return {
    name: "anthropic-stub",
    model: "claude-opus-5-stub",
    analyze: async () => result,
  };
}
