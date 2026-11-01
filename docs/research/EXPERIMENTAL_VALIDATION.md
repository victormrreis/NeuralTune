# Validação experimental

Scripts: `scripts/research/run_experiments.ts` (simulado, resultado em `data/experiments.json`) e `runEvaluation` no cliente (real, em `data/real_evaluation.json`).

## Dados reais

388 notas do próprio usuário, medidas dentro do Spotify. Nenhum dado de reprodução pesa muito: o histórico é recente.

**Protocolo.** Treino nas notas mais antigas, teste nas seguintes, mesmas divisões para todos. Faixas candidatas são as de teste, com a nota oculta.

**Viés importante.** Só há nota para o que o usuário escolheu avaliar. Isso mede ordenação entre faixas avaliadas, não a qualidade em faixas desconhecidas. E há um único usuário: nada aqui generaliza.

### Origens móveis (cortes 50, 60, 70, 80%)

| Modelo | NDCG@10 médio | Desvio entre cortes |
|---|---|---|
| **4.0, peso de artista 0,3** | **0,809** | 0,091 |
| 4.0, peso 0,15 | 0,802 | 0,097 |
| 4.0, peso 0,8 | 0,799 | 0,117 |
| 4.0, peso 0,5 | 0,791 | 0,070 |
| 4.0, peso 1,2 | 0,786 | 0,123 |
| Nota por artista | 0,749 | 0,123 |
| 4.0 sem termo de artista | 0,633 | 0,169 |
| NeuralTune 3.0 | 0,596 | 0,180 |

Os cortes compartilham dados de treino: o desvio mostra estabilidade e **não é intervalo de confiança**. Os pesos entre 0,15 e 0,8 são indistinguíveis, e 0,3 foi mantido sem ajuste fino. Como os pesos foram comparados nessas mesmas notas, o 0,809 é levemente otimista.

### Divisão única (80%)

Teste com 78 faixas e 34 positivas.

| Modelo | NDCG@10 |
|---|---|
| Nota por artista | 0,927 |
| Todos os módulos | 0,860 |
| NeuralTune 4.0 | 0,842 |
| 4.0 só com artista | 0,722 |
| NeuralTune 3.0 | 0,478 |
| Com diversidade (MMR) | 0,473 |
| Similaridade acústica | 0,233 |

Nesta divisão o baseline vence, e nas origens móveis perde. Por isso uma divisão isolada não sustenta conclusão.

### Baselines exigidos

"Ranking contextual" não tem resultado real separado: as notas de teste caíram numa única sessão, o que impede avaliar contexto de horário.

## Simulação

Vinte sementes, comparação pareada, IC de 95%. Mundos: nulo, com efeito de horário, com efeito de informação, com deriva.

O simulador é escrito por mim e contém os efeitos que testa. Ele serve para duas perguntas: o módulo recupera um efeito que existe? Ele prejudica quando o efeito não existe? **Não serve como evidência sobre pessoas.**

## Divergência entre simulação e dados reais

| Módulo | Simulação | Notas reais |
|---|---|---|
| Plasticidade | Efeito marginal nulo | +0,10 em divisão única |
| Calibração | Piora NDCG, KL quase igual | NDCG estável, KL de 0,053 para 0,009 |

Prevalece o dado real, com a ressalva de ser uma única divisão. Calibração é a candidata mais promissora a repetir com mais notas.

## Validação do bundle

Chromium real com `Spicetify` simulado: 8 abas sem erro, radar com as 8 dimensões, mapa com aviso de variância, `Ctrl+Alt+A`, dossiê aberto como documento e filtrando. Web Audio real: acorde de Dó maior reconhecido como 8B pela captura.

No Spotify real, por dados gravados: sonda, avaliação, síntese e preenchimento rodaram. **Cliques na interface real, Autopilot, rádios e exportações não foram exercitados ali.**
