/**
 * Lightweight profanity filter for guest display names entered on
 * the shared-session join modal. The goal is to block the obvious
 * obscenities and slurs people type in to be funny / abusive, not
 * to be an exhaustive moderator. Pair with a length cap and the
 * server-side participant-name sanitiser for defence in depth.
 *
 * The match strategy:
 *   1. Lowercase and strip diacritics.
 *   2. Translate common leet substitutions (0→o, 1→i, 3→e, 4→a,
 *      5→s, 7→t, $→s, @→a, !→i) so e.g. "5h1t" still matches "shit".
 *   3. Collapse all non-letter characters so "f.u.c.k" → "fuck".
 *   4. Substring-match any banned word against the collapsed form.
 *
 * Adding new entries: keep them in lowercase, alphabetised, and
 * include the root form only (the collapse step handles spacers).
 */
const BANNED: readonly string[] = [
  "anal",
  "anus",
  "arse",
  "ass",
  "asshole",
  "bastard",
  "bitch",
  "boner",
  "boob",
  "bollocks",
  "bullshit",
  "clit",
  "cock",
  "coon",
  "crap",
  "cum",
  "cunt",
  "dick",
  "dildo",
  "douche",
  "dyke",
  "fag",
  "faggot",
  "fanny",
  "fellatio",
  "fuck",
  "fucker",
  "fucking",
  "gook",
  "handjob",
  "homo",
  "jerkoff",
  "jizz",
  "kike",
  "knob",
  "kunt",
  "labia",
  "muff",
  "nazi",
  "negro",
  "nigga",
  "nigger",
  "paki",
  "pedo",
  "penis",
  "piss",
  "porn",
  "prick",
  "pussy",
  "queer",
  "rape",
  "rapist",
  "retard",
  "scrotum",
  "shit",
  "shite",
  "slut",
  "spunk",
  "tit",
  "tits",
  "twat",
  "vagina",
  "wank",
  "wanker",
  "whore",
];

const LEET_MAP: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  $: "s",
  "@": "a",
  "!": "i",
};

/**
 * Normalise a name into a comparison form used by `isProfane`.
 * Exported so the join modal can echo the normalised form back to
 * the user when explaining a rejection.
 */
export function normaliseForProfanity(input: string): string {
  const lowered = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  let out = "";
  for (const ch of lowered) {
    const mapped = LEET_MAP[ch];
    if (mapped) {
      out += mapped;
    } else if (ch >= "a" && ch <= "z") {
      out += ch;
    }
  }
  return out;
}

/**
 * Returns true if the supplied display name contains a banned root
 * after leet-normalisation and non-letter collapse.
 */
export function isProfane(input: string): boolean {
  const collapsed = normaliseForProfanity(input);
  if (!collapsed) return false;
  for (const word of BANNED) {
    if (collapsed.includes(word)) return true;
  }
  return false;
}
