import { canonicalPlate } from './plate';

/**
 * "Is this camera reading probably the same physical plate as that one?"
 *
 * WHY THIS EXISTS
 * ---------------
 * Every plate lookup in this app is an EXACT match on the canonical plate, which
 * is correct for billing but brutal on a deny-by-default lane: a camera that reads
 * A11 as A1 leaves a paid-up resident sitting at a boom that will not lift, because
 * no pass matches. One character of OCR error and the entitlement is invisible.
 *
 * WHAT THIS IS NOT
 * ----------------
 * NOT general-purpose OCR correction, and it must never be used to decide what a
 * plate IS. It only ever answers "could these two strings be the same plate?", and
 * only ever against a SMALL CLOSED SET — the site's own active passes. That closed
 * set is what makes it safe: guessing among a few dozen known plates is a very
 * different problem from correcting an arbitrary string.
 *
 * DELIBERATELY STRICT
 * -------------------
 * At most ONE difference, and a substitution only counts when the two characters
 * are ones ANPR genuinely confuses. A single free substitution would make A11 and
 * A12 "the same plate", which is two different cars. So:
 *
 *   A11 vs A11   → exact
 *   A11 vs A1I   → confusable-char   (1 and I)
 *   A11 vs A1    → missing-char      (camera dropped one)
 *   A11 vs A111  → extra-char        (camera invented one)
 *   A11 vs A12   → null              (different plate)
 *   A11 vs B22   → null
 */

/**
 * Characters an ANPR engine actually mixes up, grouped by what they look like.
 *
 * Kept deliberately short and conventional. Every addition widens what counts as
 * "the same plate", and the cost of being wrong is admitting a car that should
 * have been refused — so a pair earns its place only if the confusion is real in
 * the fonts on actual plates.
 */
const CONFUSABLE_GROUPS = ['0OQD', '1IL', '2Z', '5S', '6G', '8B'];

/** char → the group it belongs to, for O(1) lookup. */
const CONFUSABLE_LOOKUP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const group of CONFUSABLE_GROUPS) {
    for (const character of group) map[character] = group;
  }
  return map;
})();

/** True when a camera could plausibly report `a` where the plate really said `b`. */
function charactersConfusable(a: string, b: string): boolean {
  if (a === b) return true;
  const group = CONFUSABLE_LOOKUP[a];
  return !!group && group.includes(b);
}

/**
 * How two readings differ, or null when they are not plausibly the same plate.
 *
 * `exact` is included so callers can use one code path and still tell a real match
 * from a guess — the distinction belongs in the audit trail.
 */
export type PlateMatchKind = 'exact' | 'confusable-char' | 'missing-char' | 'extra-char';

/** Is `shorter` exactly `longer` with a single character removed? */
function isOneDeletionAway(shorter: string, longer: string): boolean {
  let shortIndex = 0;
  let skipped = false;
  for (let longIndex = 0; longIndex < longer.length; longIndex++) {
    if (shortIndex < shorter.length && shorter[shortIndex] === longer[longIndex]) {
      shortIndex++;
      continue;
    }
    // Second mismatch — more than one character apart.
    if (skipped) return false;
    skipped = true;
  }
  return shortIndex === shorter.length;
}

/**
 * Compare a camera reading against a known plate.
 *
 * Both sides are canonicalised first, so separator and case differences never
 * reach the comparison — those are not near misses, they are the same plate.
 */
export function comparePlates(read: string, known: string): PlateMatchKind | null {
  const a = canonicalPlate(read);
  const b = canonicalPlate(known);

  if (!a || !b) return null;
  if (a === b) return 'exact';

  // Guard against fuzzy-matching trivially short strings, where one edit is most
  // of the plate. Measured on the LONGER side on purpose: keying it off the
  // shorter one rejected "A1" vs "A11" — a dropped trailing character, which is
  // the single most common real misread and the whole reason this exists.
  if (Math.max(a.length, b.length) < 3) return null;

  if (a.length === b.length) {
    let differences = 0;
    let confusableEverywhere = true;
    for (let index = 0; index < a.length; index++) {
      if (a[index] === b[index]) continue;
      differences++;
      if (differences > 1) return null;
      if (!charactersConfusable(a[index], b[index])) confusableEverywhere = false;
    }
    return differences === 1 && confusableEverywhere ? 'confusable-char' : null;
  }

  if (a.length + 1 === b.length) {
    // The reading is SHORTER: the camera dropped a character.
    return isOneDeletionAway(a, b) ? 'missing-char' : null;
  }

  if (a.length === b.length + 1) {
    // The reading is LONGER: the camera invented one (a bolt, a shadow, a frame).
    return isOneDeletionAway(b, a) ? 'extra-char' : null;
  }

  return null;
}

/** One candidate that a reading could plausibly refer to. */
export interface PlateNearMatch<T> {
  candidate: T;
  plate: string;
  kind: PlateMatchKind;
}

/**
 * The single candidate a reading plausibly refers to, or null.
 *
 * AMBIGUITY IS A REFUSAL, NOT A COIN FLIP. If a reading is one character from two
 * different known plates we cannot tell which car is at the barrier, and admitting
 * the wrong one would credit the wrong holder's quota and put the wrong plate on
 * the stay. Returning null makes the gate fall back to its normal refusal, which
 * an operator can then resolve by hand.
 *
 * An `exact` match always wins outright and is never treated as ambiguous — that
 * is a real plate, not a guess, even if some other plate is one character away.
 */
export function findSingleNearMatch<T>(
  read: string,
  candidates: T[],
  plateOf: (candidate: T) => string,
): PlateNearMatch<T> | null {
  const matches: PlateNearMatch<T>[] = [];

  for (const candidate of candidates) {
    const plate = canonicalPlate(plateOf(candidate));
    const kind = comparePlates(read, plate);
    if (!kind) continue;
    if (kind === 'exact') return { candidate, plate, kind };
    matches.push({ candidate, plate, kind });
  }

  if (!matches.length) return null;

  // Several rows can legitimately point at ONE plate (two passes on the same car).
  // That is not ambiguity about which car is here, so collapse by plate first and
  // only refuse when two genuinely different plates remain in contention.
  const distinctPlates = new Set(matches.map((match) => match.plate));
  if (distinctPlates.size > 1) return null;

  return matches[0];
}
