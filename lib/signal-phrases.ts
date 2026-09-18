export const SIGNAL_PHRASE_PATTERNS = [
  /^[-*] .*(must not|never|must|always|required|shall|prefer|eliminate).+$/gim,
  /[.;]\s*(must not|never|must|always|required|shall).+?[.;\n]/gim,
  /\b(explicitly prefers?|not dependent on|single chokepoint|no new).+?[.;\n]/gim,
  /\b(intentional|by design|anti-pattern|permanently disabled|do not change|do not remove|do not regress)\b.+?[.;\n]/gim,
  /\b(only on|only from|only when|only in|permanent[^l]|every \d+[hm]\b).+?[.;\n]/gim,
] as const;
