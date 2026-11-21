// Members' own provider keys (`15-implementation-plan/03-agents-and-research.md`
// K4, ADR-23): the providers, their names, and the format check the client
// runs before sending and the server runs before anything else. The messages
// are the members mockup's (`session-web-members.html`, the `key:` form).

/** The providers a member may add a key for, one key each. */
export const API_KEY_PROVIDERS = ["anthropic", "openai"] as const;

export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

/** `valid` once the provider accepted the key while it was saved; `invalid`
 * once a run found it rejected (`03` K4, E5). */
export type ApiKeyStatus = "valid" | "invalid";

export interface ApiKeyProviderInfo {
  /** Product copy: "Anthropic", "OpenAI". */
  name: string;
  /** Every key of the provider starts with this. */
  prefix: string;
  /** The field's placeholder hint. */
  placeholder: string;
}

export const API_KEY_PROVIDER_INFO: Readonly<Record<ApiKeyProvider, ApiKeyProviderInfo>> = {
  anthropic: { name: "Anthropic", prefix: "sk-ant-", placeholder: "sk-ant-..." },
  openai: { name: "OpenAI", prefix: "sk-", placeholder: "sk-..." },
};

/** The shortest key either provider issues, as the mockup checks it. */
export const API_KEY_MIN_LENGTH = 24;

/** The longest key accepted; nothing either provider issues comes close. */
export const API_KEY_MAX_LENGTH = 512;

/** Why `raw` cannot be a key of `provider`, in the mockup's words, or null
 * when its format is right. `raw` is checked as given; callers trim it. */
export function apiKeyFormatError(provider: ApiKeyProvider, raw: string): string | null {
  const info = API_KEY_PROVIDER_INFO[provider];
  if (raw === "") return "Paste a key.";
  if (provider === "openai" && raw.startsWith(API_KEY_PROVIDER_INFO.anthropic.prefix)) {
    return "That looks like an Anthropic key. Add it under Anthropic.";
  }
  if (
    !raw.startsWith(info.prefix) ||
    raw.length < API_KEY_MIN_LENGTH ||
    raw.length > API_KEY_MAX_LENGTH ||
    /\s/.test(raw)
  ) {
    return `${info.name} keys start with ${info.prefix} and are longer than this. Copy the whole key from your ${info.name} account.`;
  }
  return null;
}

/** The refusal when the provider rejects the key during the check. */
export function apiKeyRejectedMessage(provider: ApiKeyProvider): string {
  return `That key was rejected by ${API_KEY_PROVIDER_INFO[provider].name}.`;
}

/** The refusal when the provider could not be reached in time. */
export function apiKeyUnreachableMessage(provider: ApiKeyProvider): string {
  return `Couldn't reach ${API_KEY_PROVIDER_INFO[provider].name} to check the key. Try again.`;
}
