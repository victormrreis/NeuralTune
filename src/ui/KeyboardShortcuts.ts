import { RatingManager } from '../core/RatingManager.ts';
import { Rating, TrackMetadata } from '../types/index.ts';

export interface SpicetifyKeyboardBridge {
  notify(message: string, isError?: boolean): void;
  getCurrentTrack(): TrackMetadata | null;
  openDashboard(): void;
  skipNext(): void;
  skipBlocked(uri: string): Promise<void> | void;
  toggleHeart(): void;
  exportAll(): Promise<void> | void;
  toggleAutopilot(): void;
}

export const SpicetifyKeyboardBridge = {};

export type ShortcutAction =
  | { type: 'rate'; rating: Rating }
  | { type: 'dashboard' | 'undo' | 'redo' | 'export' | 'heart' | 'skip' | 'autopilot' };

export interface ShortcutKeyEvent {
  code?: string;
  key?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  getModifierState?(key: string): boolean;
}

export const ShortcutKeyEvent = {};

const LETTER_ACTIONS: Record<string, ShortcutAction> = {
  m: { type: 'dashboard' },
  z: { type: 'undo' },
  y: { type: 'redo' },
  e: { type: 'export' },
  a: { type: 'autopilot' },
  l: { type: 'heart' },
  n: { type: 'skip' },
  h: { type: 'rate', rating: 0 }
};

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

const RATE_MESSAGES = [
  'Bloqueada e enviada para a blacklist',
  'Classificada com 1 estrela (Detesto)',
  'Classificada com 2 estrelas (Não gosto)',
  'Classificada com 3 estrelas (Indiferente)',
  'Classificada com 4 estrelas (Gosto)',
  'Classificada com 5 estrelas (Adoro)'
];

/**
 * Maps a physical key to its action. `event.key` is unusable here: with Ctrl+Alt held, Windows treats
 * the chord as AltGr and ABNT2 reports `¹ ² ³ £ ¢ ¬` for the digits and `°` for E. `event.code` names
 * the key itself and does not depend on the layout, so `key` is only consulted when `code` is absent.
 */
export function resolveShortcut(event: ShortcutKeyEvent): ShortcutAction | null {
  const chord = (event.ctrlKey && event.altKey) || event.getModifierState?.('AltGraph') === true;
  if (!chord || event.shiftKey || event.metaKey) return null;

  const code = event.code ?? '';
  const digit = /^(?:Digit|Numpad)([0-5])$/.exec(code);
  if (digit) return { type: 'rate', rating: Number(digit[1]) as Rating };

  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return LETTER_ACTIONS[letter[1].toLowerCase()] ?? null;

  if (code !== '') return null;

  const key = event.key?.toLowerCase() ?? '';
  if (/^[0-5]$/.test(key)) return { type: 'rate', rating: Number(key) as Rating };
  return LETTER_ACTIONS[key] ?? null;
}

/**
 * True only where a keystroke produces text. Spotify's volume and progress sliders are
 * `<input type="range">`: treating every INPUT as text kills all shortcuts after clicking one.
 */
export function isTextEntryTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;

  const element = target as {
    tagName?: string;
    type?: string;
    isContentEditable?: boolean;
    getAttribute?(name: string): string | null;
  };

  if (element.isContentEditable) return true;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName === 'INPUT') return TEXT_INPUT_TYPES.has((element.type ?? '').toLowerCase());
  return TEXT_ROLES.has(element.getAttribute?.('role') ?? '');
}

export class KeyboardShortcuts {
  private ratingManager: RatingManager;
  private bridge: SpicetifyKeyboardBridge;
  private listener: ((e: KeyboardEvent) => void) | null = null;

  constructor(ratingManager: RatingManager, bridge: SpicetifyKeyboardBridge) {
    this.ratingManager = ratingManager;
    this.bridge = bridge;
  }

  registerAll(): void {
    if (this.listener || typeof window === 'undefined') return;

    this.listener = (e: KeyboardEvent) => this.handleKeyDown(e);

    // Capture phase on window: runs before any player component, and before Mousetrap on document
    window.addEventListener('keydown', this.listener, true);
  }

  dispose(): void {
    if (!this.listener) return;
    window.removeEventListener('keydown', this.listener, true);
    this.listener = null;
  }

  handleKeyDown(e: KeyboardEvent): void {
    const target = e.composedPath?.()[0] ?? e.target;
    if (isTextEntryTarget(target)) return;

    const action = resolveShortcut(e);
    if (!action) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    // Auto-repeat of a held Ctrl+Alt+0 would block a run of tracks
    if (e.repeat) return;

    this.execute(action).catch((err) => {
      console.error('[NeuralTune] Erro ao executar atalho', err);
      this.bridge.notify('[NeuralTune] Não foi possível executar o atalho.', true);
    });
  }

  async execute(action: ShortcutAction): Promise<void> {
    switch (action.type) {
      case 'rate':
        return this.rateCurrent(action.rating);
      case 'undo': {
        const undone = await this.ratingManager.undo();
        this.bridge.notify(undone ? '[NeuralTune] Última avaliação desfeita.' : '[NeuralTune] Nada para desfazer.', !undone);
        return;
      }
      case 'redo': {
        const redone = await this.ratingManager.redo();
        this.bridge.notify(redone ? '[NeuralTune] Avaliação refeita.' : '[NeuralTune] Nada para refazer.', !redone);
        return;
      }
      case 'dashboard':
        return this.bridge.openDashboard();
      case 'export':
        return this.bridge.exportAll();
      case 'heart':
        return this.bridge.toggleHeart();
      case 'skip':
        return this.bridge.skipNext();
      case 'autopilot':
        return this.bridge.toggleAutopilot();
    }
  }

  private async rateCurrent(rating: Rating): Promise<void> {
    const track = this.bridge.getCurrentTrack();
    if (!track) {
      this.bridge.notify('Nenhuma faixa em reprodução.', true);
      return;
    }

    await this.ratingManager.rateTrack(track, rating);
    this.bridge.notify(`[NeuralTune] ${RATE_MESSAGES[rating]}: ${track.name}`);

    if (rating === 0) {
      await this.bridge.skipBlocked(track.uri);
    }
  }
}
