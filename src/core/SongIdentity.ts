interface SongLike {
  name?: string;
  artists?: Array<{ name?: string; uri?: string }>;
}

// Remixes and re-recordings count too: rated in any form, a song is not new to this listener
const RELEASE_WORD = `(?:remix|rmx|mix|edit|version|versao|acoustic|acustico|acustica|instrumental|karaoke|re-?recorded|regravada)`;

/** What Spotify appends to a title for a release of the same song, up to `rest` for free text. */
const versionTag = (rest: string, lead: string): string => [
  `(?:\\d{4} )?(?:digital )?remaster(?:ed)?(?: \\d{4})?(?: (?:version|edition|mix))?`,
  `(?:live|ao vivo|en vivo)\\b${rest}`,
  `(?:radio|album|single) (?:edit|version)`,
  `(?:\\d{4} )?(?:stereo|mono)(?: (?:version|mix))?`,
  `deluxe\\b${rest}`,
  `bonus track`,
  `${lead}\\b${RELEASE_WORD}\\b${rest}`
].join('|');

const CREDIT = `(?:feat\\.?|ft\\.?|featuring)`;
const INSIDE_BRACKETS = `[^)\\]]{0,120}`; // Bounded: unmatched brackets must not backtrack over the whole title
const BEFORE_DASH = `[^-–—]{0,120}`;

const DASH_TAIL = new RegExp(` [-–—] ?(?:${versionTag('.*', BEFORE_DASH)}) ?$`);
const BRACKET_TAG = new RegExp(` ?[(\\[](?:${versionTag(INSIDE_BRACKETS, INSIDE_BRACKETS)}|(?:${CREDIT}|with) ${INSIDE_BRACKETS})[)\\]]`, 'g');
const CREDIT_TAIL = new RegExp(` ${CREDIT} .*$`);

const UNNAMED_TITLES = new Set(['faixa', 'sem titulo']);
const UNNAMED_ARTIST = 'desconhecido';

/** Case, accents and compatibility forms folded. Only Latin marks go: elsewhere they tell words apart. */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/ς/g, 'σ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordsOf(text: string): string {
  return text.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/^the (?=\S)/, '');
}

function stripVersionTags(title: string): string {
  let current = title;
  for (let previous = ''; previous !== current;) {
    previous = current;
    current = current.replace(BRACKET_TAG, '').replace(DASH_TAIL, '').replace(CREDIT_TAIL, '').trim();
  }
  return current;
}

/** A title made only of tags or symbols is still a title: it keeps what it has rather than becoming empty. */
function titleIdentity(name: string): string {
  const folded = fold(name);
  return wordsOf(stripVersionTags(folded)) || wordsOf(folded) || folded;
}

export function artistIdentity(artist: { name?: string; uri?: string }): string {
  const folded = fold(artist.name ?? '');
  return wordsOf(folded) || folded || fold(artist.uri ?? '');
}

/**
 * One identity per credited artist, since Spotify orders a collaboration differently between releases.
 * Empty when the metadata cannot tell this song from another: those tracks are matched by URI only.
 */
export function songKeys(track?: SongLike | null): string[] {
  if (!track) return [];

  const title = titleIdentity(track.name ?? '');
  if (!title || UNNAMED_TITLES.has(title)) return [];

  const artists = (track.artists ?? []).map(artistIdentity).filter((artist) => artist && artist !== UNNAMED_ARTIST);
  return Array.from(new Set(artists)).map((artist) => `${title}::${artist}`);
}

/**
 * Normalized song identity (title + primary artist) so duplicate remasters/deluxe/single URIs of
 * a song the user already liked (♥) or rated with stars (★) are also excluded from recommendations.
 */
export function normalizeSongKey(track?: SongLike | null): string | null {
  const primary = track?.artists?.[0];
  return primary ? songKeys({ name: track?.name, artists: [primary] })[0] ?? null : null;
}
