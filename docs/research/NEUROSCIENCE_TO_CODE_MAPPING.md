# Da ciência ao código

Cadeia: resultado → modelo → hipótese → dados → implementação → experimento → resultado. Referências NT-xxx estão em `NEURALTUNE_SCIENTIFIC_FOUNDATIONS.md`.

Todo experimento citado aqui é simulado, salvo indicação contrária. Conclusões são sobre indicadores de recomendação, nunca sobre o cérebro.

## 1. Expectativa estatística

| Elo | Conteúdo |
|---|---|
| Resultado | PPM com decaimento melhora a previsão quando a estatística muda e explica detecção de padrões (NT-059, texto lido) |
| Modelo | Markov de ordem variável com kernel $w(t)$ |
| Hipótese | A imprevisibilidade da faixa explica parte das notas deste usuário |
| Dados | `segments[].pitches` do `audio-analysis`, confirmados em produção |
| Código | `AuditoryPredictiveCodingEngine.ts` |
| Experimento | Ablação em 4 mundos simulados |
| Resultado | +0,006 só no mundo com o efeito; -0,010 nas notas reais. Desligado |
| Permitido concluir | O termo recupera um efeito que existe nos dados |
| Proibido concluir | Que o NeuralTune reproduz a previsão auditiva humana |

## 2. Surpresa, incerteza e prazer

| Elo | Conteúdo |
|---|---|
| Resultado | Prazer varia de forma não linear com incerteza e surpresa em acordes (NT-060, resumo); preferência por complexidade intermediária (NT-061, resumo) |
| Modelo | Regressão com $S$, $H$, $SH$, $S^2$, $H^2$ |
| Hipótese | Cada ouvinte tem o seu formato de preferência por informação |
| Dados | Surpresa e incerteza por faixa, mais notas |
| Código | `fitTasteForInformation` |
| Resultado | Recupera formas opostas em teste. Em dados reais, pendente de $n\ge30$ |
| Limite | Fontes medem eventos de acorde. Aqui é uma média por faixa, muito mais grosseira |

## 3. Sincronização e ritmo

| Elo | Conteúdo |
|---|---|
| Resultado | NT-003 apresenta modelos dinâmicos, incluindo osciladores, como hipóteses abertas |
| Modelo | Kuramoto, comparado com tempo e histograma de padrão |
| Hipótese | Faixas ritmicamente próximas formam transições mais contínuas |
| Dados | `beats[]`, `segments[]` |
| Código | `RhythmDynamicsEngine.ts` |
| Resultado | AUC para separar grooves: padrão 1,00, tempo 0,52, Kuramoto 0,51 |
| Conclusão | Resultado **negativo** para Kuramoto. Reduz-se à diferença de tempo, como a análise de $\dot\phi$ prevê |

## 4. Plasticidade

| Elo | Conteúdo |
|---|---|
| Resultado | Equilíbrio de regras hebbianas depende de como os limites são impostos (NT-273, resumo); Hebb precisa de estabilização (NT-164, resumo) |
| Modelo | Atualização limitada com dois traços e decaimento |
| Hipótese | Limites e decaimento dão estabilidade, e duas escalas separam gosto duradouro de sessão |
| Dados | Notas e `play_events` |
| Código | `AdaptivePreferencePlasticity.ts` |
| Resultado | Efeito marginal nulo na simulação; +0,10 de NDCG nas notas reais, em uma divisão temporal |
| Limite | Os artigos tratam de sinapses. São motivação de estabilidade, não validação |

## 5. Mecanismos sem base no catálogo

Calibração KL, CUSUM, Von Mises, DPP e descoberta vêm de estatística e recomendação. São registrados assim para não vestir métodos gerais de neurociência.

| Mecanismo | Base real | Resultado |
|---|---|---|
| Calibração | Steck (2018) | Pior na simulação; nas notas reais, KL 0,053 → 0,009. Desligada até repetir |
| Circadiano | Page (1954), estatística circular | Sem ganho nem no mundo com efeito. Desligado |
| Morfologia | Heurística de engenharia | Custo de emenda 67% menor. Ligada |
| Descoberta | Fórmula da especificação | 30 faixas no cliente real, por GraphQL; qualidade não medida |
| Autopilot | Regra de nível de fila | Testado; depende de `addToQueue` |

## 6. Áreas do catálogo sem aproveitamento

EEG, MEG, fMRI, decodificação cerebral, Hodgkin-Huxley, integrate-and-fire, conectividade: exigem sensores ou descrevem neurônios, e nenhuma variável deles é observável aqui. Implementá-los seria decoração.
