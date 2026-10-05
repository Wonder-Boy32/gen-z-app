/**
 * contentFilter — screens user text before it is published.
 *
 * WHY THIS EXISTS
 *
 * App Store Guideline 1.2 requires apps with user-generated content to include
 * "a method for filtering objectionable material". Gen Z already had reporting,
 * blocking, moderator roles and an admin queue — everything EXCEPT automated
 * screening at the point of entry. Until now every piece of objectionable content
 * had to reach a moderator before anything happened, which is after the harm.
 * The February 2026 revision also puts apps with RANDOM OR ANONYMOUS chat
 * explicitly under 1.2, which covers the anonymous inbox.
 *
 * HONEST LIMITS — read before trusting it
 *
 * 1. This runs on the CLIENT and is therefore BYPASSABLE. Anyone who wants to
 *    get past it can. It is a speed bump that stops the ordinary case and
 *    satisfies the "method of filtering" requirement; it is NOT a substitute for
 *    the report queue, the block list, or a human moderator.
 * 2. It matches whole words after normalisation, which trades recall for
 *    precision on purpose. A naive substring match blocks "Scunthorpe"; a
 *    genuine miss is caught by the report queue, whereas a false positive on
 *    someone's hometown is unrecoverable. That imbalance is the reason for the
 *    choice, not an oversight.
 * 3. It is English-only. The app is used in Nigeria and elsewhere; a filter that
 *    pretends to cover languages it does not know would be worse than one that
 *    says so.
 */

export type ScreenResult = { ok: true } | { ok: false; reason: string };

/**
 * Default blocked terms: common English profanity only.
 *
 * Kept deliberately SHORT and MILD. Severe terms — slurs, threats, sexual
 * content involving minors — are NOT something to guess at from a code
 * reviewer's general knowledge: they are jurisdiction- and community-specific,
 * and getting them wrong is worse than leaving them out. Add yours in
 * SEVERE_TERMS below. The mechanism is what this file delivers; the list is a
 * policy decision that belongs to the app's owner.
 */
const DEFAULT_TERMS = [
  'fuck',
  'shit',
  'bitch',
  'bastard',
  'asshole',
  'dick',
  'cunt',
  'whore',
  'slut',
  'retard',
];

/**
 * ADD YOUR SEVERE TERMS HERE (slurs, threats, CSAM-adjacent phrases).
 *
 * Leave this empty until you have chosen them deliberately. These are treated
 * exactly like DEFAULT_TERMS, but keeping them separate means the community-
 * specific policy is visible in one place instead of buried in a general list.
 */
const SEVERE_TERMS: string[] = [];

const ALL_TERMS = [...DEFAULT_TERMS, ...SEVERE_TERMS];

/**
 * Fold the many ways people dodge a naive filter into one comparable form:
 * case, accents, leet digits, zero-width joiners, and stretched letters.
 *
 * De-duplication only collapses runs of THREE or more, so legitimate double
 * letters survive — "ass" is not rewritten to "as", which would corrupt the word
 * we are actually trying to match.
 */
function normalise(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[\u200b-\u200d\ufeff]/g, '') // strip zero-width characters
    .replace(/[@4]/g, 'a')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/0/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/7/g, 't')
    .replace(/(.)\1{2,}/g, '$1'); // "baaad" -> "bad"
}

/** Word-ish tokens, so a match cannot land in the middle of another word. */
function tokens(input: string): string[] {
  return normalise(input)
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/**
 * Screen a piece of user text.
 *
 * Returns `{ ok: false, reason }` with a message safe to show the user — it
 * never echoes the matched term back, because repeating it in an error is its
 * own small harm.
 */
export function screenText(input: string | null | undefined): ScreenResult {
  if (!input) return { ok: true };

  const words = tokens(input);
  const blocked = new Set(ALL_TERMS.map(normalise));

  for (const w of words) {
    if (blocked.has(w)) {
      return {
        ok: false,
        reason:
          "That wording isn't allowed here. Please rephrase and try again — Gen Z keeps things respectful.",
      };
    }
  }

  return { ok: true };
}

/**
 * Convenience wrapper for call sites that render an inline error.
 * Returns null when the text passes, or the reason when it does not.
 */
export function screenTextError(input: string | null | undefined): string | null {
  const r = screenText(input);
  return r.ok ? null : r.reason;
}
