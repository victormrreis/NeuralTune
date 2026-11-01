import { PreferenceEngine, RatedSample } from './PreferenceEngine.ts';
import { toAcousticPoint } from './AcousticVector.ts';
import { CircadianClusterPrior, SessionChangeDetector, SessionState } from './CircadianSessionController.ts';
import { ModuleFlags } from './FeatureFlags.ts';
import { AdaptivePreferencePlasticity, InteractionKind } from '../neuroscience/AdaptivePreferencePlasticity.ts';
import { TasteForInformation, fitTasteForInformation, predictFromInformation } from '../neuroscience/AuditoryPredictiveCodingEngine.ts';
import { PlayEvent, TrackMetadata, TrackRatingRecord } from '../types/index.ts';

const REWARD: Record<number, number> = { 0: -1, 1: -0.6, 2: -0.3, 3: 0, 4: 0.5, 5: 1 };

export const DEFAULT_ARTIST_WEIGHT = 0.3;
const WEIGHT_PLASTICITY = 0.15;
const WEIGHT_INFORMATION = 0.1;
const WEIGHT_CIRCADIAN = 0.12;
const WEIGHT_SESSION = 0.1;

const COMPLETE_RATIO = 0.85;
const EARLY_SKIP_MS = 25_000;

export interface ContextTerm {
  key: 'artist' | 'plasticity' | 'information' | 'circadian' | 'session';
  value: number;
}
export const ContextTerm = {};

/**
 * z_t = f(H_t, C_t, A_t) kept as small, separately switchable terms added to the stored score, rather
 * than one trained model: with a few hundred ratings nothing larger could be fitted honestly.
 */
export class NeuralContextModel {
  private preference: PreferenceEngine;
  private flags: ModuleFlags;
  private plasticity = new AdaptivePreferencePlasticity();
  // Same evidence plus the "more/less like this" signals, kept apart so an experiment can compare both
  private carried = new AdaptivePreferencePlasticity();
  private prior = new CircadianClusterPrior();
  private session = new SessionState();
  private detector = new SessionChangeDetector();
  private taste: TasteForInformation | null = null;
  private means = { surprise: 0, uncertainty: 0 };
  private artistRatings = new Map<string, { total: number; n: number }>();
  private artistWeight: number;

  constructor(preference: PreferenceEngine, flags: ModuleFlags, artistWeight: number = DEFAULT_ARTIST_WEIGHT) {
    this.preference = preference;
    this.flags = flags;
    this.artistWeight = artistWeight;
  }

  setFlags(flags: ModuleFlags): void {
    this.flags = flags;
  }

  getFlags(): ModuleFlags {
    return this.flags;
  }

  getTaste(): TasteForInformation | null {
    return this.taste;
  }

  fit(ratings: readonly TrackRatingRecord[], plays: readonly PlayEvent[] = []): void {
    const samples = this.preference.getRatedSamples();
    this.fitInformation(samples);

    const observations: Array<{ cluster: number; timestamp: number }> = [];
    for (const sample of samples) {
      if (sample.rating >= 4) {
        const cluster = this.preference.clusterOf(sample.point);
        if (cluster !== null) observations.push({ cluster, timestamp: sample.timestamp });
      }
    }
    this.prior.fit(observations);

    this.plasticity = new AdaptivePreferencePlasticity();
    this.carried = new AdaptivePreferencePlasticity();
    this.artistRatings.clear();
    const timeline: Array<{ timestamp: number; apply: () => void }> = [];

    for (const record of ratings) {
      timeline.push({ timestamp: record.timestamp, apply: () => this.observeRating(record) });
    }
    for (const event of plays) {
      timeline.push({ timestamp: event.startedAt, apply: () => this.feedPlay(event) });
    }
    timeline.sort((a, b) => a.timestamp - b.timestamp);
    for (const { apply } of timeline) apply();
  }

  private fitInformation(samples: readonly RatedSample[]): void {
    const rows = samples.flatMap(({ features, rating }) => {
      const { harmonicSurprise, harmonicUncertainty } = features?.predictive ?? {};
      return typeof harmonicSurprise === 'number' && typeof harmonicUncertainty === 'number'
        ? [{ surprise: harmonicSurprise, uncertainty: harmonicUncertainty, reward: REWARD[rating] ?? 0 }]
        : [];
    });

    this.taste = fitTasteForInformation(rows);
    const n = rows.length || 1;
    this.means = {
      surprise: rows.reduce((sum, r) => sum + r.surprise, 0) / n,
      uncertainty: rows.reduce((sum, r) => sum + r.uncertainty, 0) / n
    };
  }

  observeRating(record: TrackRatingRecord): void {
    for (const artist of record.metadata.artists) {
      const entry = this.artistRatings.get(artist.uri) ?? { total: 0, n: 0 };
      entry.total += record.rating;
      entry.n++;
      this.artistRatings.set(artist.uri, entry);

      const rated = { kind: 'rating' as const, key: artist.uri, timestamp: record.timestamp, rating: record.rating };
      this.plasticity.observe(rated);
      this.carried.observe(rated);
    }
  }

  private feedPlay(event: PlayEvent): void {
    const ratio = event.durationMs ? event.playedMs / event.durationMs : 0;
    let kind: InteractionKind = 'partial-listen';
    if (ratio >= COMPLETE_RATIO) kind = 'complete-listen';
    else if (event.skipped && event.playedMs < EARLY_SKIP_MS) kind = 'early-skip';

    for (const artist of event.artistUris) {
      // History from before origins were recorded stays voluntary: nothing says otherwise
      const heard = { kind, key: artist, timestamp: event.startedAt, voluntary: (event.origin ?? 'organic') === 'organic' };
      this.plasticity.observe(heard);
      this.carried.observe(heard);
      if (event.feedback) {
        this.carried.observe({ kind: event.feedback === 'mais' ? 'steer-more' : 'steer-less', key: artist, timestamp: event.startedAt });
      }
    }
  }

  /** Live feedback: updates traces and the session state, and may pivot away from the active cluster. */
  observePlay(event: PlayEvent, track: TrackMetadata | null, expected: number): boolean {
    this.feedPlay(event);

    const point = track ? toAcousticPoint(track.acousticFeatures) : null;
    const cluster = point ? this.preference.clusterOf(point) : null;
    const ratio = event.durationMs ? Math.min(1, event.playedMs / event.durationMs) : 0.5;

    if (cluster !== null && ratio >= COMPLETE_RATIO) this.session.reinforce(cluster);

    if (!this.flags.circadian || !this.detector.update(expected, ratio)) return false;

    const active = this.session.active();
    if (active !== null) this.session.pivot(active);
    return true;
  }

  terms(track: TrackMetadata, date: Date, carryFeedback: boolean = false): ContextTerm[] {
    const terms: ContextTerm[] = [];
    const now = date.getTime();
    const features = track.acousticFeatures;

    // Mean rating of the artist, shrunk towards 3★ by 2 pseudo-ratings. On the real ratings this plain
    // statistic ranked better than every acoustic signal, so it is a first-class term
    const known = track.artists.flatMap((artist) => this.artistRatings.get(artist.uri) ?? []);
    if (this.artistWeight > 0 && known.length > 0) {
      const mean = known.reduce((sum, entry) => sum + (entry.total + 6) / (entry.n + 2), 0) / known.length;
      terms.push({ key: 'artist', value: this.artistWeight * ((mean - 3) / 2) });
    }

    if (this.flags.plasticity) {
      const traces = carryFeedback ? this.carried : this.plasticity;
      const values = track.artists.map((artist) => traces.affinity(artist.uri, now)).filter((v) => v !== 0);
      if (values.length > 0) {
        terms.push({ key: 'plasticity', value: WEIGHT_PLASTICITY * Math.max(...values.map(Math.abs)) * Math.sign(values[0]) });
      }
    }

    const { harmonicSurprise, harmonicUncertainty } = features?.predictive ?? {};
    if (this.flags.predictive && this.taste?.supported && typeof harmonicSurprise === 'number' && typeof harmonicUncertainty === 'number') {
      const x = harmonicSurprise - this.means.surprise;
      const y = harmonicUncertainty - this.means.uncertainty;
      const predicted = predictFromInformation(this.taste, x, y);
      terms.push({ key: 'information', value: WEIGHT_INFORMATION * Math.max(-1, Math.min(1, predicted)) });
    }

    const point = toAcousticPoint(features);
    const cluster = point ? this.preference.clusterOf(point) : null;
    if (cluster !== null) {
      if (this.flags.circadian) {
        const posterior = this.prior.posterior(date).get(cluster);
        if (posterior !== undefined) terms.push({ key: 'circadian', value: WEIGHT_CIRCADIAN * (posterior - 0.5) });

        const sessionShare = this.session.distribution().get(cluster);
        if (sessionShare !== undefined) terms.push({ key: 'session', value: WEIGHT_SESSION * (sessionShare - 0.5) });
      }
    }

    return terms;
  }

  adjustment(track: TrackMetadata, date: Date, carryFeedback: boolean = false): number {
    return this.terms(track, date, carryFeedback).reduce((sum, term) => sum + term.value, 0);
  }
}
