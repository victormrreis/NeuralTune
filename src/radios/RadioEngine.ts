import { PreferenceEngine } from '../core/PreferenceEngine.ts';
import { BlacklistManager } from '../core/BlacklistManager.ts';
import { TrackMetadata, RadioParameters, PredictionResult } from '../types/index.ts';

export type RadioContextType = 'preference' | 'discovery' | 'gym' | 'work' | 'study' | 'relax' | 'night' | 'custom';

export class RadioEngine {
  private preference: PreferenceEngine;
  private blacklist: BlacklistManager;

  constructor(preference: PreferenceEngine, blacklist: BlacklistManager) {
    this.preference = preference;
    this.blacklist = blacklist;
  }

  /**
   * Generates a curated, pre-filtered sequence according to context presets or custom parameters.
   */
  generateRadio(
    candidates: TrackMetadata[],
    contextType: RadioContextType,
    customParams?: RadioParameters
  ): {
    tracks: TrackMetadata[];
    predictions: PredictionResult[];
    unfilteredCount: number;
    discardedCount: number;
    activeFiltersDescription: string[];
  } {
    const filters = this.resolveContextFilters(contextType, customParams);
    const activeFiltersDescription: string[] = [];
    const predictions: PredictionResult[] = [];
    const validTracks: TrackMetadata[] = [];
    let discardedCount = 0;

    if (filters.minEnergy !== undefined || filters.maxEnergy !== undefined) {
      activeFiltersDescription.push(`Energia entre ${filters.minEnergy ?? 0} e ${filters.maxEnergy ?? 1}`);
    }
    if (filters.minBpm !== undefined || filters.maxBpm !== undefined) {
      activeFiltersDescription.push(`BPM entre ${filters.minBpm ?? 0} e ${filters.maxBpm ?? 250}`);
    }
    if (filters.instrumentalOnly) {
      activeFiltersDescription.push('Exclusivamente instrumental');
    }
    if (filters.genres && filters.genres.length > 0) {
      activeFiltersDescription.push(`Gêneros: ${filters.genres.join(', ')}`);
    }
    if (filters.eraStart !== undefined || filters.eraEnd !== undefined) {
      activeFiltersDescription.push(`Época: ${filters.eraStart ?? 1900} a ${filters.eraEnd ?? 2030}`);
    }

    for (const track of candidates) {
      // 1. Blacklist check
      if (this.blacklist.isBlockedFast(track.uri, track.artists.map((a) => a.uri))) {
        discardedCount++;
        continue;
      }

      // 2. Contextual Acoustic and Parametric Filter Checks
      if (!this.matchesFilters(track, filters)) {
        discardedCount++;
        continue;
      }

      // 3. Evaluate with Preference Engine
      const evalResult = this.preference.evaluateCandidate(track);
      if (!evalResult.eligible) {
        discardedCount++;
        continue;
      }

      // 4. Discovery mode weighting
      if (contextType === 'discovery') {
        const explorationWeight = filters.explorationFactor ?? 0.7;
        // Boost novelty score
        evalResult.score = Math.round(
          evalResult.score * (1 - explorationWeight) + (evalResult.noveltyScore * 100) * explorationWeight
        );
      }

      predictions.push(evalResult);
    }

    // Sort by final score
    predictions.sort((a, b) => b.score - a.score);

    for (const p of predictions) {
      validTracks.push(p.track);
    }

    return {
      tracks: validTracks,
      predictions,
      unfilteredCount: candidates.length,
      discardedCount,
      activeFiltersDescription
    };
  }

  private matchesFilters(track: TrackMetadata, params: RadioParameters): boolean {
    const af = track.acousticFeatures;

    if (params.instrumentalOnly) {
      if (!af || typeof af.instrumentalness !== 'number' || af.instrumentalness < 0.5) {
        return false;
      }
    }

    if (af) {
      if (params.minBpm !== undefined && typeof af.bpm === 'number' && af.bpm < params.minBpm) {
        return false;
      }
      if (params.maxBpm !== undefined && typeof af.bpm === 'number' && af.bpm > params.maxBpm) {
        return false;
      }
      if (params.minEnergy !== undefined && typeof af.energy === 'number' && af.energy < params.minEnergy) {
        return false;
      }
      if (params.maxEnergy !== undefined && typeof af.energy === 'number' && af.energy > params.maxEnergy) {
        return false;
      }
      if (params.minValence !== undefined && typeof af.valence === 'number' && af.valence < params.minValence) {
        return false;
      }
      if (params.maxValence !== undefined && typeof af.valence === 'number' && af.valence > params.maxValence) {
        return false;
      }
      if (params.vocalOnly && typeof af.instrumentalness === 'number' && af.instrumentalness > 0.5) {
        return false;
      }
    }

    if (params.genres && params.genres.length > 0) {
      if (!track.genres || !track.genres.some((g) => params.genres!.map((x) => x.toLowerCase()).includes(g.toLowerCase()))) {
        return false;
      }
    }

    if (track.releaseYear) {
      if (params.eraStart !== undefined && track.releaseYear < params.eraStart) {
        return false;
      }
      if (params.eraEnd !== undefined && track.releaseYear > params.eraEnd) {
        return false;
      }
    }

    return true;
  }

  private resolveContextFilters(contextType: RadioContextType, custom?: RadioParameters): RadioParameters {
    const base = custom ?? {};

    switch (contextType) {
      case 'gym':
        return {
          ...base,
          minEnergy: 0.7,
          minBpm: 125
        };
      case 'work':
        return {
          ...base,
          maxEnergy: 0.65,
          minEnergy: 0.3
        };
      case 'study':
        return {
          ...base,
          instrumentalOnly: true,
          maxEnergy: 0.5
        };
      case 'relax':
        return {
          ...base,
          maxEnergy: 0.4,
          maxBpm: 110
        };
      case 'night':
        return {
          ...base,
          maxEnergy: 0.45,
          targetValence: 0.35
        };
      case 'discovery':
        return {
          ...base,
          explorationFactor: 0.75
        };
      case 'preference':
      default:
        return base;
    }
  }
}
