import { PredictionResult, ScoreComponent } from '../types/index.ts';

export interface FormattedExplanation {
  trackName: string;
  artistName: string;
  score: number;
  confidencePercent: number;
  summary: string;
  breakdownLine: string;
  positiveFactors: string[];
  negativeFactors: string[];
  noveltyIndicator: string;
  dataSources: string[];
}

export class ExplainabilityEngine {
  formatExplanation(prediction: PredictionResult): FormattedExplanation {
    const track = prediction.track;
    const artistName = track.artists.map((a) => a.name).join(', ') || 'Artista desconhecido';

    const positiveFactors: string[] = [];
    const negativeFactors: string[] = [];
    const dataSources = new Set<string>();

    for (const reason of prediction.reasons) {
      if (reason.impact > 0) {
        positiveFactors.push(`${reason.description} (+${Math.round(reason.impact * 100)}%)`);
      } else {
        negativeFactors.push(`${reason.description} (${Math.round(reason.impact * 100)}%)`);
      }
      dataSources.add(reason.source);
    }

    if (track.acousticFeatures?.source) {
      dataSources.add(track.acousticFeatures.source);
    }

    let summary: string;
    if (!prediction.eligible) {
      summary = `Esta faixa foi excluída da seleção personalizada: ${prediction.rejectionReason ?? 'Bloqueio ativo'}.`;
    } else if (positiveFactors.length === 0 && negativeFactors.length === 0) {
      summary = `Faixa com pontuação neutra (${prediction.score}/100). Ainda não há avaliações suficientes de seus atributos no seu perfil.`;
    } else if (prediction.score >= 70) {
      summary = `Fortemente alinhada ao seu perfil (${prediction.score}/100). Principais razões: ${positiveFactors.slice(0, 2).join('; ')}.`;
    } else if (prediction.score >= 45) {
      summary = `Compatibilidade moderada (${prediction.score}/100), combinando características que você aprova com elementos neutros ou novos.`;
    } else {
      summary = `Pontuação baixa (${prediction.score}/100) devido a fatores desfavoráveis: ${negativeFactors.slice(0, 2).join('; ')}.`;
    }

    let noveltyIndicator = 'Familiar / Baseada em preferências consolidadas';
    if (prediction.noveltyScore > 0.6) {
      noveltyIndicator = 'Exploração alta: contém atributos ainda pouco explorados';
    } else if (prediction.noveltyScore > 0.3) {
      noveltyIndicator = 'Exploração equilibrada: mistura de atributos conhecidos e novos';
    }

    return {
      trackName: track.name,
      artistName,
      score: prediction.score,
      confidencePercent: Math.round(prediction.confidence * 100),
      summary,
      breakdownLine: this.formatBreakdown(prediction.breakdown ?? []),
      positiveFactors,
      negativeFactors,
      noveltyIndicator,
      dataSources: Array.from(dataSources)
    };
  }

  /** One line for a list. Only what the score actually used: an empty line is better than an invented reason. */
  whyRecommended(prediction: PredictionResult, newArtist: boolean): string {
    const reasons = (prediction.breakdown ?? [])
      .filter((component) => component.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, 2)
      .map((component) => component.label);

    if (newArtist) reasons.unshift('artista novo');
    return `Por quê: ${reasons.length > 0 ? reasons.slice(0, newArtist ? 3 : 2).join(' · ') : 'sem sinal forte, entrou para explorar'}`;
  }

  /** "85% afinidade acústica (alta energia + baixa valência), +15% afinidade com o artista, -5% ..." */
  formatBreakdown(breakdown: ScoreComponent[]): string {
    return breakdown
      .map((component, index) => {
        const percent = Math.round(component.share * 100);
        const sign = percent > 0 && index > 0 ? '+' : '';
        return `${sign}${percent}% ${component.label}`;
      })
      .join(', ');
  }
}
