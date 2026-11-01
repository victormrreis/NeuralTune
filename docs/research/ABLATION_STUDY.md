# Estudo de ablação

## Notas reais

388 notas, divisão única, todos os módulos ligados como referência (NDCG 0,860). É uma só divisão, sem intervalo: indica direção, não prova.

| Removido | NDCG@10 | Efeito do módulo |
|---|---|---|
| Plasticidade | 0,760 | **+0,100** |
| Calibração | 0,836 | +0,024, com KL bem menor |
| Ritmo | 0,860 | 0 |
| Morfologia | 0,860 | 0 |
| Circadiano | 0,860 | 0 |
| Preditivo | 0,870 | **-0,010** |

Ritmo e morfologia atuam na ordem da fila, que esta métrica não mede: o zero aqui não diz nada sobre eles. O preditivo ainda não tinha dados suficientes em todas as faixas, com a síntese v3 sendo recalculada. O circadiano não tem como agir com uma só sessão de teste.

## Simulação: efeito marginal sobre "só artista"

ΔNDCG pareado, 20 sementes, IC 95%. `*` indica intervalo sem o zero.

| Módulo | Nulo | Contexto | Informação | Deriva |
|---|---|---|---|---|
| Preditivo | 0,000 ±0,002 | +0,001 ±0,003 | **+0,006 ±0,004*** | +0,001 ±0,002 |
| Plasticidade | -0,004 ±0,005 | -0,001 ±0,004 | +0,001 ±0,003 | +0,004 ±0,008 |
| Circadiano | -0,002 ±0,005 | -0,002 ±0,005 | -0,001 ±0,003 | +0,002 ±0,005 |
| Calibração | **-0,029 ±0,017*** | **-0,013 ±0,012*** | **-0,015 ±0,007*** | -0,001 ±0,021 |
| Todos | **-0,019 ±0,016*** | -0,011 ±0,012 | **-0,007 ±0,006*** | 0,000 ±0,020 |

**Correção de método.** A primeira rodada comparava cada módulo com a 3.0 e deu à plasticidade +0,025 a +0,053. Depois do termo de artista, esse ganho desapareceu na simulação: vinha desse sinal.

## Outros módulos

| Módulo | Medida | Resultado |
|---|---|---|
| Morfologia | Custo de emenda, simulado | 6,48 → 2,11 (-67%), sem perda significativa de nota |
| Ritmo | AUC para separar grooves, simulado | Padrão 1,00; tempo 0,52; **Kuramoto 0,51** |
| Discovery | Deep Cuts no cliente real | Busca retornou 30 faixas, 21 de álbuns; qualidade das faixas **não medida**: exige que você as ouça e avalie |
| Autopilot | Estabilidade de fila | Testado em simulação; sem dados reais |

## Decisões

| Módulo | Padrão | Motivo |
|---|---|---|
| Plasticidade | Ligado | Efeito real positivo; simulação neutra |
| Ritmo por padrão | Ligado | Separa grooves, sem custo |
| Morfologia | Ligado | Reduz a descontinuidade medida |
| Calibração | Desligado | Sinais conflitantes: reavaliar com mais notas |
| Preditivo | Desligado | Sem ganho real até agora |
| Circadiano | Desligado | Sem ganho em nenhum cenário |
| Kuramoto | Fora do ranking | Sem informação além do tempo |

Todos podem ser alternados na aba **Ciência por trás da recomendação**.
