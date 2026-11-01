export interface GraphTrack {
  uri: string;
  signal: number; // Explicit rating in [-1, 1]; 0 for an unrated node
  artistUris: string[];
  albumUri?: string;
}
export const GraphTrack = {};

export interface GraphInput {
  tracks: readonly GraphTrack[];
  transitions?: ReadonlyArray<readonly [string, string]>;
  contexts?: ReadonlyMap<string, readonly string[]>;
}
export const GraphInput = {};

const ALPHA = 0.5;
const HOPS = 2;
const POPULARITY_EXPONENT = 0.75;
const TRANSITION_WEIGHT = 0.5;
const CONTEXT_WEIGHT = 0.25;
const MAX_CONTEXT_SIZE = 500;
const MAX_INFERRED_GENRES = 3;

/**
 * Heterogeneous graph over tracks, artists, albums and playlists, with the LightGCN-style propagation
 * y⁽ˡ⁺¹⁾ = (1 - α) Ã y⁽ˡ⁾ + α y⁽⁰⁾. Stored in compressed sparse rows, since it is rebuilt from scratch
 * and has to stay cheap at 20 000 rated tracks.
 */
export class MusicGraphEngine {
  private index = new Map<string, number>();
  private propagated: Float64Array = new Float64Array(0);
  private neighbors = new Map<string, string[]>();
  private artistGenres = new Map<string, string[]>();

  setArtistGenres(artistUri: string, genres: readonly string[]): void {
    this.artistGenres.set(artistUri, genres.map((g) => g.toLowerCase().trim()).filter(Boolean));
  }

  getArtistGenres(): ReadonlyMap<string, string[]> {
    return this.artistGenres;
  }

  rebuild({ tracks, transitions = [], contexts = new Map() }: GraphInput): void {
    const index = new Map<string, number>();
    const from: number[] = [];
    const to: number[] = [];
    const weights: number[] = [];
    const neighbors = new Map<string, string[]>();

    const nodeOf = (uri: string): number => {
      let id = index.get(uri);
      if (id === undefined) {
        id = index.size;
        index.set(uri, id);
      }
      return id;
    };

    const connect = (a: string, b: string, weight: number): void => {
      const [x, y] = [nodeOf(a), nodeOf(b)];
      if (x === y) return;
      from.push(x, y);
      to.push(y, x);
      weights.push(weight, weight);
    };

    for (const track of tracks) {
      nodeOf(track.uri);
      for (const artist of track.artistUris) {
        connect(track.uri, artist, 1);
        const list = neighbors.get(track.uri);
        if (list) list.push(artist);
        else neighbors.set(track.uri, [artist]);
      }
      if (track.albumUri) connect(track.uri, track.albumUri, 0.5);
    }

    for (const [a, b] of transitions) {
      connect(a, b, TRANSITION_WEIGHT);
      const list = neighbors.get(a);
      if (list) list.push(b);
      else neighbors.set(a, [b]);
    }

    for (const [context, members] of contexts) {
      if (members.length > MAX_CONTEXT_SIZE) continue; // A huge playlist relates nothing to anything
      for (const member of members) connect(context, member, CONTEXT_WEIGHT);
    }

    const size = index.size;
    const degree = new Float64Array(size);
    for (let e = 0; e < from.length; e++) degree[from[e]] += weights[e];

    const signal = new Float64Array(size);
    for (const track of tracks) signal[index.get(track.uri)!] = track.signal;

    // A sender divides by d_j^0.5 in Ã and by a further d_j^0.25, reaching the d_j^-0.75 penalty on hubs
    let current = Float64Array.from(signal);
    for (let hop = 0; hop < HOPS; hop++) {
      const next = new Float64Array(size);
      for (let e = 0; e < from.length; e++) {
        const [i, j] = [from[e], to[e]];
        next[i] += (weights[e] * current[j]) / (Math.sqrt(degree[i]) * degree[j] ** POPULARITY_EXPONENT);
      }
      for (let i = 0; i < size; i++) next[i] = (1 - ALPHA) * next[i] + ALPHA * signal[i];
      current = next;
    }

    this.index = index;
    this.propagated = current;
    this.neighbors = neighbors;
  }

  /** Structural affinity in (-1, 1). An unseen track borrows from its strongest artist. */
  affinity(trackUri: string, artistUris: readonly string[] = []): number {
    const own = this.valueOf(trackUri);
    if (own !== 0) return Math.tanh(own);

    let strongest = 0;
    for (const artist of artistUris) {
      const value = this.valueOf(artist);
      if (Math.abs(value) > Math.abs(strongest)) strongest = value;
    }
    return Math.tanh(strongest);
  }

  /** The artist's own genres, otherwise the most voted among graph neighbors. */
  inferGenres(trackUri: string, artistUris: readonly string[] = []): string[] {
    const direct = artistUris.flatMap((artist) => this.artistGenres.get(artist) ?? []);
    if (direct.length > 0) return Array.from(new Set(direct)).slice(0, MAX_INFERRED_GENRES);

    const votes = new Map<string, number>();
    for (const neighbor of this.neighbors.get(trackUri) ?? []) {
      const sources = this.artistGenres.get(neighbor) ?? (this.neighbors.get(neighbor) ?? [])
        .flatMap((uri) => this.artistGenres.get(uri) ?? []);
      for (const genre of sources) votes.set(genre, (votes.get(genre) ?? 0) + 1);
    }

    return Array.from(votes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_INFERRED_GENRES)
      .map(([genre]) => genre);
  }

  private valueOf(uri: string): number {
    const id = this.index.get(uri);
    return id === undefined ? 0 : this.propagated[id];
  }
}
