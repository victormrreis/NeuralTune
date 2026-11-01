import { ACOUSTIC_DIMENSIONS, AcousticDimension, POPULATION_MEAN } from '../core/AcousticVector.ts';
import { RadioParameters } from '../types/index.ts';

export interface ParsedRadio {
  params: RadioParameters;
  target: Partial<Record<AcousticDimension, number>>;
  targetVector: number[] | null; // Raw [0, 1] space; dimensions not mentioned stay at the prior
  explorationFactor: number | null;
  nostalgiaOnly: boolean;
  avoidRepeats: boolean;
  strictHarmonic: boolean;
  matched: string[];
}
export const ParsedRadio = {};

interface Rule {
  terms: string[];
  label: string;
  apply: (radio: ParsedRadio) => void;
}

function clampTarget(radio: ParsedRadio, dimension: AcousticDimension, value: number): void {
  radio.target[dimension] = value;
}

const NEGATIONS = new Set(['sem', 'nao', 'no', 'without', 'not', 'nada', 'evitar', 'avoid']);

const RULES: Rule[] = [
  { terms: ['alta energia', 'high energy', 'pesado', 'pesada', 'pesadas', 'heavy', 'intenso', 'intensa', 'agitado', 'agitada', 'energetico', 'energetica', 'treino', 'academia', 'workout', 'gym'], label: 'energia alta', apply: (r) => { r.params.minEnergy = 0.7; clampTarget(r, 'energy', 0.85); } },
  { terms: ['baixa energia', 'low energy', 'calmo', 'calma', 'calmas', 'tranquilo', 'tranquila', 'relax', 'relaxar', 'relaxante', 'suave', 'suaves', 'chill', 'calm', 'soft', 'dormir', 'sleep'], label: 'energia baixa', apply: (r) => { r.params.maxEnergy = 0.45; clampTarget(r, 'energy', 0.25); } },
  { terms: ['energia media', 'moderado', 'moderada', 'medium energy'], label: 'energia média', apply: (r) => { r.params.minEnergy = 0.35; r.params.maxEnergy = 0.7; clampTarget(r, 'energy', 0.5); } },
  { terms: ['rapido', 'rapida', 'rapidas', 'rapidos', 'acelerado', 'acelerada', 'fast', 'uptempo'], label: 'andamento rápido', apply: (r) => { r.params.minBpm = 125; clampTarget(r, 'tempo', 0.75); } },
  { terms: ['lento', 'lenta', 'lentas', 'lentos', 'slow', 'devagar', 'downtempo'], label: 'andamento lento', apply: (r) => { r.params.maxBpm = 100; clampTarget(r, 'tempo', 0.25); } },
  { terms: ['feliz', 'alegre', 'alegres', 'animado', 'animada', 'animadas', 'happy', 'upbeat', 'positivo', 'positiva', 'bom humor'], label: 'humor alegre', apply: (r) => { r.params.minValence = 0.5; clampTarget(r, 'valence', 0.8); } },
  { terms: ['triste', 'tristes', 'melancolico', 'melancolica', 'melancolicas', 'sad', 'melancholic', 'sombrio', 'sombria', 'dark', 'fossa'], label: 'humor melancólico', apply: (r) => { r.params.maxValence = 0.45; clampTarget(r, 'valence', 0.2); } },
  { terms: ['dancante', 'dancantes', 'danca', 'dancar', 'dance', 'danceable', 'festa', 'balada', 'party'], label: 'dançante', apply: (r) => { clampTarget(r, 'danceability', 0.85); } },
  { terms: ['acustico', 'acustica', 'acusticas', 'acustic', 'acoustic', 'unplugged', 'violao'], label: 'acústico', apply: (r) => { clampTarget(r, 'acousticness', 0.85); } },
  { terms: ['eletronico', 'eletronica', 'eletronicas', 'electronic', 'synth', 'edm'], label: 'eletrônico', apply: (r) => { clampTarget(r, 'acousticness', 0.1); } },
  { terms: ['instrumental', 'instrumentais', 'sem vocal', 'sem vocais', 'sem voz', 'sem letra', 'no vocals', 'without vocals'], label: 'instrumental', apply: (r) => { r.params.instrumentalOnly = true; clampTarget(r, 'instrumentalness', 0.85); } },
  { terms: ['vocal', 'vocais', 'cantada', 'cantadas', 'vocals', 'com voz', 'com letra'], label: 'vocal', apply: (r) => { r.params.vocalOnly = true; clampTarget(r, 'instrumentalness', 0.05); } },
  { terms: ['ao vivo', 'live', 'show', 'concerto'], label: 'ao vivo', apply: (r) => { clampTarget(r, 'liveness', 0.8); } },
  { terms: ['foco', 'focar', 'concentracao', 'concentrar', 'estudo', 'estudar', 'trabalho', 'trabalhar', 'focus', 'study', 'work', 'noturno', 'noturna', 'night'], label: 'foco', apply: (r) => { r.explorationFactor ??= 0.1; } },
  { terms: ['descoberta', 'descobertas', 'descobrir', 'novidade', 'novidades', 'novas', 'discover', 'discovery', 'explorar', 'explore'], label: 'exploração', apply: (r) => { r.explorationFactor = 0.8; } },
  { terms: ['redescoberta', 'redescobertas', 'redescobrir', 'nostalgia', 'nostalgica', 'nostalgico', 'joias esquecidas', 'antigas favoritas', 'rediscover', 'forgotten'], label: 'nostalgia', apply: (r) => { r.nostalgiaOnly = true; } },
  { terms: ['sem repetir', 'sem repetidas', 'sem repeticao', 'sem musicas repetidas', 'no repeats', 'without repeats', 'nao repetir'], label: 'sem repetição', apply: (r) => { r.avoidRepeats = true; } },
  { terms: ['mixagem harmonica', 'harmonica', 'harmonico', 'camelot', 'dj', 'dj set', 'harmonic'], label: 'mixagem harmônica', apply: (r) => { r.strictHarmonic = true; } }
];

// A phrase containing a negation must be tried before the negation logic reads it as "no X"
const ORDERED_TERMS = RULES
  .flatMap((rule) => rule.terms.map((term) => ({ term, rule })))
  .sort((a, b) => b.term.length - a.term.length);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9/\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEras(text: string, params: RadioParameters): string | null {
  const years: number[] = [];

  for (const match of text.matchAll(/\b(?:anos|decada de|years|the)?\s?((?:19|20)?\d0)s?\b/g)) {
    const raw = match[1];
    const hasContext = /anos|decada|years|the/.test(match[0]) || /s\b/.test(match[0]) || raw.length === 4;
    if (!hasContext) continue;

    const two = Number(raw);
    const decade = raw.length === 4 ? two : two >= 50 ? 1900 + two : 2000 + two;
    if (decade >= 1950 && decade <= 2030) years.push(decade);
  }

  // "90/2000" carries the second decade after a slash, with no marker of its own
  if (/\b(?:anos|decada de)\s?\d0\/(\d{2,4})\b/.test(text)) {
    const raw = /\/(\d{2,4})\b/.exec(text)![1];
    const value = Number(raw);
    years.push(raw.length === 4 ? value : value >= 50 ? 1900 + value : 2000 + value);
  }

  if (years.length === 0) return null;

  params.eraStart = Math.min(...years);
  params.eraEnd = Math.max(...years) + 9;
  return `${params.eraStart} a ${params.eraEnd}`;
}

/** The token before the phrase. "sem foco" must not enable focus. */
function isNegated(text: string, position: number): boolean {
  const before = text.slice(0, position).trim().split(' ');
  const last = before[before.length - 1];
  return NEGATIONS.has(last);
}

/**
 * Deterministic lexicon for PT-BR and EN, no model and no network. It reads the descriptors it knows
 * and ignores the rest: `matched` says what was understood, so the interface can show it.
 */
export function parseRadioPrompt(prompt: string): ParsedRadio {
  const radio: ParsedRadio = {
    params: {},
    target: {},
    targetVector: null,
    explorationFactor: null,
    nostalgiaOnly: false,
    avoidRepeats: false,
    strictHarmonic: false,
    matched: []
  };

  let text = ` ${normalize(prompt)} `;

  for (const { term, rule } of ORDERED_TERMS) {
    const pattern = new RegExp(`(?<=\\s)${term.replace(/[-/]/g, '\\$&')}(?=\\s)`);
    let match = pattern.exec(text);

    while (match) {
      const negatedPhrase = term.split(' ').some((word) => NEGATIONS.has(word));
      if (negatedPhrase || !isNegated(text, match.index)) {
        rule.apply(radio);
        if (!radio.matched.includes(rule.label)) radio.matched.push(rule.label);
      }
      text = `${text.slice(0, match.index)}${' '.repeat(term.length)}${text.slice(match.index + term.length)}`;
      match = pattern.exec(text);
    }
  }

  const era = parseEras(normalize(prompt), radio.params);
  if (era) radio.matched.push(`época ${era}`);

  if (radio.explorationFactor !== null) radio.params.explorationFactor = radio.explorationFactor;

  if (Object.keys(radio.target).length > 0) {
    radio.targetVector = ACOUSTIC_DIMENSIONS.map((dimension, i) => radio.target[dimension] ?? POPULATION_MEAN[i]);
  }

  return radio;
}
