import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { RatingManager } from '../src/core/RatingManager.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { PreferenceEngine } from '../src/core/PreferenceEngine.ts';
import { ExplainabilityEngine } from '../src/explainability/ExplainabilityEngine.ts';
import { PerformanceMonitor } from '../src/optimization/PerformanceMonitor.ts';
import { AutonomousDiscoveryCrawler } from '../src/discovery/AutonomousDiscoveryCrawler.ts';
import { createGraphqlDiscoveryBridge } from '../src/discovery/GraphqlDiscoveryBridge.ts';
import { CandidateHarvester } from '../src/radios/CandidateHarvester.ts';
import { SmartPlaybackEngine } from '../src/queue/SmartPlaybackEngine.ts';
import { DEFAULT_FLAGS } from '../src/core/FeatureFlags.ts';
import { TrackMetadata } from '../src/types/index.ts';
import type { DashboardDependencies } from '../src/ui/DashboardModal.ts';

/**
 * Minimal DOM + Event bubbling + microtask checkpoint simulator that reproduces
 * Spicetify.PopupModal's `.GenericModal__overlay` click-outside behavior:
 *   overlay.addEventListener("click", f => {
 *     overlay.querySelector(".GenericModal").contains(f.target) || hide()
 *   })
 */
class TestDomNode {
  tagName: string;
  id = '';
  className = '';
  type = '';
  value = '';
  disabled = false;
  checked = false;
  innerText = '';
  textContent = '';
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: TestDomNode[] = [];
  parentElement: TestDomNode | null = null;
  style: Record<string, string> & { cssText: string } = { cssText: '' };
  onclick: ((e: TestDomEvent) => unknown) | null = null;
  private listeners = new Map<string, Array<(e: TestDomEvent) => unknown>>();
  private rawHtml = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get innerHTML(): string {
    return this.rawHtml;
  }

  set innerHTML(html: string) {
    this.rawHtml = html;
    this.children = [];
    if (!html.trim()) return;
    parseInteractiveElements(html, this);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) {
      const camel = name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      this.dataset[camel] = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name === 'id' && this.id) return this.id;
    if (name === 'class' && this.className) return this.className;
    if (name.startsWith('data-')) {
      const camel = name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (this.dataset[camel] !== undefined) return this.dataset[camel];
    }
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: TestDomNode): TestDomNode {
    if (child.parentElement) {
      child.parentElement.removeChild(child);
    }
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  append(...nodes: TestDomNode[]) {
    for (const n of nodes) this.appendChild(n);
  }

  removeChild(child: TestDomNode) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  replaceWith(replacement: TestDomNode) {
    const parent = this.parentElement;
    if (!parent) return;
    const idx = parent.children.indexOf(this);
    if (idx >= 0) {
      if (replacement.parentElement) replacement.parentElement.removeChild(replacement);
      parent.children[idx] = replacement;
      replacement.parentElement = parent;
      this.parentElement = null;
    }
  }

  contains(other: TestDomNode | null): boolean {
    let cur: TestDomNode | null = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  closest(selector: string): TestDomNode | null {
    let cur: TestDomNode | null = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const attrMatch = /^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/.exec(selector);
    if (attrMatch) return this.getAttribute(attrMatch[1]) === attrMatch[2];
    return this.tagName === selector.toUpperCase();
  }

  querySelector(selector: string): TestDomNode | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector: string): TestDomNode[] {
    const out: TestDomNode[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) out.push(child);
      out.push(...child.querySelectorAll(selector));
    }
    return out;
  }

  addEventListener(type: string, listener: (e: TestDomEvent) => unknown) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  /**
   * Simulates browser event dispatch with V8 microtask checkpoint between target
   * listener completion and parent bubble listeners (matching Chromium/CEF behavior).
   */
  async dispatchClick(): Promise<void> {
    const event = new TestDomEvent('click', this);
    const path: TestDomNode[] = [];
    let cur: TestDomNode | null = this;
    while (cur) {
      path.push(cur);
      cur = cur.parentElement;
    }

    for (const node of path) {
      if (event.propagationStopped) break;
      event.currentTarget = node;
      if (node.onclick) {
        await node.onclick(event);
      }
      const handlers = node.listeners.get('click') ?? [];
      for (const h of handlers) {
        await h(event);
      }
      // Microtask checkpoint after each node's listeners finish
      await Promise.resolve();
    }
  }

  async dispatchKeydown(key: string): Promise<void> {
    const event = new TestDomEvent('keydown', this, key);
    event.currentTarget = this;
    const handlers = this.listeners.get('keydown') ?? [];
    for (const h of handlers) {
      await h(event);
    }
  }
}

class TestDomEvent {
  type: string;
  target: TestDomNode;
  currentTarget: TestDomNode;
  key?: string;
  propagationStopped = false;

  constructor(type: string, target: TestDomNode, key?: string) {
    this.type = type;
    this.target = target;
    this.currentTarget = target;
    this.key = key;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

/** Extracts interactive controls with id/class/data-* from template HTML into FakeDOM children. */
function parseInteractiveElements(html: string, parent: TestDomNode) {
  const tagRegex = /<(button|input|select|div|tr)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(html)) !== null) {
    const [, tag, attrs, inner = ''] = match;
    const node = new TestDomNode(tag);
    const attrRegex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRegex.exec(attrs)) !== null) {
      node.setAttribute(a[1], a[2]);
    }
    const strippedText = inner.replace(/<[^>]+>/g, '').trim();
    if (strippedText) {
      node.textContent = strippedText;
      node.innerText = strippedText;
    }
    if (inner && /<(button|input|select|div)\b/i.test(inner)) {
      parseInteractiveElements(inner, node);
    }
    parent.appendChild(node);
  }
}

if (!(globalThis as Record<string, unknown>).document) {
  Object.assign(globalThis, {
    document: {
      createElement: (tag: string) => new TestDomNode(tag),
      createElementNS: (_ns: string, tag: string) => new TestDomNode(tag),
      querySelector: () => null
    }
  });
}

const { DashboardModal } = await import('../src/ui/DashboardModal.ts');

/**
 * Mounts DashboardModal inside a faithful replica of Spicetify.PopupModal's DOM structure
 * (`spicetifyWrapper.js` line 76):
 *   overlay.addEventListener("click", f => {
 *     overlay.querySelector(".GenericModal").contains(f.target) || hide()
 *   })
 */
function mountInSpicetifyPopupModal(content: TestDomNode) {
  const overlay = new TestDomNode('div');
  overlay.className = 'GenericModal__overlay';
  const genericModal = new TestDomNode('div');
  genericModal.className = 'GenericModal';
  genericModal.appendChild(content);
  overlay.appendChild(genericModal);

  let isModalOpen = true;
  let closeCount = 0;

  overlay.addEventListener('click', (f) => {
    const modal = overlay.querySelector('.GenericModal');
    if (!modal || !modal.contains(f.target)) {
      isModalOpen = false;
      closeCount++;
      genericModal.remove();
    }
  });

  return {
    overlay,
    genericModal,
    isModalOpen: () => isModalOpen,
    getCloseCount: () => closeCount
  };
}

function makeTrack(id: string, name: string, artistId: string, artistName: string, albumId = 'alb1'): TrackMetadata {
  return {
    uri: `spotify:track:${id}`,
    name,
    artists: [{ uri: `spotify:artist:${artistId}`, name: artistName }],
    album: { uri: `spotify:album:${albumId}`, name: `Album ${albumId}` }
  };
}

async function createTestHarness(overrides: Partial<DashboardDependencies> = {}) {
  const prevDoc = (globalThis as Record<string, unknown>).document;
  Object.assign(globalThis, {
    document: {
      createElement: (tag: string) => new TestDomNode(tag),
      createElementNS: (_ns: string, tag: string) => new TestDomNode(tag),
      querySelector: () => null
    }
  });

  const storage = new MemoryStorage();
  const ratingManager = new RatingManager(storage);
  const blacklistManager = new BlacklistManager(storage);
  const preferenceEngine = new PreferenceEngine(storage);
  const explainabilityEngine = new ExplainabilityEngine();
  const performanceMonitor = new PerformanceMonitor();

  // Seed ratings so PreferenceEngine & Deep Cuts have favorite artists/albums
  const favTrack = makeTrack('fav1', 'Favorite Song', 'art1', 'Daft Punk', 'alb_fav');
  await ratingManager.rateTrack(favTrack, 5);
  await blacklistManager.init();
  await preferenceEngine.init();

  let lastRadioTracks: TrackMetadata[] = [];
  let lastRadioTitle = '';
  const playedUris: string[] = [];
  const queuedUris: string[] = [];
  let autopilotOn = false;
  let flags = { ...DEFAULT_FLAGS };

  const smartPlayback = new SmartPlaybackEngine(blacklistManager, preferenceEngine, {
    async playTrack(uri: string) {
      playedUris.push(uri);
    },
    async addToQueue(tracks: Array<{ uri: string }>) {
      queuedUris.push(...tracks.map((t) => t.uri));
    },
    notify() {}
  });

  const crawler = new AutonomousDiscoveryCrawler(
    {
      async fetchArtistAlbums(artistUri: string) {
        return [`spotify:album:new_${artistUri.split(':').pop()}`];
      },
      async fetchAlbumDeepCuts(albumUri: string) {
        if (albumUri === 'spotify:album:alb_fav') {
          return [
            { track: favTrack, popularity: 80 }, // already in history, must be filtered out
            { track: makeTrack('dc_album_1', 'Album Deep Cut 1', 'art1', 'Daft Punk', 'alb_fav'), popularity: 25 },
            { track: makeTrack('dc_album_2', 'Album Deep Cut 2', 'art1', 'Daft Punk', 'alb_fav'), popularity: 30 },
            { track: makeTrack('dc_blocked', 'Blocked Song', 'art_blocked', 'Blocked Artist', 'alb_fav'), popularity: 20 }
          ];
        }
        return [];
      },
      async fetchAlbumTracks() {
        return [
          { track: makeTrack('dc_top_1', 'Artist Deep Cut 1', 'art1', 'Daft Punk', 'alb_new'), popularity: 40 },
          { track: makeTrack('dc_top_2', 'Artist Deep Cut 2', 'art1', 'Daft Punk', 'alb_new'), popularity: 35 }
        ];
      }
    },
    blacklistManager,
    preferenceEngine
  );

  await blacklistManager.blockArtist('spotify:artist:art_blocked', 'Blocked Artist');

  const deps: DashboardDependencies = {
    ratingManager,
    blacklistManager,
    preferenceEngine,
    explainabilityEngine,
    performanceMonitor,
    getCurrentTrack: () => favTrack,
    async launchRadio(type: string) {
      const tracks = [
        makeTrack(`rad_${type}_1`, `${type.toUpperCase()} Track 1`, 'art1', 'Daft Punk'),
        makeTrack(`rad_${type}_2`, `${type.toUpperCase()} Track 2`, 'art2', 'Justice')
      ];
      lastRadioTracks = tracks;
      lastRadioTitle = `Rádio (${type})`;
      await smartPlayback.startPlayback(tracks);
    },
    async launchPromptRadio(prompt: string) {
      const tracks = [
        makeTrack('prompt_1', `Prompt Track (${prompt})`, 'art1', 'Daft Punk')
      ];
      lastRadioTracks = tracks;
      lastRadioTitle = `Rádio Personalizada (${prompt})`;
      await smartPlayback.startPlayback(tracks);
      return ['foco', 'instrumental'];
    },
    async launchDiscovery() {
      const history = new Set([favTrack.uri]);
      const found = await crawler.crawl(['spotify:artist:art1'], history, 30, ['spotify:album:alb_fav']);
      const tracks = found.map((f) => f.track);
      lastRadioTracks = tracks;
      lastRadioTitle = 'Deep Cuts — Faixas fora do histórico';
      if (tracks.length > 0) {
        await smartPlayback.startPlayback(tracks);
      }
      return tracks.length;
    },
    getLastRadioTracks: () => [...lastRadioTracks],
    getLastRadioTitle: () => lastRadioTitle,
    async playTrack(uri: string) {
      const idx = lastRadioTracks.findIndex((t) => t.uri === uri);
      if (idx >= 0) {
        await smartPlayback.startPlayback([...lastRadioTracks.slice(idx), ...lastRadioTracks.slice(0, idx)]);
      } else {
        playedUris.push(uri);
      }
    },
    importTrashbin: async () => ({ importedSongs: 0, importedArtists: 0 }),
    exportJson: async () => true,
    exportCsv: async () => true,
    syncPlaylists: async () => [],
    importFile: async () => ({
      addedRatings: 0,
      replacedRatings: 0,
      keptLocal: 0,
      conflicts: 0,
      addedArtists: 0,
      addedPlayEvents: 0,
      unblockedByMerge: 0,
      invalidRecords: 0
    }),
    getAudioDiagnostics: () => ({ status: 'available', cachedTracks: 10, lastError: null }),
    exportDossier: async () => true,
    toggleAutopilot: () => {
      autopilotOn = !autopilotOn;
      return autopilotOn;
    },
    isAutopilotOn: () => autopilotOn,
    getFlags: () => flags,
    setFlags: (next) => { flags = next; },
    getCapabilities: () => null,
    getEvaluation: () => null,
    launchClusterRadio: async () => {},
    exportJspf: async () => true,
    exportLastRadio: async () => lastRadioTracks.length > 0,
    getRatedSources: async () => ({ local: 1 }),
    exportCovariance: async () => true,
    exportTransitionGraph: async () => true,
    probeCapture: async () => ({ supported: true, loopbackInputs: ['Stereo Mix'], allInputs: ['Stereo Mix'] }),
    toggleCapture: async () => false,
    isCapturing: () => false,
    ...overrides
  };

  const modal = new DashboardModal(deps);
  return {
    modal,
    deps,
    playedUris,
    queuedUris,
    restoreDoc: () => {
      Object.assign(globalThis, { document: prevDoc });
    }
  };
}

test('DashboardModal: clicking Rádios Personalizadas opens the tab without triggering Spicetify.PopupModal close', async () => {
  const { modal, restoreDoc } = await createTestHarness();
  try {
    const content = (await modal.render()) as unknown as TestDomNode;
    const popup = mountInSpicetifyPopupModal(content);

    const radiosTabBtn = content.querySelector('[data-tab="radios"]');
    assert.ok(radiosTabBtn, 'Botão da aba Rádios Personalizadas deve existir');

    await radiosTabBtn.dispatchClick();

    assert.equal(popup.isModalOpen(), true, 'O modal NÃO deve fechar ao clicar em Rádios Personalizadas');
    assert.equal(popup.getCloseCount(), 0);
    assert.equal(popup.genericModal.contains(radiosTabBtn), true, 'O botão clicado deve permanecer conectado ao GenericModal');
    assert.equal(radiosTabBtn.getAttribute('aria-selected'), 'true');

    const discoveryBtn = content.querySelector('#nt-discovery');
    assert.ok(discoveryBtn, 'Botão Deep Cuts: faixas fora do histórico deve ser renderizado');
    assert.equal(discoveryBtn.textContent, 'Deep Cuts: faixas fora do histórico');

    const radioButtons = content.querySelectorAll('.nt-launch-radio');
    assert.equal(radioButtons.length, 6, 'Todas as 6 rádios pré-configuradas devem estar visíveis');
  } finally {
    restoreDoc();
  }
});

test('DashboardModal: switching repeatedly across all 8 tabs and reopening preserves modal state', async () => {
  const { modal, restoreDoc } = await createTestHarness();
  try {
    const content = (await modal.render()) as unknown as TestDomNode;
    const popup = mountInSpicetifyPopupModal(content);

    const tabIds = ['radios', 'explain', 'ratings', 'blacklist', 'radios', 'preferences', 'science', 'data', 'perf', 'radios'];
    for (const id of tabIds) {
      const btn = content.querySelector(`[data-tab="${id}"]`);
      assert.ok(btn, `Aba ${id} deve existir`);
      await btn.dispatchClick();
      assert.equal(popup.isModalOpen(), true, `Modal deve permanecer aberto após clicar na aba ${id}`);
      assert.equal(btn.getAttribute('aria-selected'), 'true');
    }

    assert.ok(content.querySelector('#nt-discovery'), 'Aba Rádios Personalizadas deve continuar funcional após múltiplas trocas');
  } finally {
    restoreDoc();
  }
});

test('DashboardModal + Deep Cuts: clicking Deep Cuts runs crawler, filters history/blacklist, displays tracks, and plays clicked track', async () => {
  const { modal, playedUris, queuedUris, restoreDoc } = await createTestHarness();
  try {
    const content = (await modal.render()) as unknown as TestDomNode;
    const popup = mountInSpicetifyPopupModal(content);

    await content.querySelector('[data-tab="radios"]')!.dispatchClick();
    const discoveryBtn = content.querySelector('#nt-discovery')!;
    await discoveryBtn.dispatchClick();

    assert.equal(popup.isModalOpen(), true, 'Modal deve continuar aberto após executar Deep Cuts');

    const status = content.querySelector('#nt-radio-prompt-status')!;
    assert.equal(status.textContent, '4 faixas novas na fila.');

    const rows = content.querySelectorAll('.nt-radio-track-row');
    assert.equal(rows.length, 4, 'Deve exibir as 4 faixas descobertas (excluindo histórico e artista bloqueado)');
    const renderedUris = rows.map((r) => r.dataset.uri);
    assert.ok(!renderedUris.includes('spotify:track:fav1'), 'Faixa já avaliada/ouvida não deve entrar nos Deep Cuts');
    assert.ok(!renderedUris.includes('spotify:track:dc_blocked'), 'Artista bloqueado não deve entrar nos Deep Cuts');
    assert.ok(renderedUris.includes('spotify:track:dc_album_1'));
    assert.ok(renderedUris.includes('spotify:track:dc_top_1'));

    // SmartPlayback started automatically with the first discovered track
    assert.equal(playedUris.length, 1);
    assert.equal( queuedUris.length, 3);

    // Click on the 3rd recommended track in the UI list to play it directly
    const playButtons = content.querySelectorAll('.nt-play-track');
    assert.equal(playButtons.length, 4);
    const targetUri = playButtons[2].dataset.uri;
    await playButtons[2].dispatchClick();

    assert.equal(popup.isModalOpen(), true, 'Clicar para tocar uma faixa recomendada não deve fechar o modal');
    assert.equal(playedUris[playedUris.length - 1], targetUri, 'A faixa clicada deve ser reproduzida no Spotify');
  } finally {
    restoreDoc();
  }
});

test('DashboardModal: preset radios and prompt radio render recommendations and start playback', async () => {
  const { modal, playedUris, restoreDoc } = await createTestHarness();
  try {
    const content = (await modal.render()) as unknown as TestDomNode;
    mountInSpicetifyPopupModal(content);

    await content.querySelector('[data-tab="radios"]')!.dispatchClick();

    // Launch Gym radio
    const gymBtn = content.querySelector('[data-type="gym"]')!;
    await gymBtn.dispatchClick();

    let rows = content.querySelectorAll('.nt-radio-track-row');
    assert.equal(rows.length, 2, 'Rádio Academia deve exibir as 2 faixas geradas');
    assert.equal(playedUris[playedUris.length - 1], 'spotify:track:rad_gym_1');

    // Launch Prompt radio
    const promptInput = content.querySelector('#nt-radio-prompt')!;
    promptInput.value = 'foco noturno instrumental';
    const goBtn = content.querySelector('#nt-radio-prompt-go')!;
    await goBtn.dispatchClick();

    rows = content.querySelectorAll('.nt-radio-track-row');
    assert.equal(rows.length, 1, 'Rádio por prompt deve atualizar a lista de recomendações');
    assert.equal(playedUris[playedUris.length - 1], 'spotify:track:prompt_1');
  } finally {
    restoreDoc();
  }
});

test('DashboardModal: handles empty Deep Cuts and async failures gracefully with functional retry button', async () => {
  let attempts = 0;
  let customTracks: TrackMetadata[] = [];
  const { modal, restoreDoc } = await createTestHarness({
    async launchDiscovery() {
      attempts++;
      if (attempts === 1) {
        throw new Error('Falha temporária no GraphQL');
      }
      if (attempts === 2) {
        customTracks = [];
        return 0;
      }
      customTracks = [makeTrack('rec_1', 'Recovered Deep Cut', 'art1', 'Daft Punk')];
      return 1;
    },
    getLastRadioTracks: () => customTracks
  });

  const origError = console.error;
  console.error = () => {};
  try {
    const content = (await modal.render()) as unknown as TestDomNode;
    const popup = mountInSpicetifyPopupModal(content);

    await content.querySelector('[data-tab="radios"]')!.dispatchClick();
    const discoveryBtn = content.querySelector('#nt-discovery')!;

    // 1st attempt: throws error -> shows message + retry button without breaking tab
    await discoveryBtn.dispatchClick();
    assert.equal(popup.isModalOpen(), true);
    const status = content.querySelector('#nt-radio-prompt-status')!;
    assert.ok(status.textContent.includes('Falha temporária no GraphQL'));
    let retryBtn = content.querySelector('#nt-radio-retry');
    assert.ok(retryBtn, 'Botão Tentar novamente deve aparecer após erro');

    // 2nd attempt via retry button: returns 0 tracks -> shows empty message + retry button
    await retryBtn.dispatchClick();
    assert.equal(attempts, 2);
    assert.equal(status.textContent, 'O Spotify não entregou faixas novas agora.');
    retryBtn = content.querySelector('#nt-radio-retry');
    assert.ok(retryBtn, 'Botão Tentar novamente deve permanecer disponível quando 0 faixas retornam');

    // 3rd attempt via retry button: succeeds -> renders track list
    await retryBtn.dispatchClick();
    assert.equal(attempts, 3);
    assert.equal(status.textContent, '1 faixas novas na fila.');
    const rows = content.querySelectorAll('.nt-radio-track-row');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dataset.uri, 'spotify:track:rec_1');
  } finally {
    console.error = origError;
    restoreDoc();
  }
});

test('SmartPlaybackEngine: startPlayback uses setQueue to replace prior queue instead of duplicating tracks', async () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const preference = new PreferenceEngine(storage);
  await blacklist.init();
  await preference.init();

  let activeQueue: string[] = ['spotify:track:old_1', 'spotify:track:old_2'];
  const played: string[] = [];

  const engine = new SmartPlaybackEngine(blacklist, preference, {
    async playTrack(uri: string) {
      played.push(uri);
    },
    async addToQueue(tracks: Array<{ uri: string }>) {
      activeQueue.push(...tracks.map((t) => t.uri));
    },
    async setQueue(tracks: Array<{ uri: string }>) {
      activeQueue = tracks.map((t) => t.uri);
    },
    notify() {}
  });

  await engine.startPlayback([
    makeTrack('new1', 'New 1', 'art1', 'Artist 1'),
    makeTrack('new2', 'New 2', 'art2', 'Artist 2'),
    makeTrack('new3', 'New 3', 'art3', 'Artist 3')
  ]);

  assert.equal(played.length, 1);
  assert.ok(!activeQueue.includes('spotify:track:old_1'), 'Fila antiga deve ser limpa ao iniciar nova rádio');
  assert.equal(activeQueue.length, 2, 'Apenas as faixas seguintes da nova rádio devem estar na fila');
});

test('createGraphqlDiscoveryBridge: preserves fetchAlbumDeepCuts and falls back when queryAlbumTracks is missing', async () => {
  const graphql = async (op: string) => {
    if (op === 'getAlbumNameAndTracks') {
      return {
        data: {
          album: {
            tracks: [{ uri: 'spotify:track:giorgio' }]
          }
        }
      };
    }
    if (op === 'getArtistNameAndTracks') {
      return {
        data: {
          artist: {
            topTracks: { items: [{ uri: 'spotify:track:veridis' }] }
          }
        }
      };
    }
    if (op === 'getTrackName') {
      return { data: { trackUnion: { name: 'Giorgio by Moroder' } } };
    }
    if (op === 'queryTrackArtists') {
      return { data: { trackUnion: { artists: [{ uri: 'spotify:artist:daft', profile: { name: 'Daft Punk' } }] } } };
    }
    return {};
  };

  // Simulate user visiting Artist page (queryArtistDiscographyAlbums defined) without visiting Album page (queryAlbumTracks undefined)
  const bridge = createGraphqlDiscoveryBridge(graphql, '', {
    queryArtistDiscographyAlbums: {}
  });

  assert.equal(typeof bridge.fetchAlbumDeepCuts, 'function', 'fetchAlbumDeepCuts deve estar presente na ponte GraphQL');
  const albumCuts = await bridge.fetchAlbumDeepCuts!('spotify:album:ram', new Set());
  assert.equal(albumCuts.length, 1);
  assert.equal(albumCuts[0].track.name, 'Giorgio by Moroder');
  assert.equal(albumCuts[0].track.artists[0].name, 'Daft Punk');

  // Fallback for artist tracks when queryAlbumTracks is absent
  assert.equal(typeof bridge.fetchArtistTracks, 'function', 'fetchArtistTracks deve estar ativo quando queryAlbumTracks está ausente');
  const artistCuts = await bridge.fetchArtistTracks!('spotify:artist:daft', new Set());
  assert.equal(artistCuts.length, 1);
  assert.equal(artistCuts[0].track.uri, 'spotify:track:veridis');
  assert.equal(artistCuts[0].track.artists[0].uri, 'spotify:artist:daft');
});

test('CandidateHarvester: harvests playlists in parallel batches and tolerates individual playlist errors', async () => {
  const storage = new MemoryStorage();
  let concurrent = 0;
  let maxConcurrent = 0;

  const harvester = new CandidateHarvester(storage, {
    async fetchLibraryPage() {
      return [];
    },
    async listPlaylists() {
      return Array.from({ length: 12 }, (_, i) => `spotify:playlist:pl_${i}`);
    },
    async fetchPlaylistTracks(uri: string) {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      if (uri === 'spotify:playlist:pl_3') {
        throw new Error('Playlist inacessível');
      }
      return [makeTrack(`t_${uri.split('_').pop()}`, `Track ${uri}`, 'art1', 'Artist 1')];
    }
  });

  const result = await harvester.harvest();
  assert.ok(maxConcurrent > 1 && maxConcurrent <= 5, `Concorrência deve operar em lotes paralelos (observado: ${maxConcurrent})`);
  assert.equal(result.tracks.length, 11, 'As 11 playlists válidas devem ser colhidas mesmo quando 1 falha');
});

test('DashboardModal: clicking Cluster Radio in PreferencesTab launches cluster radio and navigates to Rádios Personalizadas', async () => {
  let clusterLaunched = false;
  let clusterTracks: TrackMetadata[] = [];
  const { modal, deps, restoreDoc } = await createTestHarness({
    async launchClusterRadio() {
      clusterLaunched = true;
      clusterTracks = [makeTrack('cl_1', 'Cluster Track 1', 'art1', 'Daft Punk')];
    },
    getLastRadioTracks: () => clusterTracks,
    getLastRadioTitle: () => 'Rádio de Cluster'
  });

  try {
    // Seed 5 acoustic-rated tracks so PreferenceEngine forms at least 1 Taste Cluster
    for (let i = 0; i < 6; i++) {
      await deps.ratingManager.rateTrack({
        ...makeTrack(`ac_${i}`, `Acoustic ${i}`, 'art1', 'Daft Punk'),
        acousticFeatures: {
          energy: 0.8,
          valence: 0.7,
          tempo: 124,
          danceability: 0.85,
          acousticness: 0.1,
          instrumentalness: 0.6,
          speechiness: 0.05,
          liveness: 0.1,
          source: 'local-analysis'
        }
      }, 5);
    }
    await deps.preferenceEngine.reloadFromStorage();

    const content = (await modal.render()) as unknown as TestDomNode;
    const popup = mountInSpicetifyPopupModal(content);

    await content.querySelector('[data-tab="preferences"]')!.dispatchClick();
    const clusterBtn = content.querySelector('.nt-cluster-radio');
    assert.ok(clusterBtn, 'Botão Rádio do cluster deve existir na aba Preferências Aprendidas');

    await clusterBtn.dispatchClick();

    assert.equal(popup.isModalOpen(), true, 'Clicar no botão Rádio do cluster não deve fechar o modal');
    assert.equal(clusterLaunched, true, 'launchClusterRadio deve ser chamado');
    const radiosTab = content.querySelector('[data-tab="radios"]')!;
    assert.equal(radiosTab.getAttribute('aria-selected'), 'true', 'Deve navegar automaticamente para a aba Rádios Personalizadas');
    const rows = content.querySelectorAll('.nt-radio-track-row');
    assert.equal(rows.length, 1, 'Deve renderizar as faixas da Rádio de Cluster');
  } finally {
    restoreDoc();
  }
});

test('CandidateHarvester: exposes ratedUris and libraryUris for strict exclusion of rated and liked songs', async () => {
  const storage = new MemoryStorage();
  const ratedTrack = makeTrack('rated_5', 'Rated Song', 'art1', 'Daft Punk');
  const likedTrack = makeTrack('liked_1', 'Liked Song', 'art2', 'Justice');
  const unheardPlaylistTrack = makeTrack('unheard_1', 'Unheard Playlist Song', 'art3', 'Kavinsky');

  await storage.saveRating({ uri: ratedTrack.uri, rating: 5, timestamp: 1, metadata: ratedTrack });

  const harvester = new CandidateHarvester(storage, {
    async fetchLibraryPage() {
      return [likedTrack];
    },
    async listPlaylists() {
      return ['spotify:playlist:mix1'];
    },
    async fetchPlaylistTracks() {
      return [ratedTrack, likedTrack, unheardPlaylistTrack];
    }
  });

  const harvest = await harvester.harvest();
  assert.equal(harvest.ratedUris.has(ratedTrack.uri), true, 'ratedUris deve conter faixas avaliadas com estrelas');
  assert.equal(harvest.libraryUris.has(likedTrack.uri), true, 'libraryUris deve conter faixas curtidas na biblioteca');

  const unheardOnly = harvest.tracks.filter(
    (t) => !harvest.ratedUris.has(t.uri) && !harvest.libraryUris.has(t.uri)
  );
  assert.equal(unheardOnly.length, 1);
  assert.equal(unheardOnly[0].uri, unheardPlaylistTrack.uri);
});

test('DashboardModal: quick-prompt chips, refresh button, unheard shield, and inline track rating remove rated track from list', async () => {
  let activeTracks: TrackMetadata[] = [
    makeTrack('u1', 'Unheard Song 1', 'art1', 'Daft Punk'),
    makeTrack('u2', 'Unheard Song 2', 'art2', 'Justice')
  ];
  let refreshCalled = false;
  const ratedInUi: Array<{ uri: string; rating: number }> = [];

  const { modal, restoreDoc } = await createTestHarness({
    getShieldStats: async () => ({ rated: 658, liked: 500, blocked: 42 }),
    getLastRadioTracks: () => [...activeTracks],
    getLastRadioTitle: () => 'Rádio Inédita',
    async launchPromptRadio(prompt: string) {
      activeTracks = [
        makeTrack('qp1', `Quick (${prompt}) 1`, 'art1', 'Daft Punk'),
        makeTrack('qp2', `Quick (${prompt}) 2`, 'art2', 'Justice')
      ];
      return ['instrumental', 'foco'];
    },
    async refreshLastRadio() {
      refreshCalled = true;
      activeTracks = [
        makeTrack('fresh1', 'Fresh Song 1', 'art3', 'Kavinsky'),
        makeTrack('fresh2', 'Fresh Song 2', 'art4', 'Modjo')
      ];
    },
    async rateRecommendedTrack(track, rating) {
      ratedInUi.push({ uri: track.uri, rating });
      activeTracks = activeTracks.filter((t) => t.uri !== track.uri);
    }
  });

  try {
    const content = (await modal.render()) as unknown as TestDomNode;
    const popup = mountInSpicetifyPopupModal(content);

    await content.querySelector('[data-tab="radios"]')!.dispatchClick();

    // 1. Verify Unheard Shield banner shows live statistics
    const shieldBanner = content.querySelector('#nt-unheard-shield');
    assert.ok(shieldBanner, 'Banner do Modo 100% Inéditas deve estar visível');
    assert.ok(shieldBanner.textContent.includes('658 com estrelas'));
    assert.ok(shieldBanner.textContent.includes('500 curtidas'));

    // 2. Click a 1-click Quick Prompt chip
    const quickChips = content.querySelectorAll('.nt-quick-prompt');
    assert.ok(quickChips.length >= 4, 'Chips de sugestões rápidas de prompt devem existir');
    await quickChips[0].dispatchClick();
    assert.equal(popup.isModalOpen(), true, 'Clicar em um chip rápido não deve fechar o modal');
    assert.equal(content.querySelectorAll('.nt-radio-track-row').length, 2);

    // 3. Rate the first recommended track with 5★ inline -> must remove it from the unheard list without closing modal
    const rateButtons = content.querySelectorAll('.nt-rate-rec');
    const fiveStarBtn = rateButtons.find((b) => b.dataset.rating === '5' && b.dataset.uri === 'spotify:track:qp1');
    assert.ok(fiveStarBtn, 'Botão inline de 5★ deve existir na linha da música recomendada');
    await fiveStarBtn.dispatchClick();

    assert.equal(popup.isModalOpen(), true, 'Avaliar faixa recomendada inline não deve fechar o modal');
    assert.equal(ratedInUi.length, 1);
    assert.equal(ratedInUi[0].uri, 'spotify:track:qp1');
    assert.equal(ratedInUi[0].rating, 5);
    assert.equal(content.querySelectorAll('.nt-radio-track-row').length, 1, 'Faixa avaliada deve sair imediatamente da lista de inéditas');

    // 4. Click Nova Seleção (#nt-radio-refresh) -> refreshes with brand-new tracks
    const refreshBtn = content.querySelector('#nt-radio-refresh');
    assert.ok(refreshBtn, 'Botão Nova Seleção deve existir');
    await refreshBtn.dispatchClick();
    assert.equal(popup.isModalOpen(), true);
    assert.equal(refreshCalled, true);
    const updatedRows = content.querySelectorAll('.nt-radio-track-row');
    assert.equal(updatedRows.length, 2);
    assert.equal(updatedRows[0].dataset.uri, 'spotify:track:fresh1');
  } finally {
    restoreDoc();
  }
});

test('DashboardModal: Nova Seleção que falha mostra o erro e libera os botões', async () => {
  const tracks = [makeTrack('s1', 'Song 1', 'art1', 'Daft Punk'), makeTrack('s2', 'Song 2', 'art2', 'Justice')];
  const { modal, restoreDoc } = await createTestHarness({
    getLastRadioTracks: () => [...tracks],
    getLastRadioTitle: () => 'Rádio',
    async refreshLastRadio() {
      throw new Error('GraphQL fora do ar');
    }
  });

  try {
    const content = (await modal.render()) as unknown as TestDomNode;
    mountInSpicetifyPopupModal(content);
    await content.querySelector('[data-tab="radios"]')!.dispatchClick();

    await content.querySelector('#nt-radio-refresh')!.dispatchClick();

    assert.match(content.querySelector('#nt-radio-prompt-status')!.textContent, /GraphQL fora do ar/);
    assert.ok(content.querySelector('#nt-radio-retry') || content.querySelector('#nt-radio-prompt-status'));
    assert.equal(content.querySelector('.nt-launch-radio')!.disabled, false, 'os botões não podem ficar travados');
  } finally {
    restoreDoc();
  }
});

test('DashboardModal: Nova Seleção sem resultado não deixa o status preso em "Gerando"', async () => {
  let tracks = [makeTrack('s1', 'Song 1', 'art1', 'Daft Punk')];
  const { modal, restoreDoc } = await createTestHarness({
    getLastRadioTracks: () => [...tracks],
    getLastRadioTitle: () => 'Rádio',
    async refreshLastRadio() {
      tracks = [];
    }
  });

  try {
    const content = (await modal.render()) as unknown as TestDomNode;
    mountInSpicetifyPopupModal(content);
    await content.querySelector('[data-tab="radios"]')!.dispatchClick();
    await content.querySelector('#nt-radio-refresh')!.dispatchClick();

    assert.doesNotMatch(content.querySelector('#nt-radio-prompt-status')!.textContent, /Gerando/);
  } finally {
    restoreDoc();
  }
});

test('DashboardModal: spam nos botões inline avalia a linha uma única vez', async () => {
  const tracks = [makeTrack('s1', 'Song 1', 'art1', 'Daft Punk'), makeTrack('s2', 'Song 2', 'art2', 'Justice')];
  const rated: number[] = [];
  let finish: () => void = () => undefined;
  const { modal, restoreDoc } = await createTestHarness({
    getLastRadioTracks: () => [...tracks],
    getLastRadioTitle: () => 'Rádio',
    rateRecommendedTrack: (_track, rating) => new Promise<void>((resolve) => {
      rated.push(rating);
      finish = resolve;
    })
  });

  try {
    const content = (await modal.render()) as unknown as TestDomNode;
    mountInSpicetifyPopupModal(content);
    await content.querySelector('[data-tab="radios"]')!.dispatchClick();

    const row = content.querySelectorAll('.nt-rate-rec').filter((b) => b.dataset.uri === 'spotify:track:s1');
    const clicks = [row[0], row[1], row[2], row[1], row[0]].map((button) => button.dispatchClick());
    finish();
    await Promise.all(clicks);

    assert.deepEqual(rated, [0], 'só o primeiro clique vale');
    assert.equal(content.querySelectorAll('.nt-radio-track-row').length, 1);
  } finally {
    restoreDoc();
  }
});

test('DashboardModal: avaliação que falha mantém a faixa na lista e avisa', async () => {
  const tracks = [makeTrack('s1', 'Song 1', 'art1', 'Daft Punk')];
  const { modal, restoreDoc } = await createTestHarness({
    getLastRadioTracks: () => [...tracks],
    getLastRadioTitle: () => 'Rádio',
    async rateRecommendedTrack() {
      throw new Error('disco cheio');
    }
  });

  try {
    const content = (await modal.render()) as unknown as TestDomNode;
    mountInSpicetifyPopupModal(content);
    await content.querySelector('[data-tab="radios"]')!.dispatchClick();

    await content.querySelector('.nt-rate-rec')!.dispatchClick();

    assert.equal(content.querySelectorAll('.nt-radio-track-row').length, 1);
    assert.match(content.querySelector('#nt-radio-prompt-status')!.textContent, /disco cheio/);
  } finally {
    restoreDoc();
  }
});

test('DashboardModal: trocar de aba rapidamente com rádio em cálculo não quebra e a rádio termina', async () => {
  let finish: () => void = () => undefined;
  let launches = 0;
  const { modal, restoreDoc } = await createTestHarness({
    launchRadio: () => new Promise<void>((resolve) => {
      launches++;
      finish = resolve;
    })
  });

  try {
    const content = (await modal.render()) as unknown as TestDomNode;
    const popup = mountInSpicetifyPopupModal(content);
    await content.querySelector('[data-tab="radios"]')!.dispatchClick();

    const running = content.querySelector('.nt-launch-radio')!.dispatchClick();
    for (const tab of ['blacklist', 'radios', 'blacklist', 'radios', 'blacklist', 'radios']) {
      await content.querySelector(`[data-tab="${tab}"]`)?.dispatchClick();
    }
    finish();
    await running;

    assert.equal(launches, 1);
    assert.equal(popup.isModalOpen(), true);
    assert.ok(content.querySelector('.nt-launch-radio'), 'a aba de rádios segue montada');
  } finally {
    restoreDoc();
  }
});

test('DashboardModal: painel de rádios mostra o experimento e não quebra a aba quando falha', async () => {
  const report = {
    exposures: 16,
    byRadio: [{ group: '<b>Rádio</b>', exposed: 16, heard: 4, completed: 2, skipped: 2, rated: 1, liked: 1, disliked: 0, completionRate: 0.5, completionInterval: [0.2, 0.8] as [number, number], weightedCompletion: 0.5, likeRate: 1, enoughData: false }],
    bySource: [],
    byArtistNovelty: [],
    experiment: { runs: { padrao: 1, exploratorio: 0 }, completion: { padrao: 0.5, exploratorio: null }, difference: null, interval: null, verdict: 'coletando' as const, runsMissing: 19 },
    ranking: { completed: 2, abandoned: 2, auc: null }
  };

  const shown = await createTestHarness({ getRadioOutcomes: async () => report });
  try {
    const content = (await shown.modal.render()) as unknown as TestDomNode;
    await content.querySelector('[data-tab="radios"]')!.dispatchClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = content.querySelector('#nt-radio-outcomes')!.innerHTML;
    assert.match(html, /Faltam 19/);
    assert.match(html, /amostra pequena/);
    assert.match(html, /São necessárias 10 de cada/);
    assert.doesNotMatch(html, /<b>Rádio/, 'nome de rádio é escapado');
  } finally {
    shown.restoreDoc();
  }

  const failing = await createTestHarness({ getRadioOutcomes: async () => { throw new Error('banco indisponível'); } });
  try {
    const content = (await failing.modal.render()) as unknown as TestDomNode;
    await content.querySelector('[data-tab="radios"]')!.dispatchClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(content.querySelector('.nt-launch-radio'), 'a aba segue funcionando');
  } finally {
    failing.restoreDoc();
  }
});
