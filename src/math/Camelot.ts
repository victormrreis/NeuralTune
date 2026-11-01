export const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export type CamelotMode = 'A' | 'B'; // A = minor, B = major

export interface CamelotKey {
  number: number; // 1 to 12
  letter: CamelotMode;
}
export const CamelotKey = {};

const WHEEL_SIZE = 12;

/** Spotify's convention: mode 1 = major, 0 = minor. C major = 8B, A minor = 8A. */
export function toCamelot(pitchClass: number, mode: number): CamelotKey {
  // A minor shares the wheel number of C major, three semitones above it
  const major = mode === 1 ? pitchClass : (pitchClass + 3) % WHEEL_SIZE;
  const fifths = (major * 7) % WHEEL_SIZE;
  return { number: ((fifths + 7) % WHEEL_SIZE) + 1, letter: mode === 1 ? 'B' : 'A' };
}

export function formatCamelot(key: CamelotKey): string {
  return `${key.number}${key.letter}`;
}

export function parseCamelot(value: string): CamelotKey | null {
  const match = /^(1[0-2]|[1-9])([AB])$/.exec(value);
  return match ? { number: Number(match[1]), letter: match[2] as CamelotMode } : null;
}

/** Signed step on the wheel, in (-6, 6]. */
function wheelStep(a: CamelotKey, b: CamelotKey): number {
  const delta = (b.number - a.number + WHEEL_SIZE) % WHEEL_SIZE;
  return delta > WHEEL_SIZE / 2 ? delta - WHEEL_SIZE : delta;
}

/**
 * ΔKey ∈ {0, ±1} (mod 12) inside one ring, or the relative key on the other ring. Mode alternation
 * keeps the number: allowing it from any number would make every pair of keys compatible.
 */
export function isCamelotCompatible(a: CamelotKey, b: CamelotKey): boolean {
  if (a.letter === b.letter) return Math.abs(wheelStep(a, b)) <= 1;
  return a.number === b.number;
}

/** 0 for the same key, then the conventional order of a DJ's preference. Infinite when incompatible. */
export function camelotCost(a: CamelotKey, b: CamelotKey): number {
  if (!isCamelotCompatible(a, b)) return Number.POSITIVE_INFINITY;
  if (a.letter !== b.letter) return 0.08;
  return a.number === b.number ? 0 : 0.05;
}

function keyIndex(key: CamelotKey): number {
  return (key.number - 1) * 2 + (key.letter === 'B' ? 1 : 0);
}

/** C = (I₁₂ + P + Pᵀ) ⊗ I₂ + I₁₂ ⊗ X over the 24 keys, indexed as 1A, 1B, 2A, ... 12B. */
export function camelotAdjacencyMatrix(): number[][] {
  const keys: CamelotKey[] = [];
  for (let number = 1; number <= WHEEL_SIZE; number++) {
    keys.push({ number, letter: 'A' }, { number, letter: 'B' });
  }

  const matrix = keys.map(() => new Array<number>(keys.length).fill(0));
  for (const a of keys) {
    for (const b of keys) {
      if (isCamelotCompatible(a, b)) matrix[keyIndex(a)][keyIndex(b)] = 1;
    }
  }
  return matrix;
}
