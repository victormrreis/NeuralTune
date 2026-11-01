import { RatingManager } from '../core/RatingManager.ts';
import { Rating, TrackMetadata } from '../types/index.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

const STAR_PATH = 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z';
const TRASH_PATH = 'M5.25 3v-.917C5.25.933 6.183 0 7.333 0h1.334c1.15 0 2.083.933 2.083 2.083V3h4.75v1.5h-.972l-1.257 9.544A2.25 2.25 0 0 1 11.041 16H4.96a2.25 2.25 0 0 1-2.23-1.956L1.472 4.5H.5V3h4.75zm1.5-.917V3h2.5v-.917a.583.583 0 0 0-.583-.583H7.333a.583.583 0 0 0-.583.583zM2.986 4.5l1.23 9.348a.75.75 0 0 0 .744.652h6.08a.75.75 0 0 0 .744-.652L13.015 4.5H2.985z';

const COLOR_IDLE = 'rgba(255, 255, 255, 0.45)';
const COLOR_HOVER_DIM = 'rgba(255, 255, 255, 0.25)';
const COLOR_FILLED = '#1db954';
const COLOR_BLOCKED = '#e22134';

const PLAYER_BAR_SELECTORS = [
  '.Root__now-playing-bar',
  '[data-testid="now-playing-bar"]',
  '.main-nowPlayingBar-container',
  'footer'
];
const ADD_BUTTON_SELECTORS = [
  '[data-testid="add-button"]',
  '.main-addButton-button',
  '.control-button-heart',
  '[data-testid="control-button-heart"]'
];
const FALLBACK_CONTAINER_SELECTORS = [
  '.main-nowPlayingWidget-nowPlaying',
  '[data-testid="now-playing-widget"]',
  '.main-nowPlayingBar-left'
];

// A safety net only: the observer covers React re-renders, this covers the bar root being replaced
const HEARTBEAT_MS = 2000;

const STAR_LABELS = [
  '1★ Detesto (Ctrl+Alt+1)',
  '2★ Não gosto (Ctrl+Alt+2)',
  '3★ Indiferente (Ctrl+Alt+3)',
  '4★ Gosto (Ctrl+Alt+4)',
  '5★ Adoro (Ctrl+Alt+5)'
];

interface MountAnchor {
  parent: HTMLElement;
  after: Element | null;
}

function createIcon(path: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');

  const shape = document.createElementNS(SVG_NS, 'path');
  shape.setAttribute('d', path);
  svg.appendChild(shape);

  return svg;
}

/** Scoped to the player bar: every track row in the page also has an add-button. */
function locateAnchor(): { bar: HTMLElement | null; anchor: MountAnchor | null } {
  const bar = queryFirst<HTMLElement>(document, PLAYER_BAR_SELECTORS);
  if (!bar) return { bar: null, anchor: null };

  const addButton = queryFirst<HTMLElement>(bar, ADD_BUTTON_SELECTORS);
  if (addButton?.parentElement) {
    return { bar, anchor: { parent: addButton.parentElement, after: addButton } };
  }

  const fallback = queryFirst<HTMLElement>(bar, FALLBACK_CONTAINER_SELECTORS);
  return { bar, anchor: fallback ? { parent: fallback, after: null } : null };
}

function queryFirst<T extends Element>(root: ParentNode, selectors: string[]): T | null {
  for (const selector of selectors) {
    const match = root.querySelector<T>(selector);
    if (match) return match;
  }
  return null;
}

export class StarRatingWidget {
  private ratingManager: RatingManager;
  private container: HTMLElement;
  private blockBtn: HTMLButtonElement;
  private starBtns: HTMLButtonElement[] = [];
  private dashboardBtn: HTMLButtonElement;
  private currentTrack: TrackMetadata | null = null;
  private currentRating: Rating | null = null;
  private onOpenDashboard?: () => void;

  private appliedStyles = new WeakMap<HTMLElement, Map<string, string>>();
  private updateToken = 0;
  private rating = false;

  private observer: MutationObserver | null = null;
  private observedBar: HTMLElement | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private frameRequested = false;

  constructor(ratingManager: RatingManager, onOpenDashboard?: () => void) {
    this.ratingManager = ratingManager;
    this.onOpenDashboard = onOpenDashboard;

    // Create container and persistent DOM structure ONCE
    this.container = document.createElement('div');
    this.container.className = 'neuraltune-star-widget';
    this.container.style.cssText = `
      display: inline-flex !important;
      align-items: center !important;
      gap: 2px !important;
      margin-left: 8px !important;
      user-select: none !important;
      vertical-align: middle !important;
      flex-shrink: 0 !important;
      z-index: 100 !important;
    `;

    // 1. Block button (0 stars)
    this.blockBtn = this.createIconButton(
      'neuraltune-btn-block',
      'Nota 0: Bloquear e pular faixa (Ctrl+Alt+0)',
      TRASH_PATH,
      '4px',
      '50%'
    );
    this.blockBtn.onclick = (e) => {
      e.stopPropagation();
      this.handleRate(0);
    };
    this.container.appendChild(this.blockBtn);

    // Separator line
    const sep = document.createElement('span');
    sep.style.cssText = 'width: 1px !important; height: 12px !important; background: rgba(255,255,255,0.2) !important; margin: 0 3px !important; display: inline-block !important;';
    this.container.appendChild(sep);

    // 2. Stars (1 to 5)
    for (let i = 1; i <= 5; i++) {
      const star = this.createIconButton(`neuraltune-star-${i}`, STAR_LABELS[i - 1], STAR_PATH, '3px 2px', '0');

      star.onmouseenter = () => this.previewHighlight(i);
      star.onmouseleave = () => this.applyVisualState();
      star.onclick = (e) => {
        e.stopPropagation();
        this.handleRate(i as Rating);
      };

      this.starBtns.push(star);
      this.container.appendChild(star);
    }

    // 3. Quick Dashboard Button (NeuralTune icon)
    this.dashboardBtn = document.createElement('button');
    this.dashboardBtn.type = 'button';
    this.dashboardBtn.className = 'neuraltune-btn-dash';
    this.dashboardBtn.title = 'Abrir Painel NeuralTune (Ctrl+Alt+M)';
    this.dashboardBtn.style.cssText = `
      background: rgba(29, 185, 84, 0.15) !important;
      border: 1px solid rgba(29, 185, 84, 0.4) !important;
      color: #1db954 !important;
      cursor: pointer !important;
      border-radius: 10px !important;
      padding: 2px 5px !important;
      margin-left: 4px !important;
      display: inline-flex !important;
      align-items: center !important;
      font-size: 10px !important;
      font-weight: 700 !important;
      letter-spacing: 0.5px !important;
      transition: background 0.15s ease, transform 0.1s ease !important;
    `;
    this.dashboardBtn.textContent = 'NT';
    this.dashboardBtn.onclick = (e) => {
      e.stopPropagation();
      if (this.onOpenDashboard) {
        this.onOpenDashboard();
      }
    };
    this.dashboardBtn.onmouseenter = () => {
      this.setStyle(this.dashboardBtn, 'background', 'rgba(29, 185, 84, 0.35)');
    };
    this.dashboardBtn.onmouseleave = () => {
      this.setStyle(this.dashboardBtn, 'background', 'rgba(29, 185, 84, 0.15)');
    };
    this.container.appendChild(this.dashboardBtn);

    this.applyVisualState();
  }

  /**
   * Keeps the single widget node beside the add button. React may rebuild the bar at any time: the same
   * node is re-inserted, so hover and rating state survive and nothing is ever recreated. Mutations
   * only schedule one O(1) check per frame, and a healthy widget makes no DOM write at all.
   */
  startMountGuard(): void {
    this.ensureMounted();

    if (typeof MutationObserver !== 'undefined' && !this.observer) {
      this.observer = new MutationObserver(() => this.scheduleCheck());
    }
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.ensureMounted(), HEARTBEAT_MS);
    }
  }

  stopMountGuard(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.observedBar = null;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  isMounted(): boolean {
    return this.container.isConnected;
  }

  ensureMounted(): void {
    const { bar, anchor } = locateAnchor();
    this.observeBar(bar);
    if (!anchor) return;

    // Same parent means done: other extensions may sit between us and the add button
    if (this.container.isConnected && this.container.parentElement === anchor.parent) return;

    anchor.parent.insertBefore(this.container, anchor.after ? anchor.after.nextSibling : null);
  }

  async updateTrack(track: TrackMetadata | null): Promise<void> {
    this.currentTrack = track;
    const token = ++this.updateToken;

    let rating: Rating | null = null;
    if (track && track.uri) {
      try {
        const record = await this.ratingManager.getRating(track.uri);
        rating = record ? record.rating : null;
      } catch {
        rating = null;
      }
    }

    // A slower lookup for the previous track must not paint over the newer one
    if (token !== this.updateToken) return;

    this.currentRating = rating;
    this.applyVisualState();
  }

  private createIconButton(
    className: string,
    title: string,
    iconPath: string,
    padding: string,
    borderRadius: string
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = title;
    button.style.cssText = `
      background: transparent !important;
      border: none !important;
      cursor: pointer !important;
      padding: ${padding} !important;
      border-radius: ${borderRadius} !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      transition: color 0.15s ease, transform 0.1s ease !important;
    `;
    button.appendChild(createIcon(iconPath));
    return button;
  }

  private observeBar(bar: HTMLElement | null): void {
    if (!this.observer || bar === this.observedBar) return;

    this.observer.disconnect();
    this.observedBar = bar;
    if (bar) {
      this.observer.observe(bar, { childList: true, subtree: true });
    }
  }

  private scheduleCheck(): void {
    if (this.frameRequested || this.isHealthy()) return;

    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.ensureMounted();
    });
  }

  private isHealthy(): boolean {
    return this.container.isConnected && this.observedBar?.contains(this.container) === true;
  }

  /** Writes only what changed, so an unchanged state costs no style invalidation. */
  private setStyle(element: HTMLElement, property: string, value: string): void {
    let applied = this.appliedStyles.get(element);
    if (!applied) {
      applied = new Map();
      this.appliedStyles.set(element, applied);
    }
    if (applied.get(property) === value) return;

    applied.set(property, value);
    element.style.setProperty(property, value, 'important');
  }

  private applyVisualState(): void {
    // Zero innerHTML changes - pure style updates to prevent DOM thrashing
    const isBlock = this.currentRating === 0;
    this.setStyle(this.blockBtn, 'color', isBlock ? COLOR_BLOCKED : COLOR_IDLE);
    this.setStyle(this.blockBtn, 'transform', isBlock ? 'scale(1.15)' : 'scale(1)');

    for (let i = 1; i <= 5; i++) {
      const btn = this.starBtns[i - 1];
      if (!btn) continue;
      const isFilled = this.currentRating !== null && this.currentRating >= i;
      this.setStyle(btn, 'color', isFilled ? COLOR_FILLED : COLOR_IDLE);
      this.setStyle(btn, 'transform', isFilled ? 'scale(1.08)' : 'scale(1)');
    }
  }

  private previewHighlight(hoveredVal: number): void {
    for (let i = 1; i <= 5; i++) {
      const btn = this.starBtns[i - 1];
      if (btn) {
        this.setStyle(btn, 'color', i <= hoveredVal ? COLOR_FILLED : COLOR_HOVER_DIM);
      }
    }
  }

  private async handleRate(rating: Rating): Promise<void> {
    const track = this.currentTrack;
    if (!track || this.rating) return;

    this.rating = true;
    try {
      if (this.currentRating === rating) {
        await this.ratingManager.deleteRating(track.uri);
        this.currentRating = null;
      } else {
        await this.ratingManager.rateTrack(track, rating);
        this.currentRating = rating;
      }
      this.applyVisualState();
    } finally {
      this.rating = false;
    }
  }
}
