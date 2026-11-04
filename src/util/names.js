// Name checks shared by bookings, the profile and the tools. A US hotel matches the name on the booking against the
// guest's ID at the desk, so a guest needs a first and a last name, and titles or stand-in words are not names.

// One part of a name (a first or a last name): letters, marks, spaces, hyphens, apostrophes and periods.
const PART_RE = /^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]{0,39}$/u;
// A full name: the same characters, 3–60 of them.
const FULL_RE = /^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]{2,59}$/u;
const HONORIFIC_RE = /^(?:mr|mrs|ms|miss|mx|dr|prof|sir|madam|mister|mrs?s|mme|mlle)\.?$/i;
const PLACEHOLDER_WORDS = new Set([
  'test', 'tester', 'testing', 'guest', 'user', 'name', 'firstname', 'lastname', 'first', 'last', 'me', 'myself', 'self',
  'n/a', 'na', 'none', 'nobody', 'anonymous', 'anon', 'unknown', 'customer', 'traveler', 'traveller', 'someone', 'somebody',
  'xxx', 'abc', 'asdf', 'qwerty', 'foo', 'bar', 'sample', 'example', 'placeholder', 'tbd',
]);
const PLACEHOLDER_NAMES = new Set([
  'my wife', 'my husband', 'my mom', 'my dad', 'my friend', 'my partner', 'my son', 'my daughter', 'my kid', 'my kids',
  'wife', 'husband', 'mom', 'dad', 'mother', 'father', 'friend', 'partner', 'kid', 'child', 'son', 'daughter',
  'john doe', 'jane doe', 'first last', 'first name', 'last name', 'full name',
]);

function words(s) {
  return s.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Collapses spaces: '  Sarah   Miller ' → 'Sarah Miller'. */
export function cleanName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * A guest's full name: 'format' (not 3–60 letters), 'placeholder' ('Mr. Smith', 'Guest', 'test', 'my wife'),
 * 'incomplete' (one word: no last name), or null when usable.
 */
export function guestNameProblem(name) {
  const s = cleanName(name);
  if (!FULL_RE.test(s)) return 'format';
  const w = words(s);
  if (PLACEHOLDER_NAMES.has(w.join(' ')) || w.some((x) => PLACEHOLDER_WORDS.has(x.replace(/[.'’]/g, ''))) || HONORIFIC_RE.test(w[0])) return 'placeholder';
  if (w.length < 2) return 'incomplete';
  return null;
}

export function isValidGuestName(name) {
  return guestNameProblem(name) === null;
}

/** One part of a name (the profile's first or last name): 'format', 'placeholder' or null. */
export function namePartProblem(part) {
  const s = cleanName(part);
  if (!PART_RE.test(s)) return 'format';
  const w = words(s);
  if (w.some((x) => PLACEHOLDER_WORDS.has(x.replace(/[.'’]/g, ''))) || (w.length === 1 && HONORIFIC_RE.test(w[0]))) return 'placeholder';
  return null;
}

/** 'Sarah Jane Miller' → { firstName: 'Sarah', lastName: 'Jane Miller' } (first word, then the rest). */
export function splitFullName(name) {
  const s = cleanName(name);
  const at = s.indexOf(' ');
  return at === -1 ? { firstName: s, lastName: '' } : { firstName: s.slice(0, at), lastName: s.slice(at + 1) };
}

/** { firstName, lastName } → 'Sarah Miller' ('' when neither is set). */
export function fullName(p) {
  return [cleanName(p?.firstName), cleanName(p?.lastName)].filter(Boolean).join(' ');
}

/**
 * How the hotel's console shows a guest: first name and last initial ('Sarah Miller' → 'Sarah M.',
 * 'Mary Ann van der Berg' → 'Mary B.', 'Cher' → 'Cher').
 */
export function maskedGuestName(name) {
  const w = cleanName(name).split(' ').filter(Boolean);
  if (!w.length) return 'Guest';
  const first = w[0].slice(0, 20);
  if (w.length === 1) return first;
  const lastWord = w[w.length - 1];
  const initial = Array.from(lastWord.replace(/^[^\p{L}]+/u, ''))[0];
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}
