# Desempenho

Node 24 nesta máquina, com dados simulados e sem latência de API. Reproduzir: `node --experimental-strip-types scripts/research/run_experiments.ts`. Latência dentro do cliente Spotify **não foi medida**, exceto a coluna de ranqueamento da avaliação real (1 a 4 ms para 78 faixas).

| Operação | Medido | Meta |
|---|---|---|
| Retreino com 20.000 notas | 29,9 ms ± 2,7 | < 200 ms |
| `init` com 20.000 notas | 52 ms | n/a |
| Avaliar 300 candidatas | 44,7 ms | n/a |
| Reclassificação calibrada de 300 itens | 2,7 ms | < 50 ms |
| Síntese de 800 segmentos | 0,23 ms | < 5 ms |
| Perfil preditivo de 800 segmentos | 56,2 ms | Sem meta |
| Trajetória de 30 faixas entre 120 | 14,9 ms | n/a |
| PCA por power iteration | 1,1 ms | n/a |
| PCA por Jacobi | 0,8 ms | n/a |
| Ortogonalidade $|v_1^\top v_2|$ | $2{,}2\times10^{-13}$ | $<10^{-6}$ |
| Heap ao fim do experimento | 112 MB | Processo de teste, não o cliente |
| Bundle | 362 KB | n/a |

## Pontos a observar

- O perfil preditivo roda na thread principal, cerca de 56 ms por faixa, e só após a resposta de rede. Com o preenchimento a uma faixa a cada 1,5 s isso é tolerável, mas não é o ideal. Web Worker não foi implementado.
- O PPM guarda tempos de observação: o custo cresce com o tamanho da faixa.
- `getAudioData` baixa a análise inteira por faixa, então o preenchimento é lento de propósito.
- Consumo de memória e tempo de inicialização dentro do Spotify não foram medidos, pois o acesso de depuração foi negado.
