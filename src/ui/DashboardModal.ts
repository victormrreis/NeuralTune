import { RatingManager } from '../core/RatingManager.ts';
import { HistoryImportReport } from '../storage/StreamingHistory.ts';
import { BackupStatus } from '../storage/AutoBackup.ts';
import { OutcomeSummary, RadioOutcomesReport } from '../evaluation/RadioOutcomes.ts';
import { BlacklistManager } from '../core/BlacklistManager.ts';
import { PreferenceEngine } from '../core/PreferenceEngine.ts';
import { ExplainabilityEngine } from '../explainability/ExplainabilityEngine.ts';
import { PerformanceMonitor } from '../optimization/PerformanceMonitor.ts';
import { ACOUSTIC_DIMENSIONS } from '../core/AcousticVector.ts';
import { CaptureEnvironment } from '../dsp/LocalAudioDSPEngine.ts';
import { ModuleFlags } from '../core/FeatureFlags.ts';
import { CapabilityReport } from '../core/ApiCapabilityProbe.ts';
import { EvaluationReport } from '../evaluation/RecommenderEvaluation.ts';
import { SCIENTIFIC_EVIDENCE } from '../neuroscience/ScientificEvidenceRegistry.ts';
import { powerIterationPca, weightedCovariance } from '../math/LinearAlgebra.ts';
import { POPULATION_MEAN, POPULATION_STD, standardize, toAcousticPoint } from '../core/AcousticVector.ts';
import { ConstellationPoint, constellationSvg, radarSvg } from './TasteVisualizer.ts';
import { AudioFeatureDiagnostics } from '../core/AudioFeatureProvider.ts';
import {
  ImportReport,
  MergeStrategy,
  PlaylistSyncResult,
  RatingConflict
} from '../storage/DataPortabilityManager.ts';
import { TrackMetadata, Rating } from '../types/index.ts';

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export interface DashboardDependencies {
  ratingManager: RatingManager;
  blacklistManager: BlacklistManager;
  preferenceEngine: PreferenceEngine;
  explainabilityEngine: ExplainabilityEngine;
  performanceMonitor: PerformanceMonitor;
  getCurrentTrack: () => TrackMetadata | null;
  launchRadio: (type: string) => Promise<void>;
  importTrashbin: () => Promise<{ importedSongs: number; importedArtists: number }>;
  exportJson: () => Promise<boolean>;
  exportCsv: () => Promise<boolean>;
  syncPlaylists: () => Promise<PlaylistSyncResult[]>;
  importFile: (
    file: File,
    strategy: MergeStrategy,
    resolveConflict: (conflict: RatingConflict) => Promise<'local' | 'imported'>
  ) => Promise<ImportReport>;
  getAudioDiagnostics: () => AudioFeatureDiagnostics;
  launchPromptRadio: (prompt: string) => Promise<string[]>;
  exportDossier: () => Promise<boolean>;
  launchDiscovery: () => Promise<number>;
  toggleAutopilot: () => boolean;
  isAutopilotOn: () => boolean;
  getFlags: () => ModuleFlags;
  setFlags: (flags: ModuleFlags) => void;
  getCapabilities: () => CapabilityReport | null;
  getEvaluation: () => EvaluationReport | null;
  launchClusterRadio: (centroid: readonly number[]) => Promise<void>;
  exportJspf: () => Promise<boolean>;
  exportLastRadio: () => Promise<boolean>;
  getRatedSources: () => Promise<Record<string, number>>;
  exportCovariance: () => Promise<boolean>;
  exportTransitionGraph: () => Promise<boolean>;
  probeCapture: () => Promise<CaptureEnvironment>;
  toggleCapture: () => Promise<boolean>;
  isCapturing: () => boolean;
  getLastRadioTracks?: () => TrackMetadata[];
  getLastRadioTitle?: () => string;
  playTrack?: (uri: string) => Promise<void>;
  getShieldStats?: () => Promise<{ rated: number; liked: number; blocked: number; heard?: number }>;
  rateRecommendedTrack?: (track: TrackMetadata, rating: Rating) => Promise<void>;
  refreshLastRadio?: () => Promise<void>;
  getRadioOutcomes?: () => Promise<RadioOutcomesReport>;
  whyTrack?: (track: TrackMetadata) => string;
  importHistory?: (files: File[]) => Promise<HistoryImportReport>;
  getBackupStatus?: () => BackupStatus;
  chooseBackupFolder?: () => Promise<string | null>;
  runBackupNow?: () => Promise<BackupStatus>;
  refreshWeeklyDiscoveries?: () => Promise<{ tracks: number; newArtists: number }>;
}

export const DashboardDependencies = {};

export class DashboardModal {
  private deps: DashboardDependencies;
  private activeTab: 'explain' | 'ratings' | 'blacklist' | 'radios' | 'preferences' | 'science' | 'data' | 'perf' = 'explain';
  private renderSeq = 0;
  private switchToTab?: (tab: typeof this.activeTab) => Promise<void>;

  constructor(deps: DashboardDependencies) {
    this.deps = deps;
  }

  async render(): Promise<HTMLElement> {
    const container = document.createElement('div');
    container.className = 'neuraltune-dashboard';
    container.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 16px;
      font-family: inherit;
      color: var(--spice-text, #fff);
      min-height: 480px;
    `;

    // Tabs Header (persistent across tab switches so event.target is never detached from .GenericModal)
    const tabsNav = document.createElement('div');
    tabsNav.style.cssText = `
      display: flex;
      gap: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      padding-bottom: 8px;
      overflow-x: auto;
    `;

    const tabs: Array<{ id: typeof this.activeTab; label: string; icon: string }> = [
      { id: 'explain', label: 'Por que esta música?', icon: '💡' },
      { id: 'ratings', label: 'Avaliações (0-5★)', icon: '⭐' },
      { id: 'blacklist', label: 'Blacklist & Trash Bin', icon: '🚫' },
      { id: 'radios', label: 'Rádios Personalizadas', icon: '📻' },
      { id: 'preferences', label: 'Preferências Aprendidas', icon: '🧠' },
      { id: 'science', label: 'Ciência por trás da recomendação', icon: '🔬' },
      { id: 'data', label: 'Exportar & Sincronizar', icon: '💾' },
      { id: 'perf', label: 'Desempenho & Diagnóstico', icon: '⚡' }
    ];

    const tabButtons = new Map<typeof this.activeTab, HTMLButtonElement>();
    const applyTabStyles = () => {
      for (const t of tabs) {
        const btn = tabButtons.get(t.id);
        if (!btn) continue;
        const isActive = this.activeTab === t.id;
        btn.setAttribute('aria-selected', String(isActive));
        btn.style.cssText = `
          background: ${isActive ? 'var(--spice-button, #1db954)' : 'transparent'};
          color: ${isActive ? '#000' : 'var(--spice-text, #fff)'};
          border: 1px solid ${isActive ? 'transparent' : 'rgba(255,255,255,0.2)'};
          border-radius: 500px;
          padding: 6px 14px;
          font-weight: 700;
          font-size: 13px;
          cursor: pointer;
          transition: all 0.15s ease;
          white-space: nowrap;
        `;
      }
    };

    // Tab Body
    const bodyContainer = document.createElement('div');
    bodyContainer.className = 'neuraltune-dashboard-body';
    bodyContainer.style.cssText = 'flex: 1 1 auto; overflow-y: auto; padding: 4px;';

    const renderActiveTab = async (): Promise<HTMLElement> => {
      switch (this.activeTab) {
        case 'explain':
          return await this.renderExplainTab();
        case 'ratings':
          return await this.renderRatingsTab();
        case 'blacklist':
          return await this.renderBlacklistTab();
        case 'radios':
          return await this.renderRadiosTab();
        case 'preferences':
          return await this.renderPreferencesTab();
        case 'science':
          return this.renderScienceTab();
        case 'data':
          return await this.renderDataTab();
        case 'perf':
          return await this.renderPerformanceTab();
      }
    };

    const replaceBodyContent = (child: HTMLElement) => {
      bodyContainer.innerHTML = '';
      if (Array.isArray((bodyContainer as unknown as { children?: unknown[] }).children)) {
        (bodyContainer as unknown as { children: unknown[] }).children.length = 0;
      }
      bodyContainer.appendChild(child);
    };

    const mountActiveTab = async () => {
      const seq = ++this.renderSeq;
      try {
        const view = await renderActiveTab();
        if (seq !== this.renderSeq) return;
        replaceBodyContent(view);
      } catch (err) {
        if (seq !== this.renderSeq) return;
        console.error('[NeuralTune] Erro ao renderizar aba:', err);
        const errorBox = document.createElement('div');
        errorBox.style.cssText = 'background: rgba(226, 33, 52, 0.12); border: 1px solid rgba(226, 33, 52, 0.4); padding: 16px; border-radius: 8px;';
        const msg = document.createElement('p');
        msg.style.cssText = 'margin: 0 0 12px 0; font-size: 13px;';
        msg.textContent = `Não foi possível abrir esta seção: ${err instanceof Error ? err.message : String(err)}`;
        const retryBtn = document.createElement('button');
        retryBtn.className = 'nt-tab-retry';
        retryBtn.textContent = 'Tentar novamente';
        retryBtn.style.cssText = 'background: #1db954; color: #000; border: none; border-radius: 500px; padding: 6px 14px; font-weight: 700; cursor: pointer;';
        retryBtn.onclick = (e) => {
          e?.stopPropagation?.();
          void mountActiveTab();
        };
        errorBox.appendChild(msg);
        errorBox.appendChild(retryBtn);
        replaceBodyContent(errorBox);
      }
    };

    this.switchToTab = async (tab) => {
      this.activeTab = tab;
      applyTabStyles();
      await mountActiveTab();
    };

    for (const t of tabs) {
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.dataset.tab = t.id;
      tabBtn.innerText = `${t.icon} ${t.label}`;
      tabBtn.textContent = `${t.icon} ${t.label}`;
      tabButtons.set(t.id, tabBtn);
      tabBtn.onclick = async (e) => {
        e?.stopPropagation?.();
        await this.switchToTab?.(t.id);
      };
      tabsNav.appendChild(tabBtn);
    }

    applyTabStyles();
    container.appendChild(tabsNav);
    await mountActiveTab();
    container.appendChild(bodyContainer);
    return container;
  }

  private async renderExplainTab(): Promise<HTMLElement> {
    const el = document.createElement('div');
    const track = this.deps.getCurrentTrack();

    if (!track) {
      el.innerHTML = '<p style="color: rgba(255,255,255,0.6); padding: 20px;">Nenhuma faixa em reprodução no momento.</p>';
      return el;
    }

    const evaluation = this.deps.preferenceEngine.evaluateCandidate(track);
    const explanation = this.deps.explainabilityEngine.formatExplanation(evaluation);

    el.innerHTML = `
      <div style="background: rgba(255,255,255,0.05); padding: 18px; border-radius: 8px; margin-bottom: 16px;">
        <h2 style="margin: 0 0 6px 0; font-size: 1.3rem;">${esc(explanation.trackName)}</h2>
        <p style="margin: 0 0 12px 0; color: rgba(255,255,255,0.7);">${esc(explanation.artistName)}</p>
        
        <div style="display: flex; gap: 20px; align-items: center; margin: 14px 0;">
          <div style="background: ${evaluation.score >= 70 ? '#1db954' : evaluation.score >= 40 ? '#f59b23' : '#e22134'}; color: #000; font-size: 1.8rem; font-weight: 800; padding: 10px 16px; border-radius: 8px;">
            ${explanation.score}/100
          </div>
          <div>
            <div style="font-weight: 700;">Grau de Confiança: ${explanation.confidencePercent}%</div>
            <div style="font-size: 12px; color: rgba(255,255,255,0.6);">${explanation.noveltyIndicator}</div>
          </div>
        </div>

        <p style="font-size: 14px; line-height: 1.4; background: rgba(0,0,0,0.3); padding: 12px; border-radius: 6px;">
          ${esc(explanation.summary)}
        </p>
        ${explanation.breakdownLine ? `<p style="font-size: 13px; line-height: 1.4; margin: 10px 0 0 0;"><strong>Composição da nota:</strong> ${esc(explanation.breakdownLine)}</p>` : ''}
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
        <div style="background: rgba(29, 185, 84, 0.08); padding: 14px; border-radius: 8px; border: 1px solid rgba(29, 185, 84, 0.2);">
          <h3 style="color: #1db954; margin-top: 0;">Fatores Favoráveis (+)</h3>
          ${
            explanation.positiveFactors.length > 0
              ? `<ul style="margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.6;">${explanation.positiveFactors.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
              : '<p style="font-size: 13px; color: rgba(255,255,255,0.5);">Nenhum sinal positivo forte detectado.</p>'
          }
        </div>

        <div style="background: rgba(226, 33, 52, 0.08); padding: 14px; border-radius: 8px; border: 1px solid rgba(226, 33, 52, 0.2);">
          <h3 style="color: #e22134; margin-top: 0;">Fatores Desfavoráveis (-)</h3>
          ${
            explanation.negativeFactors.length > 0
              ? `<ul style="margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.6;">${explanation.negativeFactors.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
              : '<p style="font-size: 13px; color: rgba(255,255,255,0.5);">Nenhum sinal desfavorável para esta faixa.</p>'
          }
        </div>
      </div>

      <div style="margin-top: 16px; font-size: 12px; color: rgba(255,255,255,0.5);">
        Origem dos dados: ${esc(explanation.dataSources.join(', ')) || 'Metadados locais'}
      </div>
    `;

    return el;
  }

  private async renderRatingsTab(): Promise<HTMLElement> {
    const el = document.createElement('div');
    const dist = await this.deps.ratingManager.getRatingsDistribution();
    const allRatings = await this.deps.ratingManager.getAllRatings();
    allRatings.sort((a, b) => b.timestamp - a.timestamp);

    const total = Object.values(dist).reduce((a, b) => a + b, 0);

    const starDescriptions: Record<number, string> = {
      0: '0★ Rejeição (Bloqueada)',
      1: '1★ Detesto',
      2: '2★ Não gosto',
      3: '3★ Indiferente',
      4: '4★ Gosto',
      5: '5★ Adoro'
    };

    let barsHtml = '';
    for (let i = 5; i >= 0; i--) {
      const count = dist[i as keyof typeof dist] || 0;
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      barsHtml += `
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px; font-size: 13px;">
          <div style="width: 140px;">${starDescriptions[i]}</div>
          <div style="flex: 1; background: rgba(255,255,255,0.1); border-radius: 4px; height: 10px; overflow: hidden;">
            <div style="background: ${i === 0 ? '#e22134' : '#1db954'}; width: ${pct}%; height: 100%;"></div>
          </div>
          <div style="width: 70px; text-align: right; color: rgba(255,255,255,0.7);">${count} (${pct}%)</div>
        </div>
      `;
    }

    el.innerHTML = `
      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin-bottom: 16px;">
        <h3 style="margin-top: 0;">Distribuição das Avaliações (Total: ${total})</h3>
        ${barsHtml}
      </div>

      <h3>Músicas Avaliadas Recentemente</h3>
      <div style="max-height: 240px; overflow-y: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead>
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.1); text-align: left;">
              <th style="padding: 8px;">Nota</th>
              <th style="padding: 8px;">Título</th>
              <th style="padding: 8px;">Artista</th>
              <th style="padding: 8px; text-align: right;">Ações</th>
            </tr>
          </thead>
          <tbody>
            ${allRatings.slice(0, 50).map((r) => `
              <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                <td style="padding: 8px; font-weight: 700; color: ${r.rating === 0 ? '#e22134' : '#1db954'};">
                  ${r.rating === 0 ? '🚫 0★' : '⭐'.repeat(r.rating)}
                </td>
                <td style="padding: 8px;">${esc(r.metadata.name)}</td>
                <td style="padding: 8px; color: rgba(255,255,255,0.7);">${esc(r.metadata.artists.map((a) => a.name).join(', ')) || '-'}</td>
                <td style="padding: 8px; text-align: right;">
                  <button class="nt-btn-del" data-uri="${esc(r.uri)}" style="background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #fff; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 11px;">Remover</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    // Attach delete listeners
    el.querySelectorAll('.nt-btn-del').forEach((btn) => {
      (btn as HTMLElement).onclick = async (e) => {
        e?.stopPropagation?.();
        const uri = (e.currentTarget as HTMLElement).getAttribute('data-uri');
        if (uri) {
          await this.deps.ratingManager.deleteRating(uri);
          btn.closest('tr')?.remove();
        }
      };
    });

    return el;
  }

  private async renderBlacklistTab(): Promise<HTMLElement> {
    const el = document.createElement('div');
    const allBlockedArtists = await this.deps.blacklistManager['storage'].getAllBlockedArtists();
    const allRatings = await this.deps.ratingManager.getAllRatings();
    const blockedSongs = allRatings.filter((r) => r.rating === 0);

    el.innerHTML = `
      <div style="display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;">
        <button id="nt-import-trashbin" style="background: #1db954; color: #000; border: none; font-weight: 700; padding: 8px 16px; border-radius: 500px; cursor: pointer;">
          📥 Importar dados da Trash Bin
        </button>

      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
        <div style="background: rgba(255,255,255,0.05); padding: 14px; border-radius: 8px;">
          <h3 style="margin-top: 0; color: #e22134;">Músicas Bloqueadas (${blockedSongs.length})</h3>
          <div style="max-height: 220px; overflow-y: auto;">
            ${blockedSongs.map((s) => `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 12px;">
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;">${esc(s.metadata.name)}</span>
                <button class="nt-unblock-song" data-uri="${esc(s.uri)}" style="background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #fff; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 11px;">Desbloquear</button>
              </div>
            `).join('')}
          </div>
        </div>

        <div style="background: rgba(255,255,255,0.05); padding: 14px; border-radius: 8px;">
          <h3 style="margin-top: 0; color: #e22134;">Artistas Bloqueados (${allBlockedArtists.length})</h3>
          <div style="max-height: 220px; overflow-y: auto;">
            ${allBlockedArtists.map((a) => `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 12px;">
                <span>${esc(a.artistName)}</span>
                <button class="nt-unblock-artist" data-uri="${esc(a.artistUri)}" style="background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #fff; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 11px;">Desbloquear</button>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    el.querySelector('#nt-import-trashbin')?.addEventListener('click', async () => {
      const res = await this.deps.importTrashbin();
      alert(`Importação concluída: ${res.importedSongs} músicas e ${res.importedArtists} artistas importados da Trash Bin com sucesso!`);
    });

    el.querySelectorAll('.nt-unblock-song').forEach((b) => {
      (b as HTMLElement).onclick = async (e) => {
        e?.stopPropagation?.();
        const uri = (e.currentTarget as HTMLElement).getAttribute('data-uri');
        if (uri) {
          await this.deps.ratingManager.deleteRating(uri);
          b.closest('div')?.remove();
        }
      };
    });

    el.querySelectorAll('.nt-unblock-artist').forEach((b) => {
      (b as HTMLElement).onclick = async (e) => {
        e?.stopPropagation?.();
        const uri = (e.currentTarget as HTMLElement).getAttribute('data-uri');
        if (uri) {
          await this.deps.blacklistManager.unblockArtist(uri);
          b.closest('div')?.remove();
        }
      };
    });

    return el;
  }

  private async renderRadiosTab(): Promise<HTMLElement> {
    const el = document.createElement('div');

    const shieldStats = await this.deps.getShieldStats?.().catch(() => null);
    const shieldSummary = shieldStats
      ? `(${shieldStats.rated} com estrelas ★ · ${shieldStats.liked} curtidas ♥ · ${shieldStats.blocked} bloqueadas 🚫${shieldStats.heard ? ` · ${shieldStats.heard} já ouvidas 🎧` : ''} excluídas)`
      : '(0★ avaliadas · 0♥ curtidas · 0🚫 bloqueadas entram na fila)';

    const quickPrompts = [
      { label: '🌙 Foco noturno instrumental', prompt: 'foco noturno instrumental lento sem músicas repetidas' },
      { label: '🔥 Treino pesado 90/2000', prompt: 'treino pesado anos 90/2000 com alta energia' },
      { label: '🎸 Acústico calmo e orgânico', prompt: 'músicas acústicas calmas e lentas sem repetição' },
      { label: '⚡ Eletrônica mixagem harmônica', prompt: 'set de dj eletrônico dançante com mixagem harmônica' },
      { label: '💎 Descoberta profunda', prompt: 'descobrir novidades surpreendentes sem repetir' }
    ];

    const radioCards = [
      { id: 'preference', title: 'Rádio por Preferências', desc: 'Faixas inéditas alinhadas ao vetor acústico das suas notas 4★ e 5★ (exclui já curtidas e já avaliadas).', icon: '🎵' },
      { id: 'discovery', title: 'Rádio de Descoberta', desc: 'Prioriza novidades musicais inéditas com 70% de exploração LinUCB e diversidade espectral.', icon: '🧭' },
      { id: 'gym', title: 'Rádio Academia', desc: 'Faixas inéditas de alta energia (>= 0.70) e andamento acelerado (BPM >= 125).', icon: '⚡' },
      { id: 'work', title: 'Rádio Trabalho', desc: 'Faixas inéditas de energia moderada e equilíbrio estrutural para foco contínuo.', icon: '💼' },
      { id: 'study', title: 'Rádio Estudo', desc: 'Faixas inéditas instrumentais/acústicas de baixa distração vocal e andamento moderado.', icon: '📚' },
      { id: 'relax', title: 'Rádio Relax', desc: 'Faixas inéditas de baixa energia, timbres orgânicos/acústicos e andamento tranquilo.', icon: '🌙' }
    ];

    el.innerHTML = `
      <div id="nt-unheard-shield" style="background: rgba(29, 185, 84, 0.12); border: 1px solid rgba(29, 185, 84, 0.35); padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; font-size: 12px; line-height: 1.45;">
        🛡️ <strong>Modo 100% Inéditas Ativo:</strong> Nenhuma música que você já curtiu no Spotify (♥), avaliou com estrelas (★) ou já ouviu entra nas recomendações das rádios. <span style="color: rgba(255,255,255,0.75);">${esc(shieldSummary)}</span>
      </div>

      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); margin-bottom: 14px;">
        <label for="nt-radio-prompt" style="display: block; font-weight: 700; margin-bottom: 8px;">Descreva a rádio perfeita agora (somente faixas inéditas)</label>
        <div style="display: flex; gap: 10px;">
          <input id="nt-radio-prompt" type="text" placeholder="ex: foco noturno instrumental lento sem músicas repetidas" style="flex: 1; min-width: 0; background: #282828; color: #fff; border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; padding: 8px;" />
          <button id="nt-radio-prompt-go" style="background: #1db954; color: #000; border: none; border-radius: 500px; padding: 8px 16px; font-weight: 700; cursor: pointer;">Gerar</button>
        </div>
        <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px;">
          ${quickPrompts.map((qp) => `<button type="button" class="nt-quick-prompt" data-prompt="${esc(qp.prompt)}" style="background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.9); border: 1px solid rgba(255,255,255,0.18); border-radius: 500px; padding: 4px 10px; font-size: 11px; cursor: pointer;">${esc(qp.label)}</button>`).join('')}
        </div>
        <div id="nt-radio-prompt-status" role="status" style="font-size: 12px; color: rgba(255,255,255,0.6); margin-top: 8px;"></div>
      </div>

      <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px;">
        <button id="nt-discovery" style="background: #1db954; color: #000; border: none; border-radius: 500px; padding: 8px 16px; font-weight: 700; cursor: pointer;">Deep Cuts: faixas fora do histórico</button>
        <button id="nt-autopilot" style="background: transparent; color: #fff; border: 1px solid rgba(255,255,255,0.4); border-radius: 500px; padding: 8px 16px; font-weight: 700; cursor: pointer;">Autopilot: ${this.deps.isAutopilotOn() ? 'ligado' : 'desligado'} (Ctrl+Alt+A)</button>
      </div>

      <div id="nt-radio-results" style="margin-bottom: 14px;"></div>
      <div id="nt-radio-outcomes" style="margin-bottom: 14px;"></div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
        ${radioCards.map((r) => `
          <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); display: flex; flex-direction: column; justify-content: space-between;">
            <div>
              <div style="font-size: 1.5rem; margin-bottom: 6px;">${r.icon}</div>
              <h3 style="margin: 0 0 6px 0;">${r.title}</h3>
              <p style="margin: 0 0 12px 0; font-size: 12px; color: rgba(255,255,255,0.6);">${r.desc}</p>
            </div>
            <button class="nt-launch-radio" data-type="${r.id}" style="background: #1db954; color: #000; border: none; border-radius: 500px; padding: 8px 16px; font-weight: 700; cursor: pointer; align-self: flex-start;">
              Iniciar Rádio
            </button>
          </div>
        `).join('')}
      </div>
    `;

    const promptInput = el.querySelector('#nt-radio-prompt') as HTMLInputElement;
    const promptStatus = el.querySelector('#nt-radio-prompt-status') as HTMLElement;
    const resultsContainer = el.querySelector('#nt-radio-results') as HTMLElement;
    const discoveryBtn = el.querySelector('#nt-discovery') as HTMLButtonElement | null;
    const promptGoBtn = el.querySelector('#nt-radio-prompt-go') as HTMLButtonElement | null;
    const radioButtons = Array.from(el.querySelectorAll('.nt-launch-radio')) as HTMLButtonElement[];
    const quickPromptBtns = Array.from(el.querySelectorAll('.nt-quick-prompt')) as HTMLButtonElement[];

    let isBusy = false;
    let lastAction: (() => Promise<void>) | null = null;

    const setBusy = (busy: boolean) => {
      isBusy = busy;
      if (discoveryBtn) discoveryBtn.disabled = busy;
      if (promptGoBtn) promptGoBtn.disabled = busy;
      for (const b of radioButtons) b.disabled = busy;
      for (const qp of quickPromptBtns) qp.disabled = busy;
    };

    const clearNode = (node: HTMLElement) => {
      node.innerHTML = '';
      if (Array.isArray((node as unknown as { children?: unknown[] }).children)) {
        (node as unknown as { children: unknown[] }).children.length = 0;
      }
    };

    const renderRetryButton = (message: string, isError: boolean = false) => {
      promptStatus.textContent = message;
      promptStatus.style.color = isError ? '#e22134' : 'rgba(255,255,255,0.6)';
      if (!lastAction || !resultsContainer) return;

      clearNode(resultsContainer);
      const retryWrap = document.createElement('div');
      retryWrap.style.cssText = 'display: flex; align-items: center; gap: 10px; background: rgba(255,255,255,0.04); padding: 10px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12);';
      const label = document.createElement('span');
      label.style.cssText = 'font-size: 12px; color: rgba(255,255,255,0.75); flex: 1;';
      label.textContent = message;
      const retryBtn = document.createElement('button');
      retryBtn.id = 'nt-radio-retry';
      retryBtn.type = 'button';
      retryBtn.textContent = 'Tentar novamente';
      retryBtn.style.cssText = 'background: #1db954; color: #000; border: none; border-radius: 500px; padding: 6px 14px; font-weight: 700; font-size: 12px; cursor: pointer;';
      retryBtn.onclick = async (e) => {
        e?.stopPropagation?.();
        if (lastAction && !isBusy) await lastAction();
      };
      retryWrap.appendChild(label);
      retryWrap.appendChild(retryBtn);
      resultsContainer.appendChild(retryWrap);
    };

    const renderTrackList = (tracks: TrackMetadata[], fallbackTitle: string) => {
      if (!resultsContainer) return;
      clearNode(resultsContainer);
      if (tracks.length === 0) return;

      const titleText = this.deps.getLastRadioTitle?.() || fallbackTitle;
      const box = document.createElement('div');
      box.className = 'nt-radio-recommendations';
      box.style.cssText = 'background: rgba(255,255,255,0.05); padding: 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12);';

      const headerRow = document.createElement('div');
      headerRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px;';

      const header = document.createElement('h3');
      header.style.cssText = 'margin: 0; font-size: 14px; color: #1db954;';
      header.textContent = `Faixas Recomendadas — ${titleText} (${tracks.length})`;
      headerRow.appendChild(header);

      const actionsWrap = document.createElement('div');
      actionsWrap.style.cssText = 'display: flex; gap: 8px; align-items: center;';

      const refreshBtn = document.createElement('button');
      refreshBtn.id = 'nt-radio-refresh';
      refreshBtn.type = 'button';
      refreshBtn.textContent = '🔄 Nova Seleção';
      refreshBtn.style.cssText = 'background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.25); border-radius: 500px; padding: 4px 10px; font-size: 11px; font-weight: 700; cursor: pointer;';
      refreshBtn.onclick = async (e) => {
        e?.stopPropagation?.();
        if (isBusy) return;
        if (this.deps.refreshLastRadio) {
          setBusy(true);
          promptStatus.style.color = 'rgba(255,255,255,0.6)';
          promptStatus.textContent = 'Gerando nova seleção inédita...';
          try {
            await this.deps.refreshLastRadio();
            const nextTracks = this.deps.getLastRadioTracks?.() ?? [];
            if (nextTracks.length > 0) {
              promptStatus.textContent = `Nova seleção ativa (${nextTracks.length} faixas inéditas).`;
              renderTrackList(nextTracks, titleText);
            } else {
              renderRetryButton('Nenhuma faixa inédita nova encontrada agora.');
            }
          } catch (err) {
            console.error('[NeuralTune] Erro ao gerar nova seleção:', err);
            renderRetryButton(`Erro ao gerar nova seleção: ${err instanceof Error ? err.message : String(err)}`, true);
          } finally {
            setBusy(false);
          }
        } else if (lastAction) {
          await lastAction();
        }
      };

      const exportInlineBtn = document.createElement('button');
      exportInlineBtn.id = 'nt-radio-export-inline';
      exportInlineBtn.type = 'button';
      exportInlineBtn.textContent = '💾 Exportar JSPF';
      exportInlineBtn.style.cssText = 'background: transparent; color: rgba(255,255,255,0.85); border: 1px solid rgba(255,255,255,0.25); border-radius: 500px; padding: 4px 10px; font-size: 11px; cursor: pointer;';
      exportInlineBtn.onclick = async (e) => {
        e?.stopPropagation?.();
        const ok = await this.deps.exportLastRadio();
        promptStatus.style.color = 'rgba(255,255,255,0.6)';
        promptStatus.textContent = ok ? 'Rádio exportada em JSPF.' : 'Exportação cancelada.';
      };

      actionsWrap.appendChild(refreshBtn);
      actionsWrap.appendChild(exportInlineBtn);
      headerRow.appendChild(actionsWrap);
      box.appendChild(headerRow);

      const list = document.createElement('div');
      list.className = 'nt-radio-track-list';
      list.style.cssText = 'max-height: 250px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;';

      tracks.forEach((track, idx) => {
        const row = document.createElement('div');
        row.className = 'nt-radio-track-row';
        row.dataset.uri = track.uri;
        row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 6px; background: rgba(0,0,0,0.25); font-size: 12px; cursor: pointer;';

        const info = document.createElement('div');
        info.style.cssText = 'min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        const artists = track.artists?.map((a) => a.name).filter(Boolean).join(', ') || 'Artista desconhecido';
        const album = track.album?.name ? ` · ${track.album.name}` : '';
        const af = track.acousticFeatures;
        const metaBadges: string[] = [];
        if (af?.bpm) metaBadges.push(`${Math.round(af.bpm)} BPM`);
        if (af?.camelot) metaBadges.push(af.camelot);
        if (typeof af?.energy === 'number') metaBadges.push(`E:${Math.round(af.energy * 100)}%`);
        const badgeSuffix = metaBadges.length > 0 ? ` [${metaBadges.join(' · ')}]` : '';
        info.textContent = `${idx + 1}. ${track.name} — ${artists}${album}${badgeSuffix}`;

        const why = this.deps.whyTrack?.(track);
        if (why) {
          const whyLine = document.createElement('div');
          whyLine.className = 'nt-radio-why';
          whyLine.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.55); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
          whyLine.textContent = why;
          info.appendChild(whyLine);
        }

        const controlsWrap = document.createElement('div');
        controlsWrap.style.cssText = 'display: flex; align-items: center; gap: 4px; flex-shrink: 0;';

        // Inline quick-rating buttons (🚫 0★, 4★, 5★) — rating a track removes it from unheard recommendations immediately
        let rowRatingBusy = false;
        const quickRatings: Array<{ label: string; rating: Rating; title: string; color: string }> = [
          { label: '🚫', rating: 0, title: 'Bloquear faixa (0★)', color: '#e22134' },
          { label: '4★', rating: 4, title: 'Avaliar com 4★ (remove das inéditas)', color: '#f59b23' },
          { label: '5★', rating: 5, title: 'Avaliar com 5★ (remove das inéditas)', color: '#1db954' }
        ];
        for (const qr of quickRatings) {
          const rBtn = document.createElement('button');
          rBtn.type = 'button';
          rBtn.className = 'nt-rate-rec';
          rBtn.dataset.uri = track.uri;
          rBtn.dataset.rating = String(qr.rating);
          rBtn.title = qr.title;
          rBtn.textContent = qr.label;
          rBtn.style.cssText = `background: transparent; color: ${qr.color}; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; padding: 2px 6px; font-size: 10px; font-weight: 700; cursor: pointer;`;
          rBtn.onclick = async (e) => {
            e?.stopPropagation?.();
            if (rowRatingBusy) return; // A second click on this row would rate over the first
            rowRatingBusy = true;
            try {
              if (this.deps.rateRecommendedTrack) {
                await this.deps.rateRecommendedTrack(track, qr.rating);
              } else {
                await this.deps.ratingManager.rateTrack(track, qr.rating);
              }
              row.remove();
              promptStatus.style.color = 'rgba(255,255,255,0.75)';
              promptStatus.textContent = qr.rating === 0
                ? `Faixa bloqueada (0★) e removida da seleção: ${track.name}`
                : `Avaliada com ${qr.rating}★ e removida da lista de inéditas: ${track.name}`;
            } catch (err) {
              console.error('[NeuralTune] Erro ao avaliar faixa:', err);
              promptStatus.style.color = '#e22134';
              promptStatus.textContent = `Falha ao avaliar "${track.name}": ${err instanceof Error ? err.message : String(err)}`;
            } finally {
              rowRatingBusy = false;
            }
          };
          controlsWrap.appendChild(rBtn);
        }

        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'nt-play-track';
        playBtn.dataset.uri = track.uri;
        playBtn.textContent = '▶ Tocar';
        playBtn.style.cssText = 'background: transparent; color: #1db954; border: 1px solid rgba(29, 185, 84, 0.5); border-radius: 500px; padding: 3px 10px; font-weight: 700; font-size: 11px; cursor: pointer; flex-shrink: 0;';

        const triggerPlay = async (e?: { stopPropagation?: () => void }) => {
          e?.stopPropagation?.();
          if (!this.deps.playTrack) return;
          try {
            promptStatus.style.color = 'rgba(255,255,255,0.6)';
            promptStatus.textContent = `Reproduzindo: ${track.name} — ${artists}`;
            await this.deps.playTrack(track.uri);
          } catch (err) {
            console.error('[NeuralTune] Erro ao reproduzir faixa:', err);
            promptStatus.style.color = '#e22134';
            promptStatus.textContent = `Falha ao reproduzir "${track.name}": ${err instanceof Error ? err.message : String(err)}`;
          }
        };

        playBtn.onclick = triggerPlay;
        row.onclick = triggerPlay;

        controlsWrap.appendChild(playBtn);
        row.appendChild(info);
        row.appendChild(controlsWrap);
        list.appendChild(row);
      });

      box.appendChild(list);
      resultsContainer.appendChild(box);
    };

    void this.renderRadioOutcomes(el.querySelector('#nt-radio-outcomes') as HTMLElement);

    const existingTracks = this.deps.getLastRadioTracks?.() ?? [];
    if (existingTracks.length > 0) {
      renderTrackList(existingTracks, 'Última seleção');
    }

    const launchPrompt = async () => {
      const prompt = promptInput.value.trim();
      if (!prompt || isBusy) return;

      lastAction = launchPrompt;
      setBusy(true);
      promptStatus.style.color = 'rgba(255,255,255,0.6)';
      promptStatus.textContent = 'Montando a rádio (filtrando já curtidas e já avaliadas)...';
      try {
        const matched = await this.deps.launchPromptRadio(prompt);
        const tracks = this.deps.getLastRadioTracks?.() ?? [];
        if (tracks.length > 0) {
          promptStatus.textContent = matched.length > 0
            ? `Entendido: ${matched.join(', ')}. (${tracks.length} faixas inéditas)`
            : `Nenhum termo reconhecido: rádio pelo seu perfil geral. (${tracks.length} faixas inéditas)`;
          renderTrackList(tracks, `Prompt: ${prompt}`);
        } else {
          renderRetryButton('Nenhuma faixa inédita elegível encontrada para este pedido.');
        }
      } catch (err) {
        console.error('[NeuralTune] Erro na rádio por prompt:', err);
        renderRetryButton(
          `Erro ao montar a rádio: ${err instanceof Error ? err.message : String(err)}`,
          true
        );
      } finally {
        setBusy(false);
      }
    };

    quickPromptBtns.forEach((qpBtn) => {
      qpBtn.onclick = async (e) => {
        e?.stopPropagation?.();
        const p = qpBtn.getAttribute('data-prompt') ?? '';
        if (!p || isBusy) return;
        promptInput.value = p;
        await launchPrompt();
      };
    });

    const runDiscovery = async () => {
      if (isBusy) return;
      lastAction = runDiscovery;
      setBusy(true);
      promptStatus.style.color = 'rgba(255,255,255,0.6)';
      promptStatus.textContent = 'Procurando faixas novas dos seus artistas...';
      try {
        const found = await this.deps.launchDiscovery();
        const tracks = this.deps.getLastRadioTracks?.() ?? [];
        if (found > 0) {
          promptStatus.textContent = `${found} faixas novas na fila.`;
          renderTrackList(tracks, 'Deep Cuts — Faixas fora do histórico');
        } else {
          renderRetryButton('O Spotify não entregou faixas novas agora.');
        }
      } catch (err) {
        console.error('[NeuralTune] Erro no Deep Cuts:', err);
        renderRetryButton(
          `Falha ao buscar Deep Cuts: ${err instanceof Error ? err.message : String(err)}`,
          true
        );
      } finally {
        setBusy(false);
      }
    };

    if (discoveryBtn) {
      discoveryBtn.onclick = async (e) => {
        e?.stopPropagation?.();
        await runDiscovery();
      };
    }

    const autopilotButton = el.querySelector('#nt-autopilot') as HTMLButtonElement;
    autopilotButton.onclick = (e) => {
      e?.stopPropagation?.();
      autopilotButton.textContent = `Autopilot: ${this.deps.toggleAutopilot() ? 'ligado' : 'desligado'} (Ctrl+Alt+A)`;
    };

    if (promptGoBtn) {
      promptGoBtn.onclick = async (e) => {
        e?.stopPropagation?.();
        await launchPrompt();
      };
    }
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void launchPrompt();
    });

    radioButtons.forEach((btn) => {
      btn.onclick = async (e) => {
        e?.stopPropagation?.();
        const type = (e.currentTarget as HTMLElement).getAttribute('data-type');
        if (!type || isBusy) return;
        const cardTitle = radioCards.find((c) => c.id === type)?.title ?? type;
        const runCardRadio = async () => {
          if (isBusy) return;
          lastAction = runCardRadio;
          setBusy(true);
          promptStatus.style.color = 'rgba(255,255,255,0.6)';
          promptStatus.textContent = `Iniciando ${cardTitle}...`;
          try {
            await this.deps.launchRadio(type);
            const tracks = this.deps.getLastRadioTracks?.() ?? [];
            if (tracks.length > 0) {
              promptStatus.textContent = `${cardTitle} ativa (${tracks.length} faixas na fila).`;
              renderTrackList(tracks, cardTitle);
            } else {
              renderRetryButton(`Nenhuma faixa elegível encontrada para ${cardTitle}.`);
            }
          } catch (err) {
            console.error(`[NeuralTune] Erro ao iniciar ${cardTitle}:`, err);
            renderRetryButton(
              `Erro ao iniciar ${cardTitle}: ${err instanceof Error ? err.message : String(err)}`,
              true
            );
          } finally {
            setBusy(false);
          }
        };
        await runCardRadio();
      };
    });

    return el;
  }

  /** Evidence about the radios themselves. Failure here hides the table and never touches the tab. */
  private async renderRadioOutcomes(target: HTMLElement | null): Promise<void> {
    if (!target || !this.deps.getRadioOutcomes) return;

    try {
      const report = await this.deps.getRadioOutcomes();
      if (report.exposures === 0) return;

      const percent = (value: number | null) => (value === null ? '–' : `${Math.round(value * 100)}%`);
      const row = (s: OutcomeSummary) => {
        const interval = s.enoughData && s.completionInterval
          ? ` (${percent(s.completionInterval[0])} a ${percent(s.completionInterval[1])})`
          : '';
        return `<tr class="nt-outcome-row">
          <td style="padding: 3px 8px 3px 0;">${esc(s.group)}</td>
          <td style="padding: 3px 8px;">${s.heard} de ${s.exposed}</td>
          <td style="padding: 3px 8px;">${s.enoughData ? percent(s.completionRate) + interval : 'amostra pequena'}</td>
          <td style="padding: 3px 8px;">${s.liked + s.moreLike} / ${s.disliked + s.lessLike}</td>
        </tr>`;
      };

      target.innerHTML = `
        <details style="background: rgba(255,255,255,0.05); padding: 12px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); font-size: 12px;">
          <summary style="cursor: pointer; font-weight: 700;">Como as rádios estão indo</summary>
          ${this.renderWeeklyReport(report)}
          <table style="margin-top: 8px; border-collapse: collapse; width: 100%;">
            <tr style="color: rgba(255,255,255,0.6); text-align: left;"><th>Rádio</th><th style="padding: 0 8px;">Ouvidas</th><th style="padding: 0 8px;">Até o fim</th><th style="padding: 0 8px;">Gostei / não gostei</th></tr>
            ${[...report.byRadio, ...report.bySource, ...report.byArtistNovelty].map(row).join('')}
          </table>
          <p id="nt-radio-experiment" style="margin: 8px 0 0;">${esc(this.describeExperiment('padrão × exploratório', report.experiment))}</p>
          ${report.carryExperiment ? `<p id="nt-radio-carry" style="margin: 6px 0 0;">${esc(this.describeExperiment('com × sem memória de mais/menos assim', report.carryExperiment))}</p>` : ''}
          <p id="nt-radio-ranking" style="margin: 6px 0 0;">${esc(this.describeRanking(report))}</p>
          <p style="margin: 8px 0 0; color: rgba(255,255,255,0.6);">Faixas que não chegaram a tocar não contam contra a rádio. Com menos de 20 ouvidas não há percentual. Diferença entre rádios é associação, não causa. Só o experimento, sorteado a cada rádio, indica causa.</p>
        </details>`;
    } catch (err) {
      console.warn('[NeuralTune] Desempenho das rádios indisponível', err);
    }
  }

  private renderWeeklyReport({ weekly }: RadioOutcomesReport): string {
    if (!weekly || weekly.heard === 0) return '<p id="nt-weekly-report" style="margin: 8px 0 0;">Nos últimos 7 dias: nenhuma faixa de rádio ouvida ainda.</p>';

    const lines = [`Nos últimos 7 dias: ${weekly.heard} faixas de rádio ouvidas, ${weekly.completed} até o fim, ${weekly.newArtistTracks} de artistas novos.`];
    if (weekly.approvedNewArtists.length > 0) lines.push(`Artistas novos aprovados: ${weekly.approvedNewArtists.join('; ')}.`);
    if (weekly.mostSkippedArtists.length > 0) lines.push(`Mais pulados: ${weekly.mostSkippedArtists.map((a) => `${a.artist} (${a.skips})`).join('; ')}.`);
    if (weekly.bestRadio) lines.push(`Rádio com mais escuta até o fim: ${weekly.bestRadio.radio}, ${Math.round(weekly.bestRadio.completionRate * 100)}% de ${weekly.bestRadio.heard} faixas.`);
    return `<div id="nt-weekly-report" style="margin: 8px 0 0;">${lines.map((line) => `<p style="margin: 2px 0;">${esc(line)}</p>`).join('')}</div>`;
  }

  private describeBackup(): string {
    const status = this.deps.getBackupStatus?.();
    if (!status?.lastAt) return status?.error ? `Nenhum backup ainda. ${status.error}` : 'Nenhum backup ainda. Escolha uma pasta.';

    const date = new Date(status.lastAt).toLocaleDateString('pt-BR');
    return `Último backup em ${date}, com ${status.ratings} notas.${status.error ? ` Atenção: ${status.error}` : ''}`;
  }

  private describeExperiment(title: string, { runs, difference, interval, verdict, runsMissing }: RadioOutcomesReport['experiment']): string {
    if (verdict === 'coletando') {
      return `Experimento ${title}: coletando, ${runs.padrao} e ${runs.exploratorio} rádios com faixas ouvidas. Faltam ${runsMissing}.`;
    }

    const points = (value: number) => `${value >= 0 ? '+' : ''}${Math.round(value * 100)}`;
    return `Experimento ${title}: ${verdict} (${points(difference!)} pontos na conclusão, de ${points(interval![0])} a ${points(interval![1])}).`;
  }

  private describeRanking({ ranking }: RadioOutcomesReport): string {
    if (ranking.auc === null) {
      return `Ordenação em faixas inéditas: coletando, ${ranking.completed} ouvidas até o fim e ${ranking.abandoned} abandonadas. São necessárias 10 de cada.`;
    }
    return `Ordenação em faixas inéditas: ${Math.round(ranking.auc * 100)}% de acerto, onde 50% é o acaso.`;
  }

  private async renderPreferencesTab(): Promise<HTMLElement> {
    const el = document.createElement('div');
    const profile = this.deps.preferenceEngine.getProfile();
    const weights = Object.entries(profile.attributeWeights);
    const model = this.deps.preferenceEngine.getModelSnapshot();

    weights.sort((a, b) => Math.abs(b[1].weight) - Math.abs(a[1].weight));

    const ratings = await this.deps.ratingManager.getAllRatings();
    const current = this.deps.getCurrentTrack();
    const currentPoint = toAcousticPoint(current?.acousticFeatures);
    const samples = ratings.flatMap((record) => {
      const point = toAcousticPoint(record.metadata.acousticFeatures);
      return point ? [{ record, point }] : [];
    });
    const { covariance } = weightedCovariance(samples.map(({ point }) => ({ values: standardize(point.values), known: point.known, weight: 1 })), 8);
    const pca = powerIterationPca(covariance);

    const series = [{ label: 'Perfil histórico', values: model.vector, color: '#1db954' }];
    if (model.clusters[0]) {
      series.push({ label: 'Maior cluster', values: model.clusters[0].centroid.map((z, i) => Math.max(0, Math.min(1, POPULATION_MEAN[i] + z * POPULATION_STD[i]))), color: '#509bf5' });
    }
    if (currentPoint) {
      series.push({ label: 'Música atual', values: currentPoint.values.map((value, i) => (currentPoint.known[i] ? value : 0)), color: '#ffffff' });
    }

    const points: ConstellationPoint[] = [
      ...samples.slice(-400).map(({ record, point }) => ({ coordinates: standardize(point.values), label: record.metadata.name, rating: record.rating, kind: 'track' as const })),
      ...model.clusters.map((c, i) => ({ coordinates: c.centroid, label: `Cluster ${i + 1}: ${c.description}`, kind: 'cluster' as const })),
      ...(currentPoint ? [{ coordinates: standardize(currentPoint.values), label: current?.name ?? 'Atual', kind: 'current' as const }] : [])
    ];

    el.innerHTML = `
      <div style="display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 16px; margin-bottom: 16px;">
        <div>${radarSvg(series)}</div>
        <div>${samples.length >= 3 ? constellationSvg(points, pca) : '<p style="font-size: 13px;">O mapa precisa de ao menos 3 faixas com dados acústicos.</p>'}</div>
      </div>

      <div style="background: rgba(255,255,255,0.05); padding: 14px; border-radius: 8px; margin-bottom: 16px;">
        <h3 style="margin-top: 0;">Clusters de Gosto (K = ${model.clusters.length})</h3>
        ${model.clusters.length > 0
          ? model.clusters.map((c, i) => `<div style="font-size: 13px; margin-bottom: 4px;">Cluster ${i + 1} (${Math.round(c.share * 100)}%): ${esc(c.description)} · ${c.samples} faixas <button class="nt-cluster-radio" data-index="${i}" style="background: transparent; color: #fff; border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; font-size: 11px; cursor: pointer;">Rádio</button></div>`).join('')
          : '<p style="font-size: 13px; color: rgba(255,255,255,0.6);">Ainda não há avaliações 4★ ou 5★ com dados acústicos.</p>'}
        <div style="font-size: 12px; color: rgba(255,255,255,0.55); margin-top: 6px;">Sinais implícitos no modelo: ${model.implicitSignals}</div>
      </div>

      <div style="background: rgba(255,255,255,0.05); padding: 14px; border-radius: 8px; margin-bottom: 16px;">
        <h3 style="margin-top: 0;">Vetor Acústico do Perfil (${model.samples} avaliações com áudio, ${model.avoidancePoints} zonas bloqueadas)</h3>
        ${ACOUSTIC_DIMENSIONS.map((dimension, i) => {
          const percent = Math.round(model.vector[i] * 100);
          return `
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 5px; font-size: 12px;">
              <div style="width: 120px;">${dimension}</div>
              <div style="flex: 1; background: rgba(255,255,255,0.1); border-radius: 4px; height: 8px; overflow: hidden;">
                <div style="background: #1db954; width: ${percent}%; height: 100%;"></div>
              </div>
              <div style="width: 40px; text-align: right; color: rgba(255,255,255,0.7);">${percent}%</div>
            </div>
          `;
        }).join('')}
      </div>

      <p style="color: rgba(255,255,255,0.7); margin-top: 0; font-size: 13px;">
        Pesos calculados através de suavização Bayesiana. Um único bloqueio (nota 0) penaliza atributos proporcionalmente sem extinguir gêneros inteiros.
      </p>

      <div style="max-height: 320px; overflow-y: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead>
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.1); text-align: left;">
              <th style="padding: 8px;">Atributo</th>
              <th style="padding: 8px;">Afinidade</th>
              <th style="padding: 8px;">Amostras</th>
              <th style="padding: 8px;">Confiança</th>
            </tr>
          </thead>
          <tbody>
            ${weights.map(([attr, w]) => `
              <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                <td style="padding: 8px; font-weight: 600;">${esc(attr)}</td>
                <td style="padding: 8px; font-weight: 700; color: ${w.weight > 0 ? '#1db954' : w.weight < 0 ? '#e22134' : '#fff'};">
                  ${w.weight > 0 ? '+' : ''}${(w.weight * 100).toFixed(1)}%
                </td>
                <td style="padding: 8px; color: rgba(255,255,255,0.6);">${w.count}</td>
                <td style="padding: 8px;">${Math.round(w.confidence * 100)}%</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    el.querySelectorAll('.nt-cluster-radio').forEach((button) => {
      (button as HTMLElement).onclick = async (e) => {
        e?.stopPropagation?.();
        const btn = button as HTMLButtonElement;
        const index = Number(btn.getAttribute('data-index'));
        const cluster = model.clusters[index];
        if (!cluster || btn.disabled) return;
        btn.disabled = true;
        btn.textContent = '...';
        try {
          await this.deps.launchClusterRadio(cluster.centroid);
          await this.switchToTab?.('radios');
        } finally {
          btn.disabled = false;
          btn.textContent = 'Rádio';
        }
      };
    });

    return el;
  }

  private renderScienceTab(): HTMLElement {
    const el = document.createElement('div');
    const flags = this.deps.getFlags();
    const evaluation = this.deps.getEvaluation();
    const capabilities = this.deps.getCapabilities();
    const moduleByEvidence: Record<string, keyof ModuleFlags> = {
      'predictive-coding': 'predictive', 'rhythm-dynamics': 'rhythm', plasticity: 'plasticity',
      calibration: 'calibrated', circadian: 'circadian', morphology: 'morphology'
    };

    const rows = evaluation?.usable
      ? Object.entries(evaluation.results).map(([name, m]) => `<tr><td style="padding: 4px;">${esc(name)}</td><td>${m.ndcg.toFixed(3)}</td><td>${m.precision.toFixed(3)}</td><td>${m.diversity.toFixed(3)}</td><td>${m.calibrationKL.toFixed(3)}</td></tr>`).join('')
      : '';

    el.innerHTML = `
      <p style="font-size: 13px; color: rgba(255,255,255,0.7); margin-top: 0;">
        Inspiração biológica não é validação biológica: o NeuralTune não mede cérebro, emoção ou fisiologia. Ele infere padrões a partir de notas, reproduções e análise de áudio.
      </p>
      ${SCIENTIFIC_EVIDENCE.map((entry) => {
        const flag = moduleByEvidence[entry.id];
        return `
        <details style="background: rgba(255,255,255,0.05); padding: 10px 14px; border-radius: 8px; margin-bottom: 8px;">
          <summary style="cursor: pointer; font-weight: 700;">${esc(entry.mechanism)}</summary>
          <label style="display: block; font-size: 13px; margin: 8px 0;"><input type="checkbox" class="nt-flag" data-flag="${esc(flag)}" ${flags[flag] ? 'checked' : ''}/> Ativo nas recomendações</label>
          <p style="font-size: 13px;"><strong>Hipótese:</strong> ${esc(entry.hypothesis)}</p>
          <p style="font-size: 13px;"><strong>Evidência:</strong> ${esc(entry.evidenceType)}</p>
          <p style="font-size: 13px;"><strong>Limitações:</strong> ${esc(entry.limitations)}</p>
          <p style="font-size: 12px; font-family: monospace;">${entry.equations.map(esc).join('<br>')}</p>
          <ul style="font-size: 12px;">${entry.references.map((r) => `<li>${esc(r.citation)} (${esc(r.access)})</li>`).join('')}</ul>
        </details>`;
      }).join('')}

      <h3>Avaliação nas suas notas</h3>
      ${rows
        ? `<table style="width: 100%; font-size: 12px; border-collapse: collapse;"><tr style="text-align: left;"><th>Modelo</th><th>NDCG@10</th><th>Precisão</th><th>Diversidade</th><th>KL</th></tr>${rows}</table>
           <p style="font-size: 12px; color: rgba(255,255,255,0.6);">Divisão temporal em ${evaluation?.ratings} notas, com ${evaluation?.testPositives} positivas no teste. Mede a ordenação de faixas já avaliadas.</p>`
        : `<p style="font-size: 13px;">${esc(evaluation?.reason ?? 'A avaliação roda cerca de 90 s depois de abrir o Spotify.')}</p>`}

      <h3>APIs disponíveis neste cliente</h3>
      ${capabilities
        ? `<ul style="font-size: 12px; columns: 2;">${capabilities.results.map((r) => `<li>${r.available ? '✓' : '✕'} ${esc(r.name)} <span style="opacity: .6;">${esc(r.detail)}</span></li>`).join('')}</ul>`
        : '<p style="font-size: 13px;">A verificação roda cerca de 20 s depois de abrir o Spotify.</p>'}
    `;

    el.querySelectorAll('.nt-flag').forEach((input) => {
      input.addEventListener('change', (e) => {
        const target = e.currentTarget as HTMLInputElement;
        this.deps.setFlags({ ...this.deps.getFlags(), [target.getAttribute('data-flag') as string]: target.checked });
      });
    });

    return el;
  }

  private async renderDataTab(): Promise<HTMLElement> {
    const el = document.createElement('div');
    const audio = this.deps.getAudioDiagnostics();
    const ratedSources = await this.deps.getRatedSources();
    const clusters = this.deps.preferenceEngine.getModelSnapshot().clusters;
    const primary = 'background: #1db954; color: #000; border: none; font-weight: 700; padding: 8px 16px; border-radius: 500px; cursor: pointer;';
    const secondary = 'background: transparent; color: #fff; border: 1px solid rgba(255,255,255,0.4); font-weight: 700; padding: 8px 16px; border-radius: 500px; cursor: pointer;';
    const statusLabels: Record<AudioFeatureDiagnostics['status'], string> = {
      unknown: 'Ainda não consultado',
      available: 'Disponível',
      'backing-off': 'Aguardando nova tentativa',
      unavailable: 'Recusado pelo Spotify nesta sessão'
    };

    el.innerHTML = `
      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin-bottom: 14px;">
        <h3 style="margin-top: 0;">Exportar</h3>
        <p style="font-size: 13px; color: rgba(255,255,255,0.7);">O JSON é a cópia completa (notas, histórico, skips e blacklist). O CSV abre no Excel e no Google Sheets.</p>
        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
          <button id="nt-export-json" style="${primary}">Exportar JSON completo</button>
          <button id="nt-export-csv" style="${secondary}">Exportar CSV</button>
          <button id="nt-export-dossier" style="${primary}">Dossiê analítico (HTML)</button>
          <button id="nt-export-jspf" style="${secondary}">JSPF (ListenBrainz)</button>
          <button id="nt-export-radio" style="${secondary}">Última rádio (JSPF)</button>
          <button id="nt-export-covariance" style="${secondary}">Covariância e PCA</button>
          <button id="nt-export-graph" style="${secondary}">Grafo GraphML</button>
        </div>
      </div>

      ${this.deps.chooseBackupFolder ? `
      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin-bottom: 14px;">
        <h3 style="margin-top: 0;">Backup automático</h3>
        <p style="font-size: 13px; color: rgba(255,255,255,0.7);">Toda semana grava uma cópia completa na pasta escolhida, confere o arquivo e mantém as 8 mais recentes. Suas notas só existem neste computador até haver um backup.</p>
        <p id="nt-backup-status" style="font-size: 13px;">${esc(this.describeBackup())}</p>
        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
          <button id="nt-backup-choose" style="${primary}">Escolher pasta</button>
          <button id="nt-backup-now" style="${secondary}">Fazer backup agora</button>
        </div>
      </div>` : ''}

      ${this.deps.importHistory ? `
      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin-bottom: 14px;">
        <h3 style="margin-top: 0;">Importar histórico do Spotify</h3>
        <p style="font-size: 13px; color: rgba(255,255,255,0.7);">Peça o "histórico estendido de streaming" em spotify.com/account/privacy. Quando o e-mail chegar, extraia o ZIP e selecione <strong>todos</strong> os arquivos Streaming_History_Audio de uma vez. O NeuralTune guarda só faixa, artista e contagens; IP, país e dispositivo são ignorados. Nada sai deste computador.</p>
        <input id="nt-history-files" type="file" accept=".json,application/json" multiple style="font-size: 12px;" />
      </div>` : ''}

      ${this.deps.refreshWeeklyDiscoveries ? `
      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin-bottom: 14px;">
        <h3 style="margin-top: 0;">Descobertas da Semana</h3>
        <p style="font-size: 13px; color: rgba(255,255,255,0.7);">Playlist privada renovada toda semana, só com faixas inéditas e pelo menos 40% de artistas novos quando houver. Fica no Spotify, então também toca no celular.</p>
        <button id="nt-weekly-now" style="${secondary}">Gerar agora</button>
      </div>` : ''}

      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin-bottom: 14px;">
        <h3 style="margin-top: 0;">Captura local de áudio</h3>
        <p style="font-size: 13px; color: rgba(255,255,255,0.7);">O Spotify toca música fora da página, então a análise local precisa de um dispositivo de loopback, como Mixagem Estéreo ou VB-CABLE. Ele ouve tudo o que o Windows toca, não só o Spotify.</p>
        <button id="nt-toggle-capture" style="${secondary}">${this.deps.isCapturing() ? 'Parar captura' : 'Iniciar captura'}</button>
      </div>

      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin-bottom: 14px;">
        <h3 style="margin-top: 0;">Playlists do Spotify</h3>
        <p style="font-size: 13px; color: rgba(255,255,255,0.7);">Cria ou atualiza as playlists de 5★, 4★ e 0★ na sua conta. Elas espelham as notas: faixas adicionadas à mão nelas são removidas.</p>
        <button id="nt-sync-playlists" style="${primary}">Sincronizar playlists agora</button>
      </div>

      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin-bottom: 14px;">
        <h3 style="margin-top: 0;">Importar JSON</h3>
        <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center; font-size: 13px;">
          <label for="nt-merge-strategy">Em caso de conflito:</label>
          <select id="nt-merge-strategy" style="background: #282828; color: #fff; border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; padding: 6px;">
            <option value="highest">Manter a maior nota (bloqueios ficam)</option>
            <option value="newest">Manter a mais recente</option>
            <option value="replace">Usar sempre a do arquivo</option>
            <option value="keepLocal">Manter sempre a local</option>
            <option value="ask">Perguntar a cada conflito</option>
          </select>
          <input id="nt-import-file" type="file" accept=".json,application/json" style="font-size: 12px;" />
        </div>
      </div>

      <div id="nt-data-status" role="status" style="font-size: 13px; line-height: 1.5; padding: 4px 2px;"></div>

      <p style="font-size: 12px; color: rgba(255,255,255,0.55);">
        Dados acústicos: ${esc(statusLabels[audio.status])} · ${audio.cachedTracks} faixas em cache${audio.lastError ? ` · último erro: ${esc(audio.lastError)}` : ''}<br>
        Avaliações por fonte: ${esc(Object.entries(ratedSources).map(([source, count]) => `${source}: ${count}`).join(' · ') || 'nenhuma')}<br>
        Clusters de gosto: ${clusters.length}
      </p>
    `;

    const status = el.querySelector('#nt-data-status') as HTMLElement;
    const report = (message: string) => {
      status.textContent = message;
    };
    const guarded = (action: () => Promise<void>) => async (e?: Event) => {
      e?.stopPropagation?.();
      report('Processando...');
      try {
        await action();
      } catch (err) {
        console.error('[NeuralTune] Falha na operação de dados', err);
        report(`Falhou: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const backupStatus = el.querySelector('#nt-backup-status') as HTMLElement | null;
    const showBackup = () => {
      if (backupStatus) backupStatus.textContent = this.describeBackup();
    };

    el.querySelector('#nt-backup-choose')?.addEventListener('click', guarded(async () => {
      const folder = await this.deps.chooseBackupFolder!();
      if (!folder) {
        report('Nenhuma pasta escolhida.');
        return;
      }
      const result = await this.deps.runBackupNow!();
      showBackup();
      report(result.error ? `Pasta "${folder}" escolhida, mas o backup falhou: ${result.error}` : `Backup gravado e conferido em "${folder}": ${result.ratings} notas.`);
    }));

    el.querySelector('#nt-backup-now')?.addEventListener('click', guarded(async () => {
      const result = await this.deps.runBackupNow!();
      showBackup();
      report(result.error ? `Backup falhou: ${result.error}` : `Backup gravado e conferido: ${result.ratings} notas.`);
    }));

    const historyInput = el.querySelector('#nt-history-files') as HTMLInputElement | null;
    historyInput?.addEventListener('change', guarded(async () => {
      const files = Array.from(historyInput.files ?? []);
      if (files.length === 0) return;

      const result = await this.deps.importHistory!(files);
      historyInput.value = '';
      report(
        `Histórico importado: ${result.plays} reproduções de ${result.tracks} faixas.`
        + (result.alreadyImported > 0 ? ` ${result.alreadyImported} já estavam importadas.` : '')
        + (result.podcasts > 0 ? ` ${result.podcasts} de podcast ignoradas.` : '')
        + (result.incognito > 0 ? ` ${result.incognito} de sessão privada ignoradas.` : '')
        + (result.invalid > 0 ? ` ${result.invalid} inválidas.` : '')
      );
    }));

    el.querySelector('#nt-weekly-now')?.addEventListener('click', guarded(async () => {
      const { tracks, newArtists } = await this.deps.refreshWeeklyDiscoveries!();
      report(tracks > 0 ? `Descobertas da Semana: ${tracks} faixas, ${newArtists} de artistas novos.` : 'Nenhuma faixa inédita disponível agora.');
    }));

    el.querySelector('#nt-export-json')?.addEventListener('click', guarded(async () => {
      report((await this.deps.exportJson()) ? 'JSON exportado.' : 'Exportação cancelada.');
    }));

    el.querySelector('#nt-export-csv')?.addEventListener('click', guarded(async () => {
      report((await this.deps.exportCsv()) ? 'CSV exportado.' : 'Exportação cancelada.');
    }));

    el.querySelector('#nt-export-dossier')?.addEventListener('click', guarded(async () => {
      report((await this.deps.exportDossier()) ? 'Dossiê exportado.' : 'Exportação cancelada.');
    }));

    el.querySelector('#nt-export-jspf')?.addEventListener('click', guarded(async () => {
      report((await this.deps.exportJspf()) ? 'JSPF exportado.' : 'Exportação cancelada.');
    }));

    el.querySelector('#nt-export-radio')?.addEventListener('click', guarded(async () => {
      report((await this.deps.exportLastRadio()) ? 'Rádio exportada.' : 'Nenhuma rádio gerada nesta sessão, ou exportação cancelada.');
    }));

    el.querySelector('#nt-export-covariance')?.addEventListener('click', guarded(async () => {
      report((await this.deps.exportCovariance()) ? 'Covariância exportada.' : 'Exportação cancelada.');
    }));

    el.querySelector('#nt-export-graph')?.addEventListener('click', guarded(async () => {
      report((await this.deps.exportTransitionGraph()) ? 'Grafo exportado.' : 'Exportação cancelada.');
    }));

    const captureButton = el.querySelector('#nt-toggle-capture') as HTMLButtonElement;
    captureButton.addEventListener('click', guarded(async () => {
      const capturing = await this.deps.toggleCapture();
      captureButton.textContent = capturing ? 'Parar captura' : 'Iniciar captura';
      if (!capturing) {
        report('Captura parada.');
        return;
      }

      const { loopbackInputs } = await this.deps.probeCapture();
      report(loopbackInputs.length > 0
        ? `Capturando de: ${loopbackInputs[0]}.`
        : 'Capturando da entrada padrão, que parece ser um microfone. Selecione um dispositivo de loopback no Windows.');
    }));

    el.querySelector('#nt-sync-playlists')?.addEventListener('click', guarded(async () => {
      const results = await this.deps.syncPlaylists();
      report(results
        .map((r) => r.error
          ? `${r.name}: falhou (${r.error})`
          : `${r.name}: ${r.total} faixas (+${r.added} / -${r.removed})`)
        .join(' | '));
    }));

    const fileInput = el.querySelector('#nt-import-file') as HTMLInputElement;
    const strategyInput = el.querySelector('#nt-merge-strategy') as HTMLSelectElement;

    fileInput.addEventListener('change', guarded(async () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      const strategy = strategyInput.value as MergeStrategy;
      const result = await this.deps.importFile(file, strategy, (conflict) => this.askConflict(status, conflict));
      fileInput.value = '';

      report(
        `Importação concluída: ${result.addedRatings} novas notas, ${result.replacedRatings} substituídas, `
        + `${result.keptLocal} locais mantidas de ${result.conflicts} conflitos, ${result.addedArtists} artistas, `
        + `${result.addedPlayEvents} reproduções.`
        + (result.unblockedByMerge > 0 ? ` ${result.unblockedByMerge} faixas bloqueadas foram desbloqueadas pela nota importada.` : '')
        + (result.keptBlocks > 0 ? ` ${result.keptBlocks} bloqueios locais foram mantidos.` : '')
        + (result.invalidRecords > 0 ? ` ${result.invalidRecords} registros inválidos ignorados.` : '')
      );
    }));

    return el;
  }

  private askConflict(status: HTMLElement, conflict: RatingConflict): Promise<'local' | 'imported'> {
    return new Promise((resolve) => {
      status.textContent = '';

      const question = document.createElement('div');
      question.textContent = `"${conflict.name}": sua nota é ${conflict.local.rating}★, o arquivo traz ${conflict.imported.rating}★.`;
      question.style.marginBottom = '8px';

      const choose = (label: string, choice: 'local' | 'imported') => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.cssText = 'background: transparent; color: #fff; border: 1px solid rgba(255,255,255,0.4); border-radius: 4px; padding: 4px 10px; margin-right: 8px; cursor: pointer;';
        button.onclick = (e) => {
          e?.stopPropagation?.();
          resolve(choice);
        };
        return button;
      };

      status.append(
        question,
        choose(`Manter ${conflict.local.rating}★`, 'local'),
        choose(`Usar ${conflict.imported.rating}★`, 'imported')
      );
    });
  }

  private async renderPerformanceTab(): Promise<HTMLElement> {
    const el = document.createElement('div');
    const snap = this.deps.performanceMonitor.getSnapshot();

    el.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 20px;">
        <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.8rem; font-weight: 800; color: #1db954;">${snap.avgQueueEvaluationMs} ms</div>
          <div style="font-size: 12px; color: rgba(255,255,255,0.6);">Tempo Médio Avaliação de Fila</div>
        </div>

        <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.8rem; font-weight: 800; color: #1db954;">${snap.avgScoringMs} ms</div>
          <div style="font-size: 12px; color: rgba(255,255,255,0.6);">Tempo Médio de Pontuação</div>
        </div>

        <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.8rem; font-weight: 800; color: #1db954;">${snap.jsHeapUsedMB ?? 'N/A'} MB</div>
          <div style="font-size: 12px; color: rgba(255,255,255,0.6);">Uso de JS Heap</div>
        </div>
      </div>

      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px;">
        <h3 style="margin-top: 0;">Status do Predictive Queue Guardian</h3>
        <p style="font-size: 13px; line-height: 1.5; margin: 0;">
          • Proteção contra Loops: <strong>Ativa</strong> (Pausa após 10 faixas bloqueadas seguidas)<br>
          • Evicção Antecipada: <strong>Ativa</strong> (Remove faixas antes do carregamento de áudio)<br>
          • Salto Silencioso: <strong>Ativo</strong> (Volume zerado no salto e restaurado na faixa seguinte)<br>
          • Indexação em Memória: <strong>O(1) Hash Sets</strong> (Zero I/O síncrono durante songchange)<br>
          • Listeners Ativos: <strong>${snap.activeListenersCount}</strong> (Descarregamento limpo em navegação)
        </p>
      </div>
    `;

    return el;
  }
}
