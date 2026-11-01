import { IndexedDBStorage } from './storage/IndexedDBStorage.ts';
import { BlacklistManager } from './core/BlacklistManager.ts';
import { RatingManager } from './core/RatingManager.ts';
import { PreferenceEngine } from './core/PreferenceEngine.ts';
import { PredictiveQueueGuardian, QueuePlatformBridge } from './queue/PredictiveQueueGuardian.ts';
import { SmartPlaybackEngine, SmartPlaybackBridge } from './queue/SmartPlaybackEngine.ts';
import { RadioEngine, RadioContextType } from './radios/RadioEngine.ts';
import { ExplainabilityEngine } from './explainability/ExplainabilityEngine.ts';
import { PerformanceMonitor } from './optimization/PerformanceMonitor.ts';
import { EventThrottler } from './optimization/EventThrottler.ts';
import { StarRatingWidget } from './ui/StarRatingWidget.ts';
import { KeyboardShortcuts, SpicetifyKeyboardBridge } from './ui/KeyboardShortcuts.ts';
import { DashboardModal } from './ui/DashboardModal.ts';
import { AudioFeatureProvider, AudioFeatureBridge } from './core/AudioFeatureProvider.ts';
import { PlaybackHistoryTracker } from './core/PlaybackHistoryTracker.ts';
import {
  COVARIANCE_EXPORT_FILENAME,
  CSV_EXPORT_FILENAME,
  DataPortabilityManager,
  GRAPH_EXPORT_FILENAME,
  DOSSIER_EXPORT_FILENAME,
  JSPF_EXPORT_FILENAME,
  RADIO_JSPF_EXPORT_FILENAME,
  SYNC_PLAYLISTS,
  JSON_EXPORT_FILENAME,
  PlaylistBridge
} from './storage/DataPortabilityManager.ts';
import { EigenResonanceRanker } from './core/EigenResonanceRanker.ts';
import { POPULATION_MEAN, POPULATION_STD } from './core/AcousticVector.ts';
import { LocalAudioDSPEngine } from './dsp/LocalAudioDSPEngine.ts';
import { AudioAnalysisPayload, synthesizeFeatures } from './core/AudioAnalysisSynthesizer.ts';
import { CandidateHarvester, HarvestBridge, HarvestResult } from './radios/CandidateHarvester.ts';
import { buildUnheardShield } from './radios/UnheardShield.ts';
import { songKeys } from './core/SongIdentity.ts';
import { HeardLedger } from './radios/HeardLedger.ts';
import { importStreamingHistory } from './storage/StreamingHistory.ts';
import { RadioSession, SteerDirection } from './radios/RadioSession.ts';
import { WEEKLY_INTERVAL_MS, WEEKLY_PLAYLIST, pickWeeklyDiscoveries } from './radios/WeeklyDiscoveries.ts';
import { AutoBackup } from './storage/AutoBackup.ts';
import { chooseBackupFolder, usableBackupFolder } from './ui/BackupFolderAccess.ts';
import { LatestRunGate, withTimeout } from './core/AsyncGuards.ts';
import { EXPLORATORY_TEMPERATURE_FACTOR, EXPOSED_TRACKS, buildExposures, shufflePositions, summarizeOutcomes } from './evaluation/RadioOutcomes.ts';
import { resolveTemperature } from './core/ThompsonBanditOptimizer.ts';
import { fetchNativeRecommendations } from './discovery/NativeRecommendations.ts';
import { patchRatingMetadata } from './storage/RatingPatch.ts';
import { predictiveProfile } from './neuroscience/AuditoryPredictiveCodingEngine.ts';
import { rhythmProfile } from './neuroscience/RhythmDynamicsEngine.ts';
import { extractMorphology } from './core/SegmentMorphologyEngine.ts';
import { NeuralContextModel } from './core/NeuralContextModel.ts';
import { loadFlags, saveFlags, ALL_MODULES_ON, ModuleFlags } from './core/FeatureFlags.ts';
import { AutopilotDaemon } from './queue/AutopilotDaemon.ts';
import { AutonomousDiscoveryCrawler, chooseDiscoverySeeds } from './discovery/AutonomousDiscoveryCrawler.ts';
import { CapabilityCheck, CapabilityReport, probeCapabilities } from './core/ApiCapabilityProbe.ts';
import { EvaluationReport, RollingReport, defaultRankers, diagnoseEvaluation, evaluate, evaluateRolling, moduleRanker } from './evaluation/RecommenderEvaluation.ts';
import { GraphqlRequest, collectUris, createGraphqlDiscoveryBridge, createTopTracksDiscoveryBridge, fetchRelatedArtists, resolveTrackMetadata, timedRequest } from './discovery/GraphqlDiscoveryBridge.ts';
import { ParsedRadio, parseRadioPrompt } from './radios/NaturalLanguageRadioParser.ts';
import { ExportTarget, saveExports } from './ui/FileExporter.ts';
import { PlayOrigin, RadioArm, RadioExposure, TrackMetadata, QueueStateSummary, Rating } from './types/index.ts';

declare const Spicetify: any;

const MUTED_VOLUME_KEY = 'neuraltune:muted-volume';
const QUEUE_LOOKAHEAD_MS = 4000;
const TRACK_LOOKUP_BATCH = 50;
const BACKFILL_DELAY_MS = 10_000;
const BACKFILL_BATCH = 20;
const BACKFILL_SPACING_MS = 1500;
const RADIO_ANALYSIS_LIMIT = 30;
const RADIO_ANALYSIS_SPACING_MS = 200;
const RADIO_LENGTH = 30;
const MIN_HARMONIC_QUEUE = 5;
const CAPABILITIES_KEY = 'neuraltune:capabilities-v5';
const ROLLING_KEY = 'neuraltune:evaluation-rolling';
const EVALUATION_KEY = 'neuraltune:evaluation';
const PROBE_DELAY_MS = 20_000;
const EVALUATION_DELAY_MS = 90_000;
const PROBE_INTERVAL_MS = 24 * 3_600_000;
const RELATED_SEEDS = 5;
const GRAPHQL_TIMEOUT_MS = 5_000;
const EXTERNAL_WAIT_MS = 9_000;
const ANALYSIS_WAIT_MS = 4_000;
const LAST_RADIO_KEY = 'neuraltune:last-radio';
const DIAGNOSIS_KEY = 'neuraltune:evaluation-diagnosis';
const WEEKLY_KEY = 'neuraltune:weekly-discoveries';
const SCHEDULED_WORK_DELAY_MS = 150_000;
const EARLIER_RATINGS = 388;

(async function initNeuralTune() {
  // 1. Wait for Spicetify Player and Platform objects to be ready
  if (
    !globalThis.Spicetify ||
    !Spicetify.Player ||
    !Spicetify.Platform ||
    !Spicetify.LocalStorage
  ) {
    setTimeout(initNeuralTune, 300);
    return;
  }

  console.log('[NeuralTune] Inicializando Sistema Avançado de Personalização Musical...');

  // Safe notification helper that never throws
  const notify = (msg: string, isError: boolean = false) => {
    try {
      if (typeof Spicetify.showNotification === 'function') {
        Spicetify.showNotification(msg, isError);
      } else if (Spicetify.Snackbar?.enqueueSnackbar) {
        Spicetify.Snackbar.enqueueSnackbar(msg, { variant: isError ? 'error' : 'default' });
      } else {
        console.log(`[NeuralTune] ${isError ? 'ERR: ' : ''}${msg}`);
      }
    } catch {
      console.log(`[NeuralTune] ${msg}`);
    }
  };

  // 2. Initialize Core Storage and Services
  const storage = new IndexedDBStorage();
  try {
    await storage.init();
  } catch (e) {
    console.warn('[NeuralTune] Storage init fallback', e);
  }

  const blacklist = new BlacklistManager(storage);
  try {
    await blacklist.init();
  } catch (e) {
    console.warn('[NeuralTune] Blacklist init fallback', e);
  }

  // Spotify answers HTTP errors both by rejecting and by resolving with an error body
  async function cosmosGet(url: string): Promise<any> {
    const response = await Spicetify.CosmosAsync.get(url);
    if (response?.error) throw { status: response.error.status ?? response.code };
    if (typeof response?.code === 'number' && response.code >= 400) throw { status: response.code };
    return response;
  }

  const audioBridge: AudioFeatureBridge = {
    async fetchBatch(ids: string[]) {
      const response = await cosmosGet(`https://api.spotify.com/v1/audio-features?ids=${ids.join(',')}`);
      return response?.audio_features ?? [];
    },
    async fetchAnalysis(uri: string) {
      const analysis: AudioAnalysisPayload | null = await Spicetify.getAudioData(uri);
      const synthesized = analysis ? synthesizeFeatures(analysis) : null;
      if (!analysis || !synthesized) return null;

      const information = predictiveProfile(analysis);
      const rhythm = rhythmProfile(analysis);
      return {
        ...synthesized,
        predictive: {
          harmonicSurprise: information.harmonic?.normalizedSurprise,
          harmonicUncertainty: information.harmonic?.normalizedUncertainty,
          rhythmicSurprise: information.rhythmic?.normalizedSurprise,
          timbralSurprise: information.timbral?.normalizedSurprise
        },
        rhythm: rhythm ? { regularity: rhythm.regularity, syncopation: rhythm.syncopation, tempoStability: rhythm.tempoStability, pattern: rhythm.pattern } : undefined,
        morphology: extractMorphology(analysis) ?? undefined
      };
    }
  };

  const features = new AudioFeatureProvider(storage, audioBridge);
  try {
    await features.init();
  } catch (e) {
    console.warn('[NeuralTune] Audio feature cache fallback', e);
  }

  const ratingManager = new RatingManager(storage);
  const preference = new PreferenceEngine(storage);
  preference.setFeatureLookup((uri) => features.get(uri));
  let flags: ModuleFlags = loadFlags(Spicetify.LocalStorage);
  const contextModel = new NeuralContextModel(preference, flags);
  const resonance = new EigenResonanceRanker(preference, Math.random, contextModel);
  const localDsp = new LocalAudioDSPEngine((uri, acoustic) => {
    features.ingest(uri, acoustic).catch((e) => console.warn('[NeuralTune] Local DSP store error', e));
  });
  try {
    await preference.init();
  } catch (e) {
    console.warn('[NeuralTune] Preference init fallback', e);
  }

  const heardLedger = new HeardLedger();
  try {
    for (const play of await storage.getAllPlayEvents()) heardLedger.addPlay(play);
    const history = await storage.getAllHistory();
    for (const entry of history) heardLedger.addHistory(entry);
    preference.ingestHistory(history);
  } catch (e) {
    console.warn('[NeuralTune] Histórico de escuta indisponível', e);
  }

  const refreshContext = async () => {
    contextModel.fit(await storage.getAllRatings(), await storage.getAllPlayEvents());
  };
  await refreshContext().catch((e) => console.warn('[NeuralTune] Context model fallback', e));

  const explainability = new ExplainabilityEngine();
  const perfMonitor = new PerformanceMonitor();

  // 3. Helper to convert Spotify track object into TrackMetadata
  function parseArtists(item: any): TrackMetadata['artists'] {
    if (Array.isArray(item.artists) && item.artists.length > 0) {
      return item.artists.map((a: any) => ({
        name: a.name || item.metadata?.artist_name || 'Desconhecido',
        uri: a.uri || item.metadata?.artist_uri || ''
      }));
    }

    // Raw queue entries carry artists as artist_uri, artist_uri:1, artist_uri:2...
    const artists: TrackMetadata['artists'] = [];
    const metadata = item.metadata ?? {};
    for (let i = 0; metadata[i === 0 ? 'artist_uri' : `artist_uri:${i}`] || (i === 0 && metadata.artist_name); i++) {
      const suffix = i === 0 ? '' : `:${i}`;
      artists.push({
        name: metadata[`artist_name${suffix}`] || 'Desconhecido',
        uri: metadata[`artist_uri${suffix}`] || ''
      });
    }
    return artists;
  }

  function parseTrack(raw: any): TrackMetadata | null {
    const item = raw?.contextTrack ? { ...raw.contextTrack, provider: raw.provider } : raw;
    if (!item || !item.uri) return null;

    return {
      uri: item.uri,
      uid: item.uid,
      name: item.name || item.metadata?.title || 'Sem título',
      artists: parseArtists(item),
      album: {
        name: item.album?.name || item.metadata?.album_title || '',
        uri: item.album?.uri || item.metadata?.album_uri || ''
      },
      duration_ms: item.duration?.milliseconds || (item.metadata?.duration ? parseInt(item.metadata.duration, 10) : undefined),
      is_queued: item.isQueued ?? item.metadata?.is_queued === 'true',
      provider: item.provider
    };
  }

  function getCurrentTrack(): TrackMetadata | null {
    const track = parseTrack(Spicetify.Player.data?.item);
    if (!track) return null;

    const genres = preference.getGraph().inferGenres(track.uri, track.artists.map((a) => a.uri));
    return features.attach(genres.length > 0 ? { ...track, genres } : track);
  }

  const genreLookups = new Set<string>();
  let genreLookupRefused = false;

  /** Best effort, one artist per track change: this is the only source of genres the client gives. */
  async function learnArtistGenres(track: TrackMetadata): Promise<void> {
    const artist = track.artists[0]?.uri;
    if (!artist || genreLookupRefused || genreLookups.has(artist)) return;

    genreLookups.add(artist);
    try {
      const response = await cosmosGet(`https://api.spotify.com/v1/artists/${artist.split(':')[2]}`);
      if (response?.genres?.length) preference.getGraph().setArtistGenres(artist, response.genres);
    } catch {
      genreLookupRefused = true;
    }
  }

  function parseWebApiTrack(item: any): TrackMetadata {
    return {
      uri: item.uri,
      name: item.name,
      artists: (item.artists ?? []).map((a: any) => ({ name: a.name, uri: a.uri })),
      album: { name: item.album?.name ?? '', uri: item.album?.uri ?? '' },
      duration_ms: item.duration_ms,
      releaseYear: parseInt(item.album?.release_date, 10) || undefined
    };
  }

  async function resolveTracks(uris: string[]): Promise<Map<string, TrackMetadata>> {
    const resolved = new Map<string, TrackMetadata>();

    for (let i = 0; i < uris.length; i += TRACK_LOOKUP_BATCH) {
      const ids = uris.slice(i, i + TRACK_LOOKUP_BATCH).map((uri) => uri.split(':')[2]);
      try {
        const response = await cosmosGet(`https://api.spotify.com/v1/tracks?ids=${ids.join(',')}`);
        for (const item of response?.tracks ?? []) {
          if (item?.uri) resolved.set(item.uri, parseWebApiTrack(item));
        }
      } catch (err) {
        // Rate limited or refused: keep what was resolved, further batches would fail the same way
        console.warn('[NeuralTune] Consulta de metadados interrompida', err);
        break;
      }
    }

    const missing = uris.filter((uri) => !resolved.has(uri));
    if (missing.length > 0) {
      for (const [uri, track] of await resolveTrackMetadata(graphql, missing)) resolved.set(uri, track);
    }

    return resolved;
  }

  /** The context menu only hands over a URI. Rating it must still record what the track is. */
  async function resolveTrack(uri: string): Promise<TrackMetadata> {
    const current = getCurrentTrack();
    if (current?.uri === uri) return current;

    await features.ensure([uri]);
    const resolved = (await resolveTracks([uri])).get(uri);
    return features.attach(resolved ?? { uri, name: 'Faixa', artists: [], album: { name: '', uri: '' } });
  }

  function readQueueState(): QueueStateSummary | null {
    const current = getCurrentTrack() ?? undefined;

    const state = Spicetify.Platform?.PlayerAPI?._queue?._queueState;
    if (state?.nextUp || state?.queued) {
      return {
        current: current ?? parseTrack(state.current) ?? undefined,
        queued: (state.queued || []).map(parseTrack).filter(Boolean) as TrackMetadata[],
        nextUp: (state.nextUp || []).map(parseTrack).filter(Boolean) as TrackMetadata[]
      };
    }

    const nextTracks: any[] | undefined = Spicetify.Queue?.nextTracks;
    if (!nextTracks) return null;

    const upcoming = nextTracks.filter((entry) => entry?.contextTrack?.uri !== 'spotify:delimiter');
    return {
      current,
      queued: upcoming.filter((entry) => entry.provider === 'queue').map(parseTrack).filter(Boolean) as TrackMetadata[],
      nextUp: upcoming.filter((entry) => entry.provider !== 'queue').map(parseTrack).filter(Boolean) as TrackMetadata[]
    };
  }

  // 4. Connect Predictive Queue Guardian Bridge
  const queueBridge: QueuePlatformBridge = {
    getQueueState: readQueueState,
    async removeFromQueue(items: Array<{ uri: string; uid?: string }>): Promise<void> {
      try {
        if (Spicetify.removeFromQueue) {
          await Spicetify.removeFromQueue(items);
        } else if (Spicetify.Platform?.PlayerAPI?._queue?.removeFromQueue) {
          await Spicetify.Platform.PlayerAPI._queue.removeFromQueue(items);
        }
      } catch (err) {
        console.error('[NeuralTune] Erro ao remover faixas da fila nativa', err);
      }
    },
    skipNext(): void {
      try {
        Spicetify.Player.next();
      } catch (e) {
        console.warn('[NeuralTune] skipNext error', e);
      }
    },
    pause(): void {
      try {
        Spicetify.Player.pause();
      } catch (e) {
        console.warn('[NeuralTune] pause error', e);
      }
    },
    notify,
    getCurrentUri() {
      return Spicetify.Player.data?.item?.uri ?? null;
    },
    getVolume() {
      return Spicetify.Player.getVolume();
    },
    setVolume(level: number) {
      Spicetify.Player.setVolume(level);
    },
    persistMutedVolume(level: number | null) {
      if (level === null) Spicetify.LocalStorage.remove(MUTED_VOLUME_KEY);
      else Spicetify.LocalStorage.set(MUTED_VOLUME_KEY, String(level));
    }
  };

  // A crash between muting and restoring would otherwise leave the app silent across restarts
  const interruptedVolume = parseFloat(Spicetify.LocalStorage.get(MUTED_VOLUME_KEY) ?? '');
  if (interruptedVolume > 0) {
    Spicetify.Player.setVolume(interruptedVolume);
    Spicetify.LocalStorage.remove(MUTED_VOLUME_KEY);
  }

  const queueGuardian = new PredictiveQueueGuardian(blacklist, queueBridge);

  // 5. Connect Smart Playback Engine Bridge
  const smartBridge: SmartPlaybackBridge = {
    async playTrack(uri: string): Promise<void> {
      if (Spicetify.Player.playUri) {
        await Spicetify.Player.playUri(uri);
      } else {
        await Spicetify.Platform.PlayerAPI.play({ uri });
      }
    },
    async addToQueue(tracks: Array<{ uri: string }>): Promise<void> {
      if (Spicetify.addToQueue) {
        await Spicetify.addToQueue(tracks);
      }
    },
    async setQueue(tracks: Array<{ uri: string }>): Promise<void> {
      try {
        if (Spicetify.Platform?.PlayerAPI?.clearQueue) {
          await Spicetify.Platform.PlayerAPI.clearQueue();
        }
        const existingQueued = readQueueState()?.queued ?? [];
        if (existingQueued.length > 0) {
          await queueBridge.removeFromQueue(
            existingQueued.map((item) => ({ uri: item.uri, uid: item.uid }))
          );
        }
      } catch (err) {
        console.warn('[NeuralTune] Aviso ao limpar fila anterior:', err);
      }
      if (Spicetify.addToQueue && tracks.length > 0) {
        await Spicetify.addToQueue(tracks);
      }
    },
    notify
  };

  const smartPlayback = new SmartPlaybackEngine(blacklist, preference, smartBridge);
  const radioEngine = new RadioEngine(preference, blacklist);

  let openDashboardModal: () => Promise<void>;

  // 6. Mount Star Rating Widget into Now Playing bar
  const starWidget = new StarRatingWidget(ratingManager, () => {
    if (openDashboardModal) openDashboardModal();
  });

  // 7. Connect Rating Updates to Preference Engine
  ratingManager.onRatingChange(async (record, prev) => {
    const cleaning = record.rating === 0 ? queueGuardian.inspectAndCleanQueue(false) : null;
    await preference.updateWithRating(record, prev);
    contextModel.observeRating(record);
    starWidget.updateTrack(getCurrentTrack());

    // Immediately evict any newly star-rated song from active radio recommendations & discovery cache
    evictRatedOrLikedFromPools(record.uri, record.metadata);

    if (cleaning) {
      await cleaning;
      if (Spicetify.Player.data?.item?.uri === record.uri) {
        await queueGuardian.skipBlockedCurrent(record.uri);
      }
    }
  });

  let lastTrack: TrackMetadata | null = null;
  const radioQueued = new Set<string>();

  /** A radio track was picked by NeuralTune, an autoplay one by Spotify. Everything else by the user. */
  function playOrigin(track: TrackMetadata): PlayOrigin {
    if (radioQueued.has(track.uri)) return 'radio';
    return track.provider === 'autoplay' ? 'autoplay' : 'organic';
  }
  const playbackHistory = new PlaybackHistoryTracker(storage, (event) => {
    preference.recordPlay(event);
    heardLedger.addPlay(event);
    radioSession.observePlay(event);
    const known = lastTrack?.uri === event.uri ? lastTrack : null;
    const expected = known ? preference.evaluateCandidate(known).score / 100 : 0.5;
    if (contextModel.observePlay(event, known, expected)) {
      console.log('[NeuralTune] Mudança no padrão recente de interação detectada: sessão reequilibrada.');
    }
  }, Date.now, playOrigin);

  const playlistBridge: PlaylistBridge = {
    async findPlaylistByName(name: string) {
      const find = (items: any[]): string | null => {
        for (const item of items ?? []) {
          if (item.type === 'playlist' && item.name === name) return item.uri;
          const nested = item.items ? find(item.items) : null;
          if (nested) return nested;
        }
        return null;
      };
      const root = await Spicetify.Platform.RootlistAPI.getContents();
      return find(root?.items);
    },
    async createPlaylist(name: string) {
      const uri = await Spicetify.Platform.RootlistAPI.createPlaylist(name, { before: 'start' });
      if (uri) {
        neuralTunePlaylists.add(uri);
        try {
          await Spicetify.Platform.RootlistAPI.setPublishedState(uri, false);
        } catch (err) {
          console.warn('[NeuralTune] Não foi possível tirar a playlist do perfil público', err);
        }
      }
      return uri;
    },
    async getPlaylistItems(playlistUri: string) {
      const { totalLength } = await Spicetify.Platform.PlaylistAPI.getMetadata(playlistUri);
      const contents = await Spicetify.Platform.PlaylistAPI.getContents(playlistUri, { offset: 0, limit: totalLength });
      return contents.items
        .filter((item: any) => item?.uri)
        .map((item: any) => ({ uri: item.uri, uid: item.uid ?? '' }));
    },
    async addTracks(playlistUri: string, uris: string[]) {
      await Spicetify.Platform.PlaylistAPI.add(playlistUri, uris, { after: 'end' });
    },
    async removeTracks(playlistUri: string, items: Array<{ uri: string; uid: string }>) {
      await Spicetify.Platform.PlaylistAPI.remove(playlistUri, items);
    }
  };

  const portability = new DataPortabilityManager({
    storage,
    blacklist,
    playlists: playlistBridge,
    keyValue: Spicetify.LocalStorage,
    resolveTracks,
    getModelDiagnostics: () => {
      const snapshot = preference.getModelSnapshot();
      return {
        clusters: snapshot.clusters,
        implicitSignals: snapshot.implicitSignals,
        vector: snapshot.vector,
        memoryHalfLifeDays: preference.getMemoryHalfLives(),
        audioFeatures: features.getDiagnostics()
      };
    }
  });

  const harvestBridge: HarvestBridge = {
    async fetchLibraryPage(offset: number, limit: number) {
      const page = await Spicetify.Platform.LibraryAPI.getTracks({ offset, limit });
      return (page?.items || []).map(parseTrack).filter(Boolean);
    },
    async listPlaylists() {
      const uris: string[] = [];
      const walk = (items: any[]) => {
        for (const item of items ?? []) {
          if (item.type === 'playlist' && !String(item.name ?? '').startsWith('NeuralTune —')) uris.push(item.uri);
          if (item.items) walk(item.items);
        }
      };
      walk((await Spicetify.Platform.RootlistAPI.getContents())?.items);
      return uris.filter((uri) => !isNeuralTunePlaylistUri(uri));
    },
    async fetchPlaylistTracks(playlistUri: string) {
      const meta = await Spicetify.Platform.PlaylistAPI.getMetadata?.(playlistUri).catch(() => null);
      const limit = typeof meta?.totalLength === 'number' && meta.totalLength > 0 ? Math.min(500, meta.totalLength) : 200;
      const contents = await Spicetify.Platform.PlaylistAPI.getContents(playlistUri, { offset: 0, limit });
      const items = Array.isArray(contents?.items) ? contents.items : (Array.isArray(contents) ? contents : []);
      return items.map(parseTrack).filter(Boolean);
    }
  };

  const harvester = new CandidateHarvester(storage, harvestBridge);
  let lastRadio: TrackMetadata[] = [];
  let lastRadioTitle = '';
  let lastRadioInvocation: { kind: 'preset' | 'prompt' | 'cluster' | 'discovery'; type: string; parsed: ParsedRadio | null; customTitle?: string } = {
    kind: 'preset',
    type: 'preference',
    parsed: null
  };
  let cachedExternalDiscovery: { at: number; tracks: TrackMetadata[] } | null = null;
  const radioRuns = new LatestRunGate();
  const containsBreaker = { retryAt: 0 };
  let discoverySeedRotation = 0;

  function evictRatedOrLikedFromPools(uri: string, metadata?: TrackMetadata) {
    const keys = new Set(songKeys(metadata));
    const shouldDrop = (t: TrackMetadata) => t.uri === uri || songKeys(t).some((key) => keys.has(key));
    lastRadio = lastRadio.filter((t) => !shouldDrop(t));
    if (cachedExternalDiscovery) {
      cachedExternalDiscovery.tracks = cachedExternalDiscovery.tracks.filter((t) => !shouldDrop(t));
    }
  }

  async function collectUnheardShield(existingHarvest?: HarvestResult) {
    const [ratings, blockedArtists, harvest] = await Promise.all([
      storage.getAllRatings(),
      storage.getAllBlockedArtists(),
      existingHarvest ? Promise.resolve(existingHarvest) : harvester.harvest()
    ]);

    const currentUri = Spicetify.Player?.data?.item?.uri;
    let liked: { uri: string; track: TrackMetadata | null } | null = null;
    if (currentUri && typeof Spicetify.Player?.getHeart === 'function') {
      try {
        if (Spicetify.Player.getHeart()) liked = { uri: currentUri, track: getCurrentTrack() };
      } catch {}
    }

    // Query native LibraryAPI.contains to catch any liked track beyond the first 1,000 library tracks
    const containsFn = Spicetify.Platform?.LibraryAPI?.contains;
    const libraryContains = typeof containsFn === 'function'
      ? async (uris: string[]) => {
          const flags: unknown = await containsFn.call(Spicetify.Platform.LibraryAPI, ...uris);
          return Array.isArray(flags) ? flags : containsFn.call(Spicetify.Platform.LibraryAPI, uris);
        }
      : undefined;

    return buildUnheardShield({ ratings, blockedArtistCount: blockedArtists.length, harvest, blacklist, liked, libraryContains, containsBreaker, heard: heardLedger });
  }

  const RADIO_TITLES: Record<string, string> = {
    preference: 'Rádio por Preferências',
    discovery: 'Rádio de Descoberta',
    gym: 'Rádio Academia',
    work: 'Rádio Trabalho',
    study: 'Rádio Estudo',
    relax: 'Rádio Relax',
    custom: 'Rádio Personalizada'
  };

  const PRESET_TARGET_PROMPTS: Record<string, string> = {
    gym: 'treino energético rápido',
    work: 'foco concentração',
    study: 'estudo instrumental calmo',
    relax: 'relax calmo acústico lento'
  };

  function isNeuralTunePlaylistUri(uri: string): boolean {
    return neuralTunePlaylists.has(uri);
  }

  const neuralTunePlaylists = new Set<string>();

  async function eligiblePredictions() {
    const harvest = await harvester.harvest();
    preference.setContexts(harvest.contexts);
    const shield = await collectUnheardShield(harvest);
    const pool = await gatherUnheardCandidates(harvest, shield, false);
    return radioEngine.generateRadio(pool.map((t) => features.attach(t)), 'preference').predictions;
  }

  const autopilot = new AutopilotDaemon(
    {
      getQueueState: readQueueState,
      addToQueue: async (tracks) => { await Spicetify.addToQueue(tracks); },
      notify
    },
    blacklist,
    async (_current, excluded, count) => {
      const shield = await collectUnheardShield();
      const predictions = (await eligiblePredictions()).filter(
        (p) => !excluded.has(p.track.uri) && !shield.isExcluded(p.track)
      );
      return resonance.compose(predictions, { length: count }).tracks;
    }
  );

  let activeRun: { radio: string; runId: string; harvest: HarvestResult | null; arm?: RadioArm; carry?: boolean; position: number } | null = null;

  const radioSession = new RadioSession({
    getQueueState: readQueueState,
    async addToQueue(tracks) {
      for (const { uri } of tracks) radioQueued.add(uri);
      await Spicetify.addToQueue(tracks.map((t) => ({ uri: t.uri })));
    },
    async setQueue(tracks) {
      for (const { uri } of tracks) radioQueued.add(uri);
      await smartBridge.setQueue!(tracks.map((t) => ({ uri: t.uri })));
    },
    filterAllowed: async (tracks) => (await collectUnheardShield()).filterUnheard(tracks),
    async replenish(excluded) {
      const invocation = lastRadioInvocation;
      const tracks = invocation.kind === 'discovery'
        ? (await findDiscoveries(true)).found.map((f) => f.track)
        : await buildRadio(invocation.type, invocation.parsed, { dryRun: true, forceRefresh: true, arm: activeRun?.arm, carry: activeRun?.carry });
      return tracks.filter((t) => !excluded.has(t.uri)).map((t) => features.attach(t));
    },
    async onSent(tracks) {
      if (!activeRun) return;
      const scores = new Map(tracks.map((t) => [t.uri, preference.evaluateCandidate(t).score]));
      const { radio, runId, harvest, arm, carry, position } = activeRun;
      activeRun.position += tracks.length;
      await logExposures(radio, Date.now(), tracks, harvest, { runId, arm, carry, positionOffset: position, scoreOf: (uri) => scores.get(uri) });
    }
  });

  // Persisted query descriptors extracted from xpui-modules.js / xpui-routes-artist.js so Deep Cuts works
  // immediately on startup even before Spotify lazily mounts the UI routes that register them in Definitions.
  const FALLBACK_GRAPHQL_DEFINITIONS: Record<string, { name: string; operation: string; sha256Hash: string; value: null }> = {
    queryTrackArtists: { name: 'queryTrackArtists', operation: 'query', sha256Hash: 'ee2b038198f5e62c679c3996584d9249bbee55fe69fc212271c56492a022c798', value: null },
    queryAlbumTracks: { name: 'queryAlbumTracks', operation: 'query', sha256Hash: '11c9cad9cb24c4f9e25ef9456f68621cfd6006a90f679e729c1d2f2fd70dfe16', value: null },
    getAlbumNameAndTracks: { name: 'getAlbumNameAndTracks', operation: 'query', sha256Hash: '8628ad33de3267d7bef516c76a746979a5f98891a2c9eaff3dfec828abdcd983', value: null },
    getArtistNameAndTracks: { name: 'getArtistNameAndTracks', operation: 'query', sha256Hash: '0adaf1a1a8a94c7ed095639c4d9456d2b1cfac16ac511d5dd2b01b6dd89f748a', value: null },
    getTrackName: { name: 'getTrackName', operation: 'query', sha256Hash: '3dee761788854e8dd9239e13ce0d712da031fb8c2036f096a1c765062b410660', value: null },
    queryArtistDiscographyAlbums: { name: 'queryArtistDiscographyAlbums', operation: 'query', sha256Hash: '5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599', value: null },
    queryArtistRelated: { name: 'queryArtistRelated', operation: 'query', sha256Hash: '3d031d6cb22a2aa7c8d203d49b49df731f58b1e2799cc38d9876d58771aa66f3', value: null }
  };

  // Spotify's Web API answers 429 here while the client's own GraphQL keeps working
  const graphql: GraphqlRequest = timedRequest(async (operation, variables) => {
    for (let wait = 0; wait < 15 && typeof Spicetify.GraphQL?.Request !== 'function'; wait++) {
      await new Promise((r) => setTimeout(r, 300));
    }
    const definition = Spicetify.GraphQL?.Definitions?.[operation] ?? FALLBACK_GRAPHQL_DEFINITIONS[operation];
    if (!definition) throw new Error(`Operação GraphQL ausente: ${operation}`);
    return Spicetify.GraphQL.Request(definition, variables);
  }, GRAPHQL_TIMEOUT_MS);
  // Discography operations only load with an artist page; prefer them when the user has opened one
  const discoveryCrawler = () => new AutonomousDiscoveryCrawler(
    Spicetify.GraphQL?.Definitions?.queryArtistDiscographyAlbums
      ? createGraphqlDiscoveryBridge(graphql, '', Spicetify.GraphQL?.Definitions)
      : createTopTracksDiscoveryBridge(graphql),
    blacklist,
    preference
  );

  /**
   * Queries Spotify's native internal PlaylistAPI.getRecommendedTracks(playlistUri, skipIds, limit, { decorateWithBpmAndKey: true })
   * to obtain brand-new tracks outside the user's playlists/library, decorated with BPM & Camelot key.
   */
  async function fetchNativePlaylistRecommendations(playlistUris: string[], shield: Awaited<ReturnType<typeof collectUnheardShield>>): Promise<TrackMetadata[]> {
    const recommendFn = Spicetify.Platform?.PlaylistAPI?.getRecommendedTracks;
    if (typeof recommendFn !== 'function') return [];

    return fetchNativeRecommendations({
      recommend: (playlistUri) => recommendFn.call(Spicetify.Platform.PlaylistAPI, playlistUri, [], 25, { decorateWithBpmAndKey: true }),
      playlistUris,
      rotation: discoverySeedRotation,
      parseTrack,
      isExcluded: shield.isExcluded,
      onDecorated(uri, raw) {
        if (features.get(uri)) return;
        void features.ingest(uri, {
          bpm: raw.bpm,
          camelot: typeof raw.trackKey === 'string' ? raw.trackKey : undefined,
          source: 'spotify-api'
        }).catch(() => undefined);
      }
    });
  }

  async function findDiscoveries(forceRotate: boolean = false, existingShield?: Awaited<ReturnType<typeof collectUnheardShield>>) {
    if (forceRotate) discoverySeedRotation++;
    const [ratings, plays, shield] = await Promise.all([
      storage.getAllRatings(),
      storage.getAllPlayEvents(),
      existingShield ? Promise.resolve(existingShield) : collectUnheardShield()
    ]);
    const counts = new Map<string, number>();
    for (const { rating, metadata } of ratings) {
      const artist = metadata.artists[0]?.uri;
      if (rating >= 4 && artist) counts.set(artist, (counts.get(artist) ?? 0) + rating);
    }
    if (counts.size === 0) {
      for (const { rating, metadata } of ratings) {
        const artist = metadata.artists[0]?.uri;
        if (rating >= 3 && artist) counts.set(artist, (counts.get(artist) ?? 0) + rating);
      }
    }
    const allFavorites = Array.from(counts).sort((a, b) => b[1] - a[1]).map(([artist]) => artist);
    const favOffset = allFavorites.length > 4 ? (discoverySeedRotation * 2) % Math.min(allFavorites.length, 12) : 0;
    const favorites = [...allFavorites.slice(favOffset), ...allFavorites.slice(0, favOffset)];

    const related = await Promise.all(favorites.slice(0, RELATED_SEEDS).map((artist) => {
      return fetchRelatedArtists(graphql, artist).catch(() => [] as string[]);
    }));
    const ratedArtists = new Set(ratings.flatMap((r) => r.metadata.artists.map((a) => a.uri)));
    const seeds = chooseDiscoverySeeds(favorites, related.flat(), (artist) => ratedArtists.has(artist));

    // Exclude ALL star-rated tracks, ALL liked/hearted tracks, and play history
    const history = new Set<string>([
      ...shield.ratedUris,
      ...shield.likedUris,
      ...plays.map((p) => p.uri)
    ]);

    const allAlbums = Array.from(new Set(
      ratings
        .filter((r) => r.rating >= 4 && r.metadata.album?.uri?.startsWith('spotify:album:'))
        .sort((a, b) => b.rating - a.rating || b.timestamp - a.timestamp)
        .map((r) => r.metadata.album.uri)
    ));
    const albOffset = allAlbums.length > 6 ? (discoverySeedRotation * 3) % Math.min(allAlbums.length, 18) : 0;
    const albums = [...allAlbums.slice(albOffset), ...allAlbums.slice(0, albOffset)];

    const crawled = await discoveryCrawler().crawl(seeds, history, 45, albums);
    const unheardTracks = await shield.filterUnheard(crawled.map((c) => c.track));
    const allowedUris = new Set(unheardTracks.map((t) => t.uri));
    const filteredFound = crawled.filter((c) => allowedUris.has(c.track.uri)).slice(0, 30);

    if (filteredFound.length > 0 && (!cachedExternalDiscovery || cachedExternalDiscovery.tracks.length === 0)) {
      cachedExternalDiscovery = { at: Date.now(), tracks: filteredFound.map((c) => c.track) };
    }

    return { found: filteredFound, history, shield };
  }

  /**
   * Builds a rich candidate pool of 100% UNRATED (no ★) and UNLIKED (no ♥) tracks by combining:
   * 1. Unrated & unliked tracks from the user's playlists
   * 2. Spotify's native PlaylistAPI.getRecommendedTracks (decorated with BPM & Key)
   * 3. GraphQL Autonomous Discovery (album deep cuts + favorite/related artist tracks)
   */
  async function gatherUnheardCandidates(
    harvest: HarvestResult,
    shield: Awaited<ReturnType<typeof collectUnheardShield>>,
    forceRefresh: boolean = false
  ): Promise<TrackMetadata[]> {
    const playlistUnheard = await shield.filterUnheard(harvest.tracks);

    const now = Date.now();
    const cacheValid =
      !forceRefresh &&
      cachedExternalDiscovery !== null &&
      cachedExternalDiscovery.tracks.length > 0 &&
      now - cachedExternalDiscovery.at < 5 * 60_000;
    let externalTracks: TrackMetadata[] = [];

    if (cacheValid && cachedExternalDiscovery) {
      externalTracks = await shield.filterUnheard(cachedExternalDiscovery.tracks);
    } else if (forceRefresh || playlistUnheard.length < 80) {
      const playlistUris = Array.from(harvest.contexts.keys());
      const external = Promise.all([
        fetchNativePlaylistRecommendations(playlistUris, shield).catch(() => [] as TrackMetadata[]),
        findDiscoveries(forceRefresh, shield).then((d) => d.found.map((f) => f.track)).catch(() => [] as TrackMetadata[])
      ]);
      // Past the wait, discovery keeps running and only warms the next radio
      const [nativeRecs, graphqlDisc] = await withTimeout(external, EXTERNAL_WAIT_MS, 'Descoberta').catch(() => [[], []] as TrackMetadata[][]);
      externalTracks = await shield.filterUnheard([...nativeRecs, ...graphqlDisc]);
      if (externalTracks.length > 0) {
        cachedExternalDiscovery = { at: now, tracks: externalTracks };
      }
    } else {
      // Warm external discovery cache in the background when playlistUnheard already has >= 80 tracks
      const playlistUris = Array.from(harvest.contexts.keys());
      void Promise.all([
        fetchNativePlaylistRecommendations(playlistUris, shield).catch(() => [] as TrackMetadata[]),
        findDiscoveries(false, shield).then((d) => d.found.map((f) => f.track)).catch(() => [] as TrackMetadata[])
      ]).then(async ([nativeRecs, graphqlDisc]) => {
        const warmed = await shield.filterUnheard([...nativeRecs, ...graphqlDisc]);
        if (warmed.length > 0) {
          cachedExternalDiscovery = { at: Date.now(), tracks: warmed };
        }
      }).catch((err) => console.warn('[NeuralTune] Descoberta em segundo plano falhou', err));
    }

    const merged = new Map<string, TrackMetadata>();
    const seenKeys = new Set<string>();
    // When forceRefresh is requested, prioritize freshly discovered external tracks first
    const orderedSources = forceRefresh
      ? [...externalTracks, ...playlistUnheard]
      : [...playlistUnheard, ...externalTracks];

    for (const track of orderedSources) {
      if (shield.isExcluded(track) || merged.has(track.uri)) continue;
      const keys = songKeys(track);
      if (keys.some((key) => seenKeys.has(key))) continue;
      merged.set(track.uri, track);
      for (const key of keys) seenKeys.add(key);
    }

    return Array.from(merged.values());
  }

  function launchDiscovery(forceRefresh: boolean = false): Promise<number> {
    return recordRadio('deep-cuts', () => buildDiscovery(forceRefresh), (tracks) => tracks);
  }

  async function buildDiscovery(forceRefresh: boolean): Promise<number> {
    const run = radioRuns.begin();
    lastRadioInvocation = { kind: 'discovery', type: 'discovery', parsed: null };
    const discovered = await findDiscoveries(forceRefresh);
    let { found, shield } = discovered;
    if (found.length === 0) {
      const harvest = await harvester.harvest();
      const unheardPool = await gatherUnheardCandidates(harvest, shield, forceRefresh);
      found = discoveryCrawler().rankLocal(unheardPool.map((t) => features.attach(t)), discovered.history);
      if (found.length === 0) {
        if (radioRuns.isCurrent(run)) {
          lastRadio = [];
          notify('Nenhuma faixa inédita disponível agora.', true);
        }
        return 0;
      }
      notify('[NeuralTune] Usando faixas inéditas das suas playlists e recomendações nativas.');
    }
    // Rebuilt, not reused: the user may have rated something during the search
    const tracks = shufflePositions(await (await collectUnheardShield()).filterUnheard(found.map((f) => f.track)), Math.random);
    if (!radioRuns.isCurrent(run)) return 0;
    lastRadio = tracks;
    lastRadioTitle = 'Deep Cuts — Faixas fora do histórico';
    const exposedAt = markRadioQueue(tracks);
    if (await smartPlayback.startPlayback(tracks)) {
      const scores = new Map(found.map((f) => [f.track.uri, f.score]));
      beginRadioSession('Deep Cuts', exposedAt, tracks, null);
      await logExposures('Deep Cuts', exposedAt, tracks, null, { runId: activeRun?.runId, scoreOf: (uri) => scores.get(uri) }).catch((err) => console.warn('[NeuralTune] Registro de exposição falhou', err));
    }
    return tracks.length;
  }

  function beginRadioSession(radio: string, at: number, tracks: TrackMetadata[], harvest: HarvestResult | null, arm?: RadioArm, carry?: boolean): void {
    activeRun = { radio, runId: `${radio}-${at}`, harvest, arm, carry, position: Math.min(tracks.length, EXPOSED_TRACKS) };
    radioSession.start(tracks, activeRun.position);
  }

  /** Must run before playback starts: the song change arrives while the player call is still pending. */
  function markRadioQueue(tracks: readonly TrackMetadata[]): number {
    radioQueued.clear();
    for (const { uri } of tracks.slice(0, EXPOSED_TRACKS)) radioQueued.add(uri);
    return Date.now();
  }

  async function logExposures(
    radio: string,
    at: number,
    tracks: TrackMetadata[],
    harvest: HarvestResult | null,
    extras: {
      propensityOf?: (uri: string) => number | null;
      scoreOf?: (uri: string) => number | undefined;
      arm?: RadioArm;
      carry?: boolean;
      runId?: string;
      positionOffset?: number;
      limit?: number;
    } = {}
  ): Promise<void> {
    const ratings = await storage.getAllRatings();
    const knownArtists = new Set(ratings.flatMap((r) => r.metadata.artists.map((a) => a.uri)));
    const fromPlaylists = new Set(harvest?.tracks.map((t) => t.uri) ?? []);

    const records: RadioExposure[] = buildExposures({
      radio,
      at,
      tracks,
      ...extras,
      runId: extras.runId ?? `${radio}-${at}`,
      sourceOf: (uri) => (fromPlaylists.has(uri) ? 'playlist' : 'descoberta'),
      isNewArtist: (track) => !track.artists.some((a) => knownArtists.has(a.uri)) && !heardLedger.knowsArtist(track)
    });

    await storage.saveExposures(records);
  }

  /** Outcome of the last radio, in local storage: readable from disk when the screen is out of reach. */
  async function recordRadio<T>(type: string, work: () => Promise<T>, tracksOf: (result: T) => number): Promise<T> {
    const started = Date.now();
    const save = (outcome: Record<string, unknown>) => {
      Spicetify.LocalStorage.set(LAST_RADIO_KEY, JSON.stringify({ at: new Date(started).toISOString(), type, ms: Date.now() - started, ...outcome }));
    };

    try {
      const result = await work();
      save({ tracks: tracksOf(result) });
      return result;
    } catch (err) {
      save({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  function composeRadio(
    type: string,
    parsed: ParsedRadio | null,
    options?: { dryRun?: boolean; customTitle?: string; forceRefresh?: boolean; arm?: RadioArm; carry?: boolean }
  ): Promise<TrackMetadata[]> {
    if (options?.dryRun) return buildRadio(type, parsed, options);
    return recordRadio(type, () => buildRadio(type, parsed, options), (tracks) => tracks.length);
  }

  async function buildRadio(
    type: string,
    parsed: ParsedRadio | null,
    options?: { dryRun?: boolean; customTitle?: string; forceRefresh?: boolean; arm?: RadioArm; carry?: boolean }
  ): Promise<TrackMetadata[]> {
    const dryRun = options?.dryRun ?? false;
    const forceRefresh = options?.forceRefresh ?? false;
    const run = dryRun ? 0 : radioRuns.begin();
    if (!dryRun) {
      lastRadioInvocation = {
        kind: options?.customTitle ? 'cluster' : (parsed ? 'prompt' : 'preset'),
        type,
        parsed,
        customTitle: options?.customTitle
      };
      notify(`[NeuralTune] Gerando rádio inédita: ${options?.customTitle ?? (parsed ? 'personalizada' : (RADIO_TITLES[type] ?? type))}...`);
    }

    const harvest = await harvester.harvest();
    preference.setContexts(harvest.contexts);
    const shield = await collectUnheardShield(harvest);

    // Strictly gather ONLY tracks that have NEVER been rated with stars (★) and NEVER liked (♥) in Spotify
    const unheardTracks = await gatherUnheardCandidates(harvest, shield, forceRefresh);

    await features.ensure(unheardTracks.slice(0, 100).map((t) => t.uri));
    const analyzedCount = unheardTracks.filter((t) => features.hasHarmonicData(t.uri)).length;
    const unanalyzed = unheardTracks.filter((t) => !features.hasHarmonicData(t.uri)).slice(0, RADIO_ANALYSIS_LIMIT);
    if (!dryRun) {
      if (analyzedCount < MIN_HARMONIC_QUEUE && unanalyzed.length > 0) {
        const syncCount = Math.min(unanalyzed.length, MIN_HARMONIC_QUEUE - analyzedCount);
        await withTimeout(features.ensureAnalyzed(unanalyzed.slice(0, syncCount).map((t) => t.uri), 80), ANALYSIS_WAIT_MS, 'Análise').catch(() => 0);
        const rest = unanalyzed.slice(syncCount);
        if (rest.length > 0) {
          void features.ensureAnalyzed(rest.map((t) => t.uri), RADIO_ANALYSIS_SPACING_MS);
        }
      } else if (unanalyzed.length > 0) {
        void features.ensureAnalyzed(unanalyzed.map((t) => t.uri), RADIO_ANALYSIS_SPACING_MS);
      }
    }

    const candidates = unheardTracks.map((t) => features.attach(t));
    const generated = parsed
      ? radioEngine.generateRadio(candidates, 'custom', parsed.params)
      : radioEngine.generateRadio(candidates, type as RadioContextType);

    // Synthesized energy, valence, and instrumentalness are uncalibrated: a hard cut (e.g. study radio
    // requiring instrumentalness >= 0.5) can reject a whole library that the target vector can still rank,
    // so hard filters give way before the radio does for both preset and custom radios.
    let predictions = generated.predictions;
    if (predictions.length < MIN_HARMONIC_QUEUE) {
      const fallbackMode: RadioContextType = type === 'discovery' ? 'discovery' : 'preference';
      predictions = radioEngine.generateRadio(candidates, parsed ? 'custom' : fallbackMode, {}).predictions;
      if (!dryRun && predictions.length > 0) {
        notify('[NeuralTune] Filtros relaxados: ajustando seleção inédita pelo vetor acústico.');
      }
    }
    if (parsed?.nostalgiaOnly) {
      const nostalgic = predictions.filter((p) => p.breakdown?.some((c) => c.key === 'nostalgia'));
      if (nostalgic.length >= MIN_HARMONIC_QUEUE) predictions = nostalgic;
    }
    if (parsed?.avoidRepeats) {
      const fresh = predictions.filter((p) => !p.breakdown?.some((c) => c.key === 'fatigue'));
      if (fresh.length >= MIN_HARMONIC_QUEUE) predictions = fresh;
    }

    if (predictions.length === 0) {
      if (!dryRun && radioRuns.isCurrent(run)) {
        lastRadio = [];
        notify('Nenhuma faixa inédita elegível encontrada para esta rádio.', true);
      }
      return [];
    }

    const presetTarget = !parsed && PRESET_TARGET_PROMPTS[type]
      ? parseRadioPrompt(PRESET_TARGET_PROMPTS[type]).targetVector
      : undefined;

    // The coin is the point: arms differ only by chance, unlike radios, which the user picks
    const arm: RadioArm = options?.arm ?? (!dryRun && Math.random() < 0.5 ? 'exploratorio' : 'padrao');
    // Independent of the arm, so each question gets its own comparison
    const carry = options?.carry ?? (!dryRun && Math.random() < 0.5);
    const radioKey = parsed ? undefined : type;
    const baseTemperature = forceRefresh
      ? Math.max(0.45, parsed?.explorationFactor ?? 0.45)
      : parsed?.explorationFactor ?? resolveTemperature({ radio: radioKey });

    const queue = resonance.compose(predictions, {
      radio: radioKey,
      length: RADIO_LENGTH,
      carryFeedback: carry,
      target: parsed?.targetVector ?? presetTarget,
      temperature: arm === 'exploratorio' ? Math.min(1, baseTemperature * EXPLORATORY_TEMPERATURE_FACTOR) : baseTemperature,
      strictHarmonic: parsed?.strictHarmonic
    });
    const rawUsable = queue.tracks.length >= MIN_HARMONIC_QUEUE ? queue.tracks : predictions.map((p) => p.track).slice(0, RADIO_LENGTH);
    // Final ironclad post-condition: 0 rated (★) and 0 liked (♥) tracks may ever exit composeRadio.
    // A fresh shield, since composing takes seconds and the user can rate tracks meanwhile
    const freshShield = await collectUnheardShield(harvest);
    const usable = (await freshShield.filterUnheard(rawUsable)).map((t) => features.attach(t));

    if (!dryRun && radioRuns.isCurrent(run)) {
      lastRadio = usable;
      lastRadioTitle = options?.customTitle ?? (
        parsed
          ? (parsed.matched.length > 0 ? `Rádio Personalizada (${parsed.matched.join(', ')})` : 'Rádio Personalizada')
          : (RADIO_TITLES[type] ?? `Rádio (${type})`)
      );
      const exposedAt = markRadioQueue(usable);
      if (await smartPlayback.startPlayback(usable)) {
        const drawn = new Map(predictions.map((p, i) => [p.track.uri, queue.thermodynamics.probabilities[i]]));
        const draws = queue.tracks.length;
        const scores = new Map(predictions.map((p) => [p.track.uri, p.score]));
        const radioTitle = RADIO_TITLES[type] ?? options?.customTitle ?? type;
        beginRadioSession(radioTitle, exposedAt, usable, harvest, arm, carry);
        await logExposures(radioTitle, exposedAt, usable, harvest, {
          runId: activeRun?.runId,
          arm,
          carry,
          scoreOf: (uri) => scores.get(uri),
          propensityOf: (uri) => {
            const probability = drawn.get(uri);
            return draws >= MIN_HARMONIC_QUEUE && probability !== undefined ? Math.min(1, draws * probability) : null;
          }
        }).catch((err) => console.warn('[NeuralTune] Registro de exposição falhou', err));
      }

      console.log(
        `[NeuralTune] Rádio Inédita: ${unheardTracks.length} candidatas inéditas `
        + `(${shield.counts.rated} ★ e ${shield.counts.liked} ♥ filtradas), T=${queue.temperature}, `
        + `H=${queue.thermodynamics.entropyBits.toFixed(2)} bits, ${queue.solver.harmonicTransitions} transições harmônicas`
      );
    }

    return usable;
  }

  const exportTargets: Record<'json' | 'csv' | 'covariance' | 'graph' | 'jspf', ExportTarget> = {
    jspf: {
      filename: JSPF_EXPORT_FILENAME,
      mimeType: 'application/json',
      build: () => portability.exportJspf()
    },
    covariance: {
      filename: COVARIANCE_EXPORT_FILENAME,
      mimeType: 'application/json',
      build: () => portability.exportCovariance()
    },
    graph: {
      filename: GRAPH_EXPORT_FILENAME,
      mimeType: 'application/xml',
      build: () => portability.exportTransitionGraph()
    },
    json: {
      filename: JSON_EXPORT_FILENAME,
      mimeType: 'application/json',
      build: () => portability.exportJson()
    },
    csv: {
      filename: CSV_EXPORT_FILENAME,
      mimeType: 'text/csv;charset=utf-8',
      build: () => portability.exportCsv()
    }
  };

  async function applyImportedChanges(): Promise<void> {
    ratingManager.clearHistory();
    await preference.reloadFromStorage();
    await queueGuardian.inspectAndCleanQueue(false);
    starWidget.updateTrack(getCurrentTrack());
  }

  async function syncTrashBin(force: boolean = false) {
    const result = await portability.syncTrashBin(force);
    if (result.importedSongs > 0 || result.importedArtists > 0) {
      await applyImportedChanges();
    }
    return result;
  }

  /**
   * Brings rated tracks up to key-and-mode data, at a pace meant to stay under the rate limit. Commits
   * each batch: the run can be interrupted at any point and simply continues on the next start.
   */
  async function backfillRatedFeatures(): Promise<void> {
    const ratings = await storage.getAllRatings();
    const pending = ratings.filter((r) => {
      if (!r.uri.startsWith('spotify:track:')) return false;
      return !features.hasHarmonicData(r.uri) || r.metadata.acousticFeatures?.source !== features.get(r.uri)?.source;
    });

    await features.ensure(pending.map((r) => r.uri));

    for (let i = 0; i < pending.length; i += BACKFILL_BATCH) {
      const batch = pending.slice(i, i + BACKFILL_BATCH);
      await features.ensureAnalyzed(batch.map((r) => r.uri), BACKFILL_SPACING_MS);

      let updated = 0;
      for (const record of batch) {
        const acousticFeatures = features.get(record.uri);
        if (acousticFeatures && await patchRatingMetadata(storage, record.uri, (metadata) => ({ ...metadata, acousticFeatures }))) {
          updated++;
        }
      }
      if (updated > 0) await preference.reloadFromStorage();
      if (!features.canAnalyze()) return;
    }
  }

  starWidget.startMountGuard();
  starWidget.updateTrack(getCurrentTrack());

  // 8. Event Listener for Song Change: Lookahead and Clean Queue
  const onSongChangeThrottled = EventThrottler.throttle(async () => {
    perfMonitor.measure('queue', async () => {
      const cur = getCurrentTrack();
      starWidget.updateTrack(cur);
      await queueGuardian.inspectAndCleanQueue(true);

      if (cur?.uri) {
        await features.ensureCurrent(cur.uri).catch(() => undefined);
        await learnArtistGenres(cur);
      }
      await syncTrashBin().catch((e) => console.warn('[NeuralTune] Trash Bin sync error', e));
    });
  }, 300);

  const onQueueChanged = EventThrottler.debounce(() => {
    queueGuardian.inspectAndCleanQueue(true);
    void radioSession.tick();
    void autopilot.tick();
  }, 250);

  let lookaheadUri: string | null = null;

  try {
    Spicetify.Player.addEventListener('songchange', () => {
      const track = getCurrentTrack();
      playbackHistory.onTrackChange(track);
      localDsp.onTrackChange(track?.uri ?? null);
      lastTrack = track;
      onSongChangeThrottled();
      void radioSession.tick();
      void autopilot.tick();
    });
    Spicetify.Player.addEventListener('onplaypause', () => {
      starWidget.updateTrack(getCurrentTrack());
      // Pressing play after the breaker paused is the user taking back control
      if (!Spicetify.Player.data?.isPaused && queueGuardian.isCircuitTripped()) {
        queueGuardian.resetCircuit();
      }
    });
    Spicetify.Player.addEventListener('onprogress', () => {
      const progress = Spicetify.Player.getProgress();
      playbackHistory.updateProgress(progress);

      // Autoplay fills the queue late: look again just before the track ends
      const uri = Spicetify.Player.data?.item?.uri ?? null;
      const duration = Spicetify.Player.getDuration();
      if (uri !== lookaheadUri && duration > 0 && duration - progress < QUEUE_LOOKAHEAD_MS) {
        lookaheadUri = uri;
        queueGuardian.inspectAndCleanQueue(true);
      }
    });

    const queueEvents = Spicetify.Player.origin?._queue?._events ?? Spicetify.Platform?.PlayerAPI?.getEvents?.();
    queueEvents?.addListener?.('queue_update', onQueueChanged);

    window.addEventListener('beforeunload', () => {
      playbackHistory.flush();
    });
  } catch (e) {
    console.warn('[NeuralTune] Event listener error', e);
  }

  playbackHistory.onTrackChange(getCurrentTrack());

  // 9. Dashboard Modal Setup (with fallback dialog)
  openDashboardModal = async function() {
    console.log('[NeuralTune] Abrindo Dashboard...');
    try {
      const dash = new DashboardModal({
        ratingManager,
        blacklistManager: blacklist,
        preferenceEngine: preference,
        explainabilityEngine: explainability,
        performanceMonitor: perfMonitor,
        getCurrentTrack,
        async launchRadio(type: string) {
          try {
            await composeRadio(type, null);
          } catch (err) {
            console.error('[NeuralTune] Erro ao iniciar rádio', err);
            notify('Erro ao carregar candidatos da biblioteca.', true);
            throw err;
          }
        },
        async launchPromptRadio(prompt: string) {
          const parsed = parseRadioPrompt(prompt);
          try {
            await composeRadio('custom', parsed);
          } catch (err) {
            console.error('[NeuralTune] Erro ao iniciar rádio', err);
            notify('Erro ao carregar candidatos da biblioteca.', true);
            throw err;
          }
          return parsed.matched;
        },
        async importTrashbin() {
          try {
            return await syncTrashBin(true);
          } catch (err) {
            console.error('[NeuralTune] Erro ao importar Trash Bin', err);
            return { importedSongs: 0, importedArtists: 0 };
          }
        },
        exportJson: () => saveExports([exportTargets.json]),
        exportCsv: () => saveExports([exportTargets.csv]),
        syncPlaylists: () => portability.syncPlaylists(),
        async importFile(file, strategy, resolveConflict) {
          const report = await portability.importJson(await file.text(), { strategy, resolveConflict });
          await applyImportedChanges();
          return report;
        },
        getAudioDiagnostics: () => features.getDiagnostics(),
        exportJspf: () => saveExports([exportTargets.jspf]),
        exportDossier: () => saveExports([{
          filename: DOSSIER_EXPORT_FILENAME,
          mimeType: 'text/html',
          build: () => portability.exportDossier(readStored(EVALUATION_KEY))
        }]),
        async launchDiscovery() {
          try {
            return await launchDiscovery();
          } catch (err) {
            console.error('[NeuralTune] Erro no Deep Cuts:', err);
            notify('Erro ao buscar faixas fora do histórico.', true);
            throw err;
          }
        },
        getLastRadioTracks: () => [...lastRadio],
        getLastRadioTitle: () => lastRadioTitle,
        whyTrack(track: TrackMetadata) {
          return explainability.whyRecommended(preference.evaluateCandidate(track), isNewArtist(track));
        },
        async importHistory(files: File[]) {
          const { report, entries } = await importStreamingHistory(await Promise.all(files.map((file) => file.text())), storage, Spicetify.LocalStorage);
          for (const entry of entries) heardLedger.addHistory(entry);
          preference.ingestHistory(entries);
          return report;
        },
        getBackupStatus: () => autoBackup.getStatus(),
        chooseBackupFolder,
        runBackupNow: () => runBackup(true),
        refreshWeeklyDiscoveries: () => refreshWeeklyDiscoveries(true),
        getRadioOutcomes: async () => summarizeOutcomes(await storage.getAllExposures(), await storage.getAllPlayEvents(), await storage.getAllRatings()),
        async playTrack(uri: string) {
          const idx = lastRadio.findIndex((t) => t.uri === uri);
          if (idx >= 0) {
            const ordered = [...lastRadio.slice(idx), ...lastRadio.slice(0, idx)];
            await smartPlayback.startPlayback(ordered);
          } else {
            await Spicetify.Player.playUri(uri);
          }
        },
        async getShieldStats() {
          const shield = await collectUnheardShield();
          return shield.counts;
        },
        async rateRecommendedTrack(track: TrackMetadata, rating: Rating) {
          await ratingManager.rateTrack(track, rating);
          evictRatedOrLikedFromPools(track.uri, track);
          // Also remove from Spotify's explicit queue if it was waiting in the queue
          const queued = (readQueueState()?.queued ?? []).filter((q) => q.uri === track.uri);
          if (queued.length > 0) {
            await queueBridge.removeFromQueue(queued.map((q) => ({ uri: q.uri, uid: q.uid })));
          }
        },
        async refreshLastRadio() {
          if (lastRadioInvocation.kind === 'discovery') {
            await launchDiscovery(true);
          } else {
            await composeRadio(lastRadioInvocation.type, lastRadioInvocation.parsed, {
              customTitle: lastRadioInvocation.customTitle,
              forceRefresh: true
            });
          }
        },
        toggleAutopilot: () => autopilot.toggle(),
        isAutopilotOn: () => autopilot.isEnabled(),
        getFlags: () => flags,
        setFlags(next: ModuleFlags) {
          flags = next;
          saveFlags(Spicetify.LocalStorage, next);
          contextModel.setFlags(next);
        },
        getCapabilities: () => readStored(CAPABILITIES_KEY) as CapabilityReport | null,
        getEvaluation: () => readStored(EVALUATION_KEY) as EvaluationReport | null,
        async launchClusterRadio(centroid: readonly number[]) {
          const target = centroid.map((z, i) => POPULATION_MEAN[i] + z * POPULATION_STD[i]);
          await composeRadio('custom', { ...parseRadioPrompt(''), targetVector: target }, { customTitle: 'Rádio de Cluster' });
        },
        async exportLastRadio() {
          if (lastRadio.length === 0) return false;
          return saveExports([{
            filename: RADIO_JSPF_EXPORT_FILENAME,
            mimeType: 'application/json',
            build: () => portability.exportRadioJspf('NeuralTune — Rádio', lastRadio)
          }]);
        },
        async getRatedSources() {
          const ratings = await storage.getAllRatings();
          const sources: Record<string, number> = {};
          for (const { metadata } of ratings) {
            const source = metadata.acousticFeatures?.source ?? 'Sem dados acústicos';
            sources[source] = (sources[source] ?? 0) + 1;
          }
          return sources;
        },
        exportCovariance: () => saveExports([exportTargets.covariance]),
        exportTransitionGraph: () => saveExports([exportTargets.graph]),
        probeCapture: () => localDsp.probeEnvironment(),
        isCapturing: () => localDsp.isCapturing(),
        async toggleCapture() {
          if (localDsp.isCapturing()) {
            localDsp.stop();
            return false;
          }
          await localDsp.startFromLoopbackDevice();
          localDsp.onTrackChange(getCurrentTrack()?.uri ?? null);
          return true;
        }
      });

      const content = await dash.render();

      if (Spicetify.PopupModal?.display) {
        Spicetify.PopupModal.display({
          title: 'NeuralTune — Inteligência e Personalização Musical',
          content,
          isLarge: true
        });
      } else {
        // Fallback popup overlay
        showFallbackDialog('NeuralTune — Dashboard', content);
      }
    } catch (err) {
      console.error('[NeuralTune] Erro ao renderizar dashboard:', err);
    }
  }

  function showFallbackDialog(title: string, content: HTMLElement) {
    const existing = document.getElementById('neuraltune-fallback-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'neuraltune-fallback-modal';
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 999999;
      display: flex; align-items: center; justify-content: center;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: #181818; color: #fff; border-radius: 12px; width: 720px; max-width: 95vw;
      max-height: 85vh; display: flex; flex-direction: column; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.2); box-shadow: 0 10px 40px rgba(0,0,0,0.8);
    `;

    const header = document.createElement('div');
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 18px 24px; border-bottom: 1px solid rgba(255,255,255,0.1);';
    header.innerHTML = `<h2 style="margin: 0; font-size: 1.3rem;">${title}</h2>`;

    const closeBtn = document.createElement('button');
    closeBtn.innerText = '✕';
    closeBtn.style.cssText = 'background: transparent; border: none; color: #fff; font-size: 20px; cursor: pointer;';
    closeBtn.onclick = () => overlay.remove();
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.style.cssText = 'padding: 20px 24px; overflow-y: auto; flex: 1;';
    body.appendChild(content);

    box.appendChild(header);
    box.appendChild(body);
    overlay.appendChild(box);
    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.remove();
    };
    document.body.appendChild(overlay);
  }

  // 10. Register Keyboard Shortcuts (Native DOM + Spicetify)
  const keyboardBridge: SpicetifyKeyboardBridge = {
    notify,
    getCurrentTrack,
    openDashboard: openDashboardModal,
    skipNext() {
      try { Spicetify.Player.next(); } catch {}
    },
    skipBlocked: (uri: string) => queueGuardian.skipBlockedCurrent(uri),
    toggleHeart() {
      try { Spicetify.Player.toggleHeart(); } catch {}
    },
    toggleAutopilot: () => { autopilot.toggle(); },
    async exportAll() {
      const saved = await saveExports([exportTargets.json, exportTargets.csv]);
      if (saved) notify('[NeuralTune] Avaliações exportadas em JSON e CSV.');
    }
  };

  const shortcuts = new KeyboardShortcuts(ratingManager, keyboardBridge);
  try {
    shortcuts.registerAll();
  } catch (e) {
    console.warn('[NeuralTune] shortcuts registration error', e);
  }

  // 11. Topbar Button & Playbar Button
  const starIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z"/></svg>';

  if (Spicetify.Topbar?.Button) {
    try {
      new Spicetify.Topbar.Button(
        'NeuralTune Dashboard (Ctrl+Alt+M)',
        starIconSvg,
        openDashboardModal
      );
    } catch (e) {
      console.warn('[NeuralTune] Topbar button warning', e);
    }
  }

  if (Spicetify.Playbar?.Button) {
    try {
      new Spicetify.Playbar.Button(
        'NeuralTune (Ctrl+Alt+M)',
        starIconSvg,
        openDashboardModal
      );
    } catch (e) {
      console.warn('[NeuralTune] Playbar button warning', e);
    }
  }

  if (Spicetify.Playbar?.Button) {
    const arrow = (path: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="${path}"/></svg>`;
    const steering: Array<[string, string, SteerDirection]> = [
      ['NeuralTune: mais assim', arrow('M8 2l6 7H2z M6 10h4v4H6z'), 1],
      ['NeuralTune: menos assim', arrow('M8 14L2 7h12z M6 2h4v4H6z'), -1]
    ];
    for (const [label, icon, direction] of steering) {
      try {
        new Spicetify.Playbar.Button(label, icon, () => {
          steerRadio(direction).catch((err) => console.warn('[NeuralTune] Ajuste da rádio falhou', err));
        });
      } catch (e) {
        console.warn('[NeuralTune] Playbar button warning', e);
      }
    }
  }

  // 12. Context Menu: 0-5 stars submenu on tracks
  if (Spicetify.ContextMenu?.Item) {
    try {
      const isSingleTrack = (uris: string[]) => uris?.length === 1 && uris[0].startsWith('spotify:track:');
      const rateFromMenu = async (uri: string, rating: Rating, message: string) => {
        await ratingManager.rateTrack(await resolveTrack(uri), rating);
        notify(`[NeuralTune] ${message}`);
      };

      const menuEntries: Array<[string, Rating, string]> = [
        ['🚫 0★ Bloquear permanentemente', 0, 'Faixa bloqueada'],
        ['⭐ 1★ Detesto', 1, 'Avaliada com 1 estrela'],
        ['⭐⭐ 2★ Não gosto', 2, 'Avaliada com 2 estrelas'],
        ['⭐⭐⭐ 3★ Indiferente', 3, 'Avaliada com 3 estrelas'],
        ['⭐⭐⭐⭐ 4★ Gosto', 4, 'Avaliada com 4 estrelas'],
        ['⭐⭐⭐⭐⭐ 5★ Adoro', 5, 'Avaliada com 5 estrelas']
      ];

      const starSubmenuItems = menuEntries.map(([label, rating, message]) => new Spicetify.ContextMenu.Item(
        label,
        (uris: string[]) => rateFromMenu(uris[0], rating, message),
        isSingleTrack
      ));

      for (const item of starSubmenuItems) {
        item.register();
      }
    } catch (e) {
      console.warn('[NeuralTune] ContextMenu warning', e);
    }
  }

  // 13. Expose NeuralTune Global Controller for developer console / external trigger
  (window as any).NeuralTune = {
    openDashboard: openDashboardModal,
    rateCurrentTrack: async (rating: Rating) => {
      const track = getCurrentTrack();
      if (track) await ratingManager.rateTrack(track, rating);
    },
    getRatingManager: () => ratingManager,
    getPreferenceEngine: () => preference,
    getBlacklistManager: () => blacklist,
    getQueueGuardian: () => queueGuardian,
    getPerformanceMonitor: () => perfMonitor,
    getPortability: () => portability,
    getAudioDiagnostics: () => features.getDiagnostics(),
    getResonance: () => resonance,
    getAutopilot: () => autopilot,
    getCapabilities: () => readStored(CAPABILITIES_KEY),
    getEvaluation: () => readStored(EVALUATION_KEY),
    getLocalDsp: () => localDsp,
    runSelfTest: () => runLiveSelfTest()
  };

  setTimeout(() => {
    queueGuardian.inspectAndCleanQueue(true);
    syncTrashBin().catch((e) => console.warn('[NeuralTune] Trash Bin sync error', e));
  }, 1000);

  setTimeout(() => {
    backfillRatedFeatures()
      .then(async () => {
        if (await portability.enrichPlaceholders() > 0) await preference.reloadFromStorage();
      })
      .then(refreshContext)
      .catch((e) => console.warn('[NeuralTune] Feature backfill error', e));
  }, BACKFILL_DELAY_MS);

  async function steerRadio(direction: SteerDirection): Promise<void> {
    const track = getCurrentTrack();
    if (!track) return;

    playbackHistory.markFeedback(direction > 0 ? 'mais' : 'menos');
    const steered = await radioSession.steer(track, direction);
    if (direction < 0) Spicetify.Player.next();
    notify(steered
      ? `[NeuralTune] Rádio ajustada: ${direction > 0 ? 'mais' : 'menos'} assim.`
      : '[NeuralTune] Sinal registrado. Sem rádio ativa para ajustar agora.');
  }

  function isNewArtist(track: TrackMetadata): boolean {
    return !track.artists.some((a) => (preference.getProfile().artistAffinities[a.uri]?.count ?? 0) > 0) && !heardLedger.knowsArtist(track);
  }

  const autoBackup = new AutoBackup({
    folder: () => usableBackupFolder(backupMayPrompt),
    snapshot: async () => (await portability.exportJson()).content,
    store: Spicetify.LocalStorage
  });
  let backupMayPrompt = false;

  async function runBackup(fromClick: boolean) {
    backupMayPrompt = fromClick;
    return autoBackup.run();
  }

  async function refreshWeeklyDiscoveries(force: boolean): Promise<{ tracks: number; newArtists: number }> {
    const last = readStored(WEEKLY_KEY) as { at?: string; tracks?: number; newArtists?: number } | null;
    if (!force && last?.at && Date.now() - Date.parse(last.at) < WEEKLY_INTERVAL_MS) {
      return { tracks: last.tracks ?? 0, newArtists: last.newArtists ?? 0 };
    }

    const harvest = await harvester.harvest();
    const shield = await collectUnheardShield(harvest);
    const discovered = (await findDiscoveries(true, shield)).found.map((f) => f.track);
    const pool = await shield.filterUnheard([...discovered, ...await gatherUnheardCandidates(harvest, shield, false)]);
    const ranked = pool
      .map((track) => preference.evaluateCandidate(features.attach(track)))
      .filter((prediction) => prediction.eligible)
      .sort((a, b) => b.score - a.score)
      .map((prediction) => prediction.track);

    const { tracks, newArtists } = pickWeeklyDiscoveries(ranked, isNewArtist);
    if (tracks.length === 0) return { tracks: 0, newArtists: 0 };

    const result = await portability.replacePlaylist(WEEKLY_PLAYLIST, tracks.map((t) => t.uri));
    if (result.error) throw new Error(result.error);

    Spicetify.LocalStorage.set(WEEKLY_KEY, JSON.stringify({ at: new Date().toISOString(), tracks: tracks.length, newArtists, created: result.created }));
    await logExposures('Descobertas da Semana', Date.now(), tracks, harvest, { limit: tracks.length });
    return { tracks: tracks.length, newArtists };
  }

  setTimeout(() => {
    refreshWeeklyDiscoveries(false).catch((e) => console.warn('[NeuralTune] Descobertas da Semana falhou', e));
    if (autoBackup.isDue()) {
      runBackup(false).then((status) => {
        if (status.error) notify(`[NeuralTune] Backup pendente: ${status.error}`, true);
      });
    }
  }, SCHEDULED_WORK_DELAY_MS);

  function readStored(key: string): unknown {
    try {
      return JSON.parse(Spicetify.LocalStorage.get(key) ?? 'null');
    } catch {
      return null;
    }
  }

  async function runCapabilityProbe(): Promise<void> {
    // The Web API rate-limits this client: probing it on every start would only add to that
    const previous = readStored(CAPABILITIES_KEY) as CapabilityReport | null;
    if (previous && Date.now() - Date.parse(previous.checkedAt) < PROBE_INTERVAL_MS) return;

    const ratings = await storage.getAllRatings();
    const sample = ratings.find((r) => r.metadata.artists.length > 0 && r.uri.startsWith('spotify:track:'));
    const trackId = sample?.uri.split(':')[2];
    const artistId = sample?.metadata.artists[0]?.uri.split(':')[2];
    const albumId = sample?.metadata.album.uri.split(':')[2];
    const platform = Spicetify.Platform;

    const checks: CapabilityCheck[] = [
      ['Spicetify.getAudioData', async () => {
        const analysis = trackId ? await Spicetify.getAudioData(`spotify:track:${trackId}`) : null;
        return analysis && { segments: analysis.segments?.length, beats: analysis.beats?.length, sections: analysis.sections?.length };
      }],
      ['/v1/audio-features', () => cosmosGet(`https://api.spotify.com/v1/audio-features?ids=${trackId}`).then((r) => r?.audio_features?.length)],
      ['/v1/tracks', () => cosmosGet(`https://api.spotify.com/v1/tracks?ids=${trackId}`).then((r) => r?.tracks?.[0] && Object.keys(r.tracks[0]))],
      ['/v1/artists/{id}', () => cosmosGet(`https://api.spotify.com/v1/artists/${artistId}`).then((r) => r && Object.keys(r))],
      ['/v1/artists/{id}/albums', () => cosmosGet(`https://api.spotify.com/v1/artists/${artistId}/albums?limit=5`).then((r) => r?.items)],
      ['/v1/albums/{id}/tracks', () => cosmosGet(`https://api.spotify.com/v1/albums/${albumId}/tracks?limit=5`).then((r) => r?.items)],
      ['/v1/artists/{id}/top-tracks', () => cosmosGet(`https://api.spotify.com/v1/artists/${artistId}/top-tracks`).then((r) => r?.tracks)],
      ['LibraryAPI.getTracks', () => platform.LibraryAPI.getTracks({ offset: 0, limit: 5 }).then((r: any) => r?.items)],
      ['RootlistAPI.getContents', () => platform.RootlistAPI.getContents().then((r: any) => r?.items)],
      ['PlaylistAPI', async () => typeof platform.PlaylistAPI?.getContents === 'function'],
      ['PlayerAPI._queue._queueState', async () => platform.PlayerAPI?._queue?._queueState && Object.keys(platform.PlayerAPI._queue._queueState)],
      ['Spicetify.addToQueue', async () => typeof Spicetify.addToQueue === 'function'],
      ['Spicetify.GraphQL', async () => Object.keys(Spicetify.GraphQL?.Definitions ?? {}).length],
      ['GraphQL top tracks do artista', async () => collectUris(await graphql('getArtistNameAndTracks', { uri: sample?.metadata.artists[0]?.uri, offset: 0, limit: 200 }), 'spotify:track:')],
      ['GraphQL nome da faixa', async () => {
        const response = await graphql('getTrackName', { uri: sample?.uri }) as { data?: { trackUnion?: { name?: unknown } } };
        return typeof response?.data?.trackUnion?.name === 'string';
      }],
      ['GraphQL artistas da faixa', async () => collectUris(await graphql('queryTrackArtists', { trackUri: sample?.uri }), 'spotify:artist:')],
      ['Deep Cuts de ponta a ponta', async () => {
        const { found } = await findDiscoveries();
        return { faixas: found.length, comArtistas: found.filter((f) => f.track.artists.length > 0).length, deAlbuns: found.filter((f) => f.sourceArtist.startsWith('spotify:album:')).length, deTopTracks: found.filter((f) => f.sourceArtist.startsWith('spotify:artist:')).length };
      }],
      ['navigator.mediaDevices.getUserMedia', async () => typeof navigator.mediaDevices?.getUserMedia === 'function'],
      ['navigator.mediaDevices.getDisplayMedia', async () => typeof navigator.mediaDevices?.getDisplayMedia === 'function']
    ];

    const report = await probeCapabilities(checks, Spicetify.Platform?.version ?? null);
    Spicetify.LocalStorage.set(CAPABILITIES_KEY, JSON.stringify(report));
  }

  /** On the user's own ratings, temporal split. Stored locally for the dashboard and the dossier. */
  async function runEvaluation(): Promise<void> {
    const data = { ratings: await storage.getAllRatings(), plays: await storage.getAllPlayEvents() };
    const rankers: Record<string, ReturnType<typeof moduleRanker>> = { ...defaultRankers(flags), 'Todos os módulos': moduleRanker(ALL_MODULES_ON) };

    for (const module of Object.keys(ALL_MODULES_ON) as Array<keyof ModuleFlags>) {
      rankers[`Sem ${module}`] = moduleRanker({ ...ALL_MODULES_ON, [module]: false });
    }

    const report = await evaluate(data, rankers);
    Spicetify.LocalStorage.set(EVALUATION_KEY, JSON.stringify({ ...report, at: new Date().toISOString() }));

    const variants: Record<string, ReturnType<typeof moduleRanker>> = {
      'Nota por artista': defaultRankers(flags)['Nota por artista'],
      'NeuralTune 3.0': defaultRankers(flags)['NeuralTune 3.0']
    };
    for (const weight of [0, 0.15, 0.3, 0.5, 0.8, 1.2]) variants[`4.0 peso artista ${weight}`] = moduleRanker(flags, weight);

    const rolling: RollingReport = await evaluateRolling(data, variants);
    Spicetify.LocalStorage.set(ROLLING_KEY, JSON.stringify({ ...rolling, at: new Date().toISOString() }));

    const ordered = [...data.ratings].sort((a, b) => a.timestamp - b.timestamp);
    const diagnosis = await diagnoseEvaluation(data, {
      'NeuralTune 4.0': moduleRanker(flags),
      'Nota por artista': defaultRankers(flags)['Nota por artista'],
      'NeuralTune 3.0': defaultRankers(flags)['NeuralTune 3.0']
    }, [
      { label: `primeiras ${EARLIER_RATINGS}`, ratings: ordered.slice(0, EARLIER_RATINGS) },
      { label: 'depois delas', ratings: ordered.slice(EARLIER_RATINGS) },
      { label: 'todas', ratings: ordered }
    ]);
    Spicetify.LocalStorage.set(DIAGNOSIS_KEY, JSON.stringify({ ...diagnosis, at: new Date().toISOString() }));
  }

  async function runLiveSelfTest(): Promise<unknown> {
    const startedAt = Date.now();
    const results: Record<string, unknown> = {
      checkedAt: new Date().toISOString(),
      phase: 'starting',
      tabs: {} as Record<string, unknown>,
      presetRadios: {} as Record<string, unknown>,
      promptRadios: {} as Record<string, unknown>,
      clusterRadio: null as unknown,
      deepCuts: null as unknown,
      autopilot: null as unknown
    };
    const saveProgress = (phase: string) => {
      results.phase = phase;
      results.elapsedMs = Date.now() - startedAt;
      Spicetify.LocalStorage.set('neuraltune:self-test-v14', JSON.stringify(results));
    };
    saveProgress('starting');

    try {
      // Wait for Spotify's internal LibraryAPI and GraphQL session to finish connecting on cold start
      for (let wait = 0; wait < 20; wait++) {
        try {
          const libProbe = await Spicetify.Platform?.LibraryAPI?.getTracks?.({ offset: 0, limit: 1 });
          if (Array.isArray(libProbe?.items) && typeof Spicetify.GraphQL?.Request === 'function') {
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
      harvester.invalidate();

      const harvest = await harvester.harvest();
      results.harvestSources = harvest.sources;
      const shield = await collectUnheardShield(harvest);
      results.shieldCounts = shield.counts;

      // 1. Test all 8 DashboardModal tabs inside a simulated GenericModal__overlay in the real client DOM
      let modalClosedByClick = false;
      const overlay = document.createElement('div');
      overlay.className = 'GenericModal__overlay';
      overlay.style.display = 'none';
      const genericModal = document.createElement('div');
      genericModal.className = 'GenericModal';
      overlay.appendChild(genericModal);
      overlay.addEventListener('click', (e) => {
        if ((e.target as HTMLElement)?.closest?.('.GenericModal') === null) {
          modalClosedByClick = true;
        }
      });
      document.body.appendChild(overlay);

      try {
        const testDash = new DashboardModal({
          ratingManager,
          blacklistManager: blacklist,
          preferenceEngine: preference,
          explainabilityEngine: explainability,
          performanceMonitor: perfMonitor,
          getCurrentTrack,
          launchRadio: async () => {},
          launchPromptRadio: async (p) => parseRadioPrompt(p).matched,
          importTrashbin: async () => ({ importedSongs: 0, importedArtists: 0 }),
          exportJson: async () => true,
          exportCsv: async () => true,
          syncPlaylists: async () => [],
          importFile: async () => ({ addedRatings: 0, replacedRatings: 0, keptLocal: 0, conflicts: 0, addedArtists: 0, addedPlayEvents: 0, unblockedByMerge: 0, invalidRecords: 0 }),
          getAudioDiagnostics: () => features.getDiagnostics(),
          exportJspf: async () => true,
          exportDossier: async () => true,
          launchDiscovery: async () => 0,
          getLastRadioTracks: () => [...lastRadio],
          getLastRadioTitle: () => lastRadioTitle,
          playTrack: async () => {},
          toggleAutopilot: () => autopilot.isEnabled(),
          isAutopilotOn: () => autopilot.isEnabled(),
          getFlags: () => flags,
          setFlags: () => {},
          getCapabilities: () => readStored(CAPABILITIES_KEY) as CapabilityReport | null,
          getEvaluation: () => readStored(EVALUATION_KEY) as EvaluationReport | null,
          launchClusterRadio: async () => {},
          exportLastRadio: async () => true,
          getRatedSources: async () => ({}),
          exportCovariance: async () => true,
          exportTransitionGraph: async () => true,
          probeCapture: () => localDsp.probeEnvironment(),
          isCapturing: () => localDsp.isCapturing(),
          toggleCapture: async () => false
        });

        const root = await testDash.render();
        genericModal.appendChild(root);

        for (const tabId of ['explain', 'ratings', 'blacklist', 'radios', 'preferences', 'science', 'data', 'perf']) {
          const t0 = Date.now();
          const btn = root.querySelector(`button[data-tab="${tabId}"]`) as HTMLButtonElement | null;
          btn?.click();
          await new Promise((r) => setTimeout(r, 20));
          const bodyHtmlLen = root.querySelector('.neuraltune-dashboard-body')?.innerHTML.length ?? 0;
          (results.tabs as Record<string, unknown>)[tabId] = {
            ok: bodyHtmlLen > 50 && !modalClosedByClick && btn?.getAttribute('aria-selected') === 'true',
            bodyHtmlLen,
            modalClosedByClick,
            ms: Date.now() - t0
          };
        }
      } finally {
        overlay.remove();
      }
      saveProgress('tabs-done');

      // 2. Test Deep Cuts discovery first (which also warms cachedExternalDiscovery for unheard radios)
      {
        const t0 = Date.now();
        const { found } = await findDiscoveries(false, shield);
        const ratedLeaks = found.filter((f) => shield.ratedUris.has(f.track.uri)).length;
        const likedLeaks = found.filter((f) => shield.likedUris.has(f.track.uri)).length;

        const ratings = await storage.getAllRatings();
        const knownArtists = new Set(ratings.flatMap((r) => r.metadata.artists.map((a) => a.uri)));
        const favorite = ratings.filter((r) => r.rating === 5).map((r) => r.metadata.artists[0]?.uri).find(Boolean);
        results.relatedArtists = favorite
          ? await fetchRelatedArtists(graphql, favorite).then(
              (uris) => ({ ok: uris.length > 0, loaded: Boolean(Spicetify.GraphQL?.Definitions?.queryArtistRelated), count: uris.length, unknown: uris.filter((uri) => !knownArtists.has(uri)).length }),
              (err) => ({ ok: false, loaded: Boolean(Spicetify.GraphQL?.Definitions?.queryArtistRelated), error: err instanceof Error ? err.message : String(err) })
            )
          : { ok: false, error: 'sem favoritos' };
        results.discoveryReach = {
          newArtistTracks: found.filter((f) => !f.track.artists.some((a) => knownArtists.has(a.uri))).length,
          total: found.length
        };

        results.deepCuts = {
          ok: found.length > 0 && found.every((f) => f.track.artists.length > 0) && ratedLeaks === 0 && likedLeaks === 0,
          tracks: found.length,
          ratedLeaks,
          likedLeaks,
          withArtists: found.filter((f) => f.track.artists.length > 0).length,
          fromAlbums: found.filter((f) => f.sourceArtist.startsWith('spotify:album:')).length,
          fromTopTracks: found.filter((f) => f.sourceArtist.startsWith('spotify:artist:')).length,
          sample: found[0] ? `${found[0].track.name} — ${found[0].track.artists[0]?.name ?? ''}` : null,
          ms: Date.now() - t0
        };
      }
      saveProgress('deepcuts-done');

      // 3. Test all 6 Preset Radios in dryRun mode (verifying 0 rated ★ and 0 liked ♥ tracks)
      for (const preset of ['preference', 'discovery', 'gym', 'work', 'study', 'relax']) {
        const t0 = Date.now();
        try {
          const tracks = await composeRadio(preset, null, { dryRun: true });
          const ratedLeaks = tracks.filter((t) => shield.ratedUris.has(t.uri)).length;
          const likedLeaks = tracks.filter((t) => shield.likedUris.has(t.uri)).length;
          const identityLeaks = tracks.filter((t) => shield.isExcluded(t)).length;
          (results.presetRadios as Record<string, unknown>)[preset] = {
            ok: tracks.length >= MIN_HARMONIC_QUEUE && ratedLeaks === 0 && likedLeaks === 0 && identityLeaks === 0,
            tracks: tracks.length,
            ratedLeaks,
            likedLeaks,
            sample: tracks[0] ? `${tracks[0].name} — ${tracks[0].artists[0]?.name ?? ''}` : null,
            ms: Date.now() - t0
          };
        } catch (err) {
          (results.presetRadios as Record<string, unknown>)[preset] = {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            ms: Date.now() - t0
          };
        }
      }
      saveProgress('presets-done');

      // 4. Test Custom Prompt Radios in dryRun mode
      for (const prompt of [
        'foco noturno instrumental lento',
        'treino pesado anos 90/2000',
        'músicas esquecidas sem repetir'
      ]) {
        const t0 = Date.now();
        try {
          const parsed = parseRadioPrompt(prompt);
          const tracks = await composeRadio('custom', parsed, { dryRun: true });
          const ratedLeaks = tracks.filter((t) => shield.ratedUris.has(t.uri)).length;
          const likedLeaks = tracks.filter((t) => shield.likedUris.has(t.uri)).length;
          (results.promptRadios as Record<string, unknown>)[prompt] = {
            ok: tracks.length >= MIN_HARMONIC_QUEUE && ratedLeaks === 0 && likedLeaks === 0,
            matched: parsed.matched,
            tracks: tracks.length,
            ratedLeaks,
            likedLeaks,
            sample: tracks[0] ? `${tracks[0].name} — ${tracks[0].artists[0]?.name ?? ''}` : null,
            ms: Date.now() - t0
          };
        } catch (err) {
          (results.promptRadios as Record<string, unknown>)[prompt] = {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            ms: Date.now() - t0
          };
        }
      }

      // 5. Test Cluster Radio in dryRun mode
      const clusters = preference.getModelSnapshot().clusters;
      if (clusters.length > 0) {
        const t0 = Date.now();
        const target = clusters[0].centroid.map((z, i) => POPULATION_MEAN[i] + z * POPULATION_STD[i]);
        const tracks = await composeRadio('custom', { ...parseRadioPrompt(''), targetVector: target }, { dryRun: true });
        const ratedLeaks = tracks.filter((t) => shield.ratedUris.has(t.uri)).length;
        const likedLeaks = tracks.filter((t) => shield.likedUris.has(t.uri)).length;
        results.clusterRadio = {
          ok: tracks.length >= MIN_HARMONIC_QUEUE && ratedLeaks === 0 && likedLeaks === 0,
          clustersCount: clusters.length,
          tracks: tracks.length,
          ratedLeaks,
          likedLeaks,
          ms: Date.now() - t0
        };
      } else {
        results.clusterRadio = { ok: true, clustersCount: 0, note: 'no clusters yet' };
      }

      // 6. Test Autopilot candidate generation
      {
        const t0 = Date.now();
        const preds = await eligiblePredictions();
        const composed = resonance.compose(preds, { length: 3 }).tracks;
        const ratedLeaks = composed.filter((t) => shield.ratedUris.has(t.uri)).length;
        const likedLeaks = composed.filter((t) => shield.likedUris.has(t.uri)).length;
        results.autopilot = {
          ok: composed.length === 3 && ratedLeaks === 0 && likedLeaks === 0,
          enabled: autopilot.isEnabled(),
          eligiblePool: preds.length,
          generated: composed.length,
          ratedLeaks,
          likedLeaks,
          ms: Date.now() - t0
        };
      }

      results.totalMs = Date.now() - startedAt;
      results.allPassed =
        Object.values(results.tabs as Record<string, { ok: boolean }>).every((t) => t.ok) &&
        Object.values(results.presetRadios as Record<string, { ok: boolean }>).every((r) => r.ok) &&
        Object.values(results.promptRadios as Record<string, { ok: boolean }>).every((r) => r.ok) &&
        (results.clusterRadio as { ok: boolean })?.ok === true &&
        (results.deepCuts as { ok: boolean })?.ok === true &&
        (results.autopilot as { ok: boolean })?.ok === true;
      saveProgress('completed');
    } catch (err) {
      results.fatalError = err instanceof Error ? err.message : String(err);
      results.allPassed = false;
      saveProgress('failed');
    }

    return results;
  }

  setTimeout(() => {
    const prev = readStored('neuraltune:self-test-v14') as { allPassed?: boolean } | null;
    if (!prev?.allPassed) {
      runLiveSelfTest().catch((e) => console.warn('[NeuralTune] Self-test error', e));
    }
  }, 5000);

  setTimeout(() => {
    runCapabilityProbe().catch((e) => console.warn('[NeuralTune] Capability probe error', e));
  }, PROBE_DELAY_MS);

  setTimeout(() => {
    runEvaluation().catch((e) => console.warn('[NeuralTune] Evaluation error', e));
  }, EVALUATION_DELAY_MS);

  console.log('[NeuralTune] ✅ Pronto e Ativo! Pressione Ctrl+Alt+M para abrir o Dashboard.');
})();
