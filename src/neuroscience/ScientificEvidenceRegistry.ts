export type EvidenceStatus = 'experimental' | 'validated-internally' | 'disabled';
export const EvidenceStatus = {};

export interface EvidenceEntry {
  id: string;
  mechanism: string;
  module: string;
  references: Array<{ citation: string; link: string; access: 'FULL_TEXT' | 'ABSTRACT_ONLY' | 'METADATA_ONLY' | 'OUTSIDE_CATALOG' }>;
  hypothesis: string;
  evidenceType: string;
  equations: string[];
  adaptations: string;
  limitations: string;
  validation: string;
  status: EvidenceStatus;
}
export const EvidenceEntry = {};

/**
 * What each mechanism takes from the literature, and how far that goes. Every status here is backed by
 * docs/research/ABLATION_STUDY.md. None of these mechanisms measures anything about a brain.
 */
export const SCIENTIFIC_EVIDENCE: readonly EvidenceEntry[] = [
  {
    id: 'predictive-coding',
    mechanism: 'Surpresa e incerteza por PPM com decaimento de memória',
    module: 'src/neuroscience/AuditoryPredictiveCodingEngine.ts',
    references: [
      { citation: 'Harrison, Bianco, Chait & Pearce (2020). PPM-Decay. PLOS Comput Biol.', link: 'https://doi.org/10.1371/journal.pcbi.1008304', access: 'FULL_TEXT' },
      { citation: 'Pearce (2018). Statistical learning and probabilistic prediction in music cognition. Ann NY Acad Sci.', link: 'https://doi.org/10.1111/nyas.13654', access: 'FULL_TEXT' },
      { citation: 'Cheung, Harrison, Meyer, Pearce, Haynes & Koelsch (2019). Uncertainty and surprise jointly predict musical pleasure and amygdala, hippocampus, and auditory cortex activity. Curr Biol.', link: 'https://doi.org/10.1016/j.cub.2019.09.067', access: 'ABSTRACT_ONLY' },
      { citation: 'Gold, Pearce, Mas-Herrero, Dagher & Zatorre (2019). Predictability and uncertainty in the pleasure of music: a reward for learning? J Neurosci.', link: 'https://doi.org/10.1523/JNEUROSCI.0428-19.2019', access: 'ABSTRACT_ONLY' }
    ],
    hypothesis: 'A previsibilidade das transições de uma faixa pode explicar parte das notas deste usuário.',
    evidenceType: 'Modelo computacional e experimentos com estímulos musicais; não com recomendação.',
    equations: ['w(t) = w∞ + (w₀ - w∞) 2^(-t/t½)', 'S(x_t) = -log₂ P(x_t | contexto)', 'H = -Σ P log₂ P'],
    adaptations: 'Eventos são classes de altura dominantes, razões de intervalos e brilho quantizado de segmentos, não notas.',
    limitations: 'Surpresa melódica não é calculada: chroma polifônico não é uma melodia. A faixa é medida sozinha, sem memória de longo prazo do ouvinte.',
    validation: 'Ganho só no mundo simulado em que o efeito existe (+0,006) e -0,010 nas notas reais. Desligado.',
    status: 'experimental'
  },
  {
    id: 'rhythm-dynamics',
    mechanism: 'Perfil rítmico por batidas e padrão de onsets',
    module: 'src/neuroscience/RhythmDynamicsEngine.ts',
    references: [
      { citation: 'Large, Roman, Kim, Cannon, Pazdera, Trainor et al. (2023). Dynamic models for musical rhythm perception and coordination. Front Comput Neurosci.', link: 'https://doi.org/10.3389/fncom.2023.1151895', access: 'FULL_TEXT' },
      { citation: 'Kaplan, Cannon, Jamone & Pearce (2022). Modeling enculturated bias in entrainment to rhythmic patterns. PLOS Comput Biol.', link: 'https://doi.org/10.1371/journal.pcbi.1010579', access: 'FULL_TEXT' }
    ],
    hypothesis: 'Faixas com padrão rítmico parecido formam transições mais contínuas.',
    evidenceType: 'Revisão e modelos de percepção rítmica.',
    equations: ['dθ_i/dt = ω_i + (K/N) Σ sin(θ_j - θ_i)', 'r e^{iψ} = (1/N) Σ e^{iθ_j}'],
    adaptations: 'Kuramoto foi implementado só como comparação: para duas faixas ele depende apenas da diferença de tempo.',
    limitations: 'Nada aqui mede sincronização cerebral.',
    validation: 'Em simulação, padrão de onsets separou grooves (AUC 1,00); tempo e Kuramoto ficaram no acaso (0,52 e 0,51). Kuramoto não é usado no ranking.',
    status: 'validated-internally'
  },
  {
    id: 'plasticity',
    mechanism: 'Pesos limitados com traços duradouro e momentâneo',
    module: 'src/neuroscience/AdaptivePreferencePlasticity.ts',
    references: [
      { citation: 'Rubin, Lee & Sompolinsky (2001). Equilibrium properties of temporally asymmetric Hebbian plasticity. Phys Rev Lett.', link: 'https://doi.org/10.1103/PhysRevLett.86.364', access: 'ABSTRACT_ONLY' },
      { citation: 'Zenke, Gerstner & Ganguli (2017). The temporal paradox of Hebbian learning and homeostatic plasticity. Curr Opin Neurobiol.', link: 'https://doi.org/10.1016/j.conb.2017.03.015', access: 'ABSTRACT_ONLY' }
    ],
    hypothesis: 'Limites e decaimento mantêm a preferência estável, e separar escalas de tempo ajuda a captar a sessão.',
    evidenceType: 'Teoria de plasticidade sináptica, usada só como motivação de estabilidade.',
    equations: ['w_{t+1} = w_t + η_t Δ_t (b - w_t)'],
    adaptations: 'A evidência Δ é mapeada de eventos digitais; não há análogo de STDP, pois nenhum evento tem tempo de disparo.',
    limitations: 'O mapeamento de eventos é escolha de modelagem. Um skip isolado vale 0.',
    validation: 'Sem efeito marginal na simulação, mas +0,10 de NDCG nas notas reais em uma divisão temporal. Uma pessoa, sem intervalo de confiança.',
    status: 'validated-internally'
  },
  {
    id: 'calibration',
    mechanism: 'Calibração da fila por divergência KL',
    module: 'src/core/CalibratedRanker.ts',
    references: [
      { citation: 'Steck (2018). Calibrated Recommendations. RecSys.', link: 'https://doi.org/10.1145/3240323.3240372', access: 'OUTSIDE_CATALOG' }
    ],
    hypothesis: 'A fila deve refletir a proporção dos gostos do usuário, incluindo os minoritários.',
    evidenceType: 'Método publicado de recomendação.',
    equations: ['Q̃ = (1-ε)Q + εP', 'D_KL(P‖Q̃)', 'U(x|S) = (1-λ) Score(x) - λ ΔD_KL'],
    adaptations: 'Classes são clusters acústicos aprendidos, não gêneros.',
    limitations: 'IPS só se aplica a faixas com propensão conhecida; o viés restante permanece.',
    validation: 'Reduziu NDCG na simulação, mas baixou KL de 0,053 para 0,009 nas notas reais sem perda. Sinais conflitantes: desligado até repetir com mais notas.',
    status: 'disabled'
  },
  {
    id: 'circadian',
    mechanism: 'Prior temporal por Von Mises e detecção de mudança por CUSUM',
    module: 'src/core/CircadianSessionController.ts',
    references: [
      { citation: 'Page (1954). Continuous inspection schemes. Biometrika.', link: 'https://doi.org/10.1093/biomet/41.1-2.100', access: 'OUTSIDE_CATALOG' }
    ],
    hypothesis: 'O horário de escuta pode predizer qual gosto será preferido, e quedas sustentadas indicam mudança de padrão.',
    evidenceType: 'Métodos estatísticos gerais; o catálogo não sustenta o uso em música.',
    equations: ['p(θ|k) = exp(κ cos(θ-μ)) / (2π I₀(κ))', 'S_t = max(0, S_{t-1} + r̂_t - r_t - δ)'],
    adaptations: 'κ é reduzido por um prior, então com poucos dados vale a distribuição geral.',
    limitations: 'Horário não mede humor nem ritmo biológico. Um pivô indica mudança de interação, não de emoção.',
    validation: 'Sem ganho nem no mundo simulado com efeito de horário (+0,003 ± 0,005). Desligado por padrão.',
    status: 'disabled'
  },
  {
    id: 'morphology',
    mechanism: 'Custo de emenda entre fim e início de faixas',
    module: 'src/core/SegmentMorphologyEngine.ts',
    references: [
      { citation: 'Hansen, Kragness, Vuust, Trainor & Pearce (2021). Predictive uncertainty underlies auditory boundary perception. Psychol Sci.', link: 'https://doi.org/10.1177/0956797621997349', access: 'ABSTRACT_ONLY' }
    ],
    hypothesis: 'Proximidade de atributos na emenda reduz a descontinuidade medida.',
    evidenceType: 'Heurística de engenharia; a referência motiva a atenção a fronteiras, não o custo.',
    equations: ['SeamCost(i,j) = ‖v_outro(i) - v_intro(j)‖²_W + γ CamelotDist(i,j)'],
    adaptations: 'Pesos ajustados por escala típica, não por percepção.',
    limitations: 'Custo baixo não garante mixagem sem emenda. Associação de skip nunca indica causa.',
    validation: 'Custo de emenda 67% menor em simulação, sem perda significativa de nota. Mede atributos, não percepção.',
    status: 'validated-internally'
  }
];

export function evidenceFor(id: string): EvidenceEntry | undefined {
  return SCIENTIFIC_EVIDENCE.find((entry) => entry.id === id);
}
