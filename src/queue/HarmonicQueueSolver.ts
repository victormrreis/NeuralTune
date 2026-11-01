import { CamelotKey, camelotCost } from '../math/Camelot.ts';

export interface SolverTrack<T = unknown> {
  id: string;
  artistIds: string[];
  score: number; // s_i, comparable to the transition costs
  camelot?: CamelotKey;
  bpm?: number;
  energy?: number;
  payload: T;
}
export const SolverTrack = {};

export interface SolverOptions {
  length: number;
  artistWindow: number;
  bpmTolerance: number;
  energyTolerance: number;
  beamWidth: number;
  bpmCostWeight: number;
  energyCostWeight: number;
  unknownKeyCost: number;
  relaxedTransitionCost: number;
}
export const SolverOptions = {};

export interface SolverResult<T = unknown> {
  tracks: Array<SolverTrack<T>>;
  objective: number;
  harmonicTransitions: number;
  unknownTransitions: number;
  relaxedTransitions: number;
}
export const SolverResult = {};

const DEFAULT_OPTIONS: SolverOptions = {
  length: 30,
  artistWindow: 4,
  bpmTolerance: 0.08,
  energyTolerance: 0.25,
  beamWidth: 48,
  bpmCostWeight: 1,
  energyCostWeight: 0.5,
  unknownKeyCost: 0.15,
  relaxedTransitionCost: 0.6
};

interface Transition {
  cost: number;
  relaxed: boolean;
}

interface BeamState<T> {
  sequence: Array<SolverTrack<T>>;
  used: Set<string>;
  objective: number;
  relaxed: number;
}

/**
 * Cost of a → b, or null when a hard constraint forbids it. Absent metadata imposes no constraint: a
 * library without key data must degrade to ranking by score, not to an empty queue.
 */
export function transitionCost<T>(
  a: SolverTrack<T>,
  b: SolverTrack<T>,
  options: Partial<SolverOptions> = {},
  allowRelaxation: boolean = false
): Transition | null {
  const o = { ...DEFAULT_OPTIONS, ...options };
  let cost = 0;
  let violated = false;

  if (a.camelot && b.camelot) {
    const harmonic = camelotCost(a.camelot, b.camelot);
    if (Number.isFinite(harmonic)) cost += harmonic;
    else violated = true;
  } else {
    cost += o.unknownKeyCost;
  }

  if (a.bpm && b.bpm) {
    const drift = Math.abs(b.bpm - a.bpm) / a.bpm;
    if (drift > o.bpmTolerance) violated = true;
    else cost += o.bpmCostWeight * drift;
  }

  if (a.energy !== undefined && b.energy !== undefined) {
    const jump = Math.abs(b.energy - a.energy);
    if (jump > o.energyTolerance) violated = true;
    else cost += o.energyCostWeight * jump;
  }

  if (!violated) return { cost, relaxed: false };
  return allowRelaxation ? { cost: cost + o.relaxedTransitionCost, relaxed: true } : null;
}

function repeatsArtist<T>(sequence: Array<SolverTrack<T>>, candidate: SolverTrack<T>, window: number): boolean {
  const start = Math.max(0, sequence.length - (window - 1));
  for (let i = start; i < sequence.length; i++) {
    if (sequence[i].artistIds.some((id) => candidate.artistIds.includes(id))) return true;
  }
  return false;
}

function isComplete<T>(state: BeamState<T>, target: number): boolean {
  return state.sequence.length >= target;
}

/**
 * Beam search over partial sequences: a greedy construction that keeps `beamWidth` alternatives, so a
 * track that looks best now can lose to a path with better transitions several steps ahead. It is a
 * heuristic for the MILP: there is no optimality certificate, and with few compatible tracks a narrow
 * beam can miss the optimum. Artist spacing is never relaxed.
 */
export function solveHarmonicQueue<T>(
  pool: ReadonlyArray<SolverTrack<T>>,
  options: Partial<SolverOptions> = {}
): SolverResult<T> {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const target = Math.min(o.length, pool.length);

  const strict = runBeam(pool, o, target, false);
  const best = strict.sequence.length >= target ? strict : runBeam(pool, o, target, true);
  const chosen = best.sequence.length >= strict.sequence.length ? best : strict;

  let harmonicTransitions = 0;
  let unknownTransitions = 0;
  for (let i = 1; i < chosen.sequence.length; i++) {
    const [a, b] = [chosen.sequence[i - 1], chosen.sequence[i]];
    if (!a.camelot || !b.camelot) unknownTransitions++;
    else if (Number.isFinite(camelotCost(a.camelot, b.camelot))) harmonicTransitions++;
  }

  return {
    tracks: chosen.sequence,
    objective: chosen.objective,
    harmonicTransitions,
    unknownTransitions,
    relaxedTransitions: chosen.relaxed
  };
}

function runBeam<T>(
  pool: ReadonlyArray<SolverTrack<T>>,
  o: SolverOptions,
  target: number,
  allowRelaxation: boolean
): BeamState<T> {
  let beam: Array<BeamState<T>> = [...pool]
    .sort((a, b) => b.score - a.score)
    .slice(0, o.beamWidth)
    .map((track) => ({
      sequence: [track],
      used: new Set([track.id]),
      objective: track.score,
      relaxed: 0
    }));

  let best: BeamState<T> = beam[0] ?? { sequence: [], used: new Set(), objective: 0, relaxed: 0 };

  while (beam.length > 0 && !isComplete(beam[0], target)) {
    const next: Array<BeamState<T>> = [];

    for (const state of beam) {
      const tail = state.sequence[state.sequence.length - 1];

      for (const candidate of pool) {
        if (state.used.has(candidate.id)) continue;
        if (repeatsArtist(state.sequence, candidate, o.artistWindow)) continue;

        const transition = transitionCost(tail, candidate, o, allowRelaxation);
        if (!transition) continue;

        const used = new Set(state.used);
        used.add(candidate.id);
        next.push({
          sequence: [...state.sequence, candidate],
          used,
          objective: state.objective + candidate.score - transition.cost,
          relaxed: state.relaxed + (transition.relaxed ? 1 : 0)
        });
      }
    }

    if (next.length === 0) break;

    next.sort((a, b) => b.objective - a.objective);
    beam = next.slice(0, o.beamWidth);
    best = beam[0];
  }

  return best;
}
