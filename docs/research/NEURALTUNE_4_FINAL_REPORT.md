# Relatório final do NeuralTune 4.0

## Resultado principal

Nas 851 notas reais, por origens móveis: **NDCG@10 de 0,649 na 4.0, 0,482 na 3.0 e 0,438 ao acaso**. A primeira medição, com 388 notas, deu 0,809; veja a seção de diagnóstico. O ganho vem de um sinal simples, a nota média por artista, combinado aos sinais já existentes. Com uma pessoa e centenas de notas, sinais simples superaram os modelos sofisticados.

Isso mede ordenação de faixas avaliadas por um usuário. Não prova melhor experiência de escuta.

## Situação por componente

| Componente | Implementado | Testado | Validado | Em produção |
|---|---|---|---|---|
| Preditivo (PPM-Decay) | Sim | Sim | Só em simulação | Dados coletados, termo desligado |
| Ritmo por padrão | Sim | Sim | Só em simulação | Ligado |
| Kuramoto | Sim | Sim | **Resultado negativo** | Fora do ranking |
| Plasticidade | Sim | Sim | Efeito real em 1 divisão | Ligada |
| Registro de evidências | Sim | Sim | n/a | Ligado |
| Morfologia e emenda | Sim | Sim | Só em simulação | Ligada |
| Atribuição de skip | Sim | Sim | Não | **Sem uso na interface** |
| Circadiano e CUSUM | Sim | Sim | **Sem ganho** | Desligado |
| Calibração KL | Sim | Sim | Sinais conflitantes | Desligada |
| IPS | Sim | Sim | n/a | Peso 1: sem log de exposição |
| Deep Cuts fora da biblioteca | Sim | Sim | Busca confirmada no cliente real: 30 faixas | Ligada; cliques não exercitados |
| Fallback de descoberta local | Sim | Sim | Não | Ligado |
| Autopilot | Sim | Sim, com simulação | Não no cliente real | Disponível, `Ctrl+Alt+A` |
| Função $J(x)$ | Sim | Sim | Não | **Não usada pelo Autopilot** |
| Radar e PCA | Sim | Sim, em Chromium | n/a | Ligados |
| Dossiê HTML | Parcial | Sim | n/a | Disponível |
| Sonda de capacidades | Sim | Sim | Rodou no cliente | Ligada |
| Avaliação no cliente | Sim | Sim | Rodou no cliente | Ligada |

## Pendências em relação à especificação

- **Dossiê científico:** os 11 itens não estão completos para as 40 referências. Há 14 textos abertos lidos por trechos, 20 resumos e 6 só metadados. Os 40 têm resumo, quando disponível, e aplicação.
- **Dossiê HTML:** faltam histórico de descobertas, evolução de clusters e estatísticas de exploração, porque esses dados não são gravados.
- **Mapa:** seleção por região, gradientes e incerteza não foram feitos. Há rádio por cluster.
- **Radar:** zonas de evitação e intervalos de confiança não são desenhados.
- **`Autopilot`:** sem reação a pivôs enquanto o circadiano estiver desligado.
- **Web Worker:** não implementado.
- **Latência, memória e inicialização reais:** não medidas.
- **Interface real:** Rádio de Descoberta confirmada com clique real; abas e demais rádios verificadas no cliente pelo autoteste, sem reprodução.
- **Deep Cuts:** parte dos álbuns que você avaliou, não do catálogo inteiro do artista. Popularidade de faixas de álbum é desconhecida. Qualidade das faixas de artistas novos ainda não medida.
- **Metadados:** faixas sem nome no banco agora são preenchidas por GraphQL ao iniciar e ao exportar.
- **Auditoria dos repositórios:** só README.

## Auditoria de estresse (01/11/2026)

613 testes passando, 225 a mais que os 388 da entrega. Autoteste no cliente real, em modo simulado: 20 de 20 verificações, 0 vazamentos, 13,9 s.

**Unificação da escala.** `ratingToSignal` passou de -0,7/-0,35 para -0,6/-0,3, igual aos demais modelos. Peso 0,3: 0,630 e 0,622 antes, 0,640 depois. A variação entre rodadas iguais é de cerca de 0,01, então a mudança não mostrou ganho nem perda.

| Decisão | Comportamento atual |
|---|---|
| Identidade de música | Remix, acústico, instrumental e regravação contam como a mesma música |
| `LibraryAPI.contains` falhou | Faixa sem confirmação sai enquanto houver 5 confirmadas. Sem isso, a rádio sai sem confirmação |
| Biblioteca | Leitura de até 5.000 faixas, com orçamento de 20 s |
| `highest` e `merge` | Bloqueio local é mantido. `replace`, `newest` e `ask` podem desbloquear |
| Estratégia desconhecida | Recusada antes de gravar |
| Importação ou Trash Bin aplicados | Histórico de desfazer é limpo |
| Regras de versão | Valem nas rádios e no guardião |
| Pior caso medido, com APIs travadas e sem faixas | 9,1 s, com mensagem de erro e botão de repetir |

**Clique real.** Rádio de Descoberta iniciada pelo usuário no Spotify em 01/11/2026: 30 faixas em 185 ms, sem erro, registrada em `neuraltune:last-radio`. As demais rádios seguem verificadas só pelo autoteste, em `dryRun`.

## Diagnóstico do NDCG

Medido no cliente em 01/11/2026 com 851 notas, usando as mesmas rodadas por origens móveis:

| Janela | Notas | Dias | Positivas | 4.0 | Nota por artista | 3.0 | Acaso |
|---|---|---:|---:|---:|---:|---:|---:|
| Primeiras 388 | 388 | 6,0 | 46% | 0,698 | 0,672 | 0,578 | 0,474 |
| Depois delas, isoladas | 463 | 0,9 | 43% | 0,463 | 0,383 | 0,384 | 0,434 |
| Todas | 851 | 6,9 | 44% | 0,649 | 0,482 | 0,482 | 0,438 |

- **O modelo não piorou.** A distância até o acaso se manteve: 0,224 nas primeiras 388 e 0,211 em todas. O valor absoluto caiu, a vantagem não.
- **Ficou mais robusto que a referência.** A nota por artista caiu 0,190, e a 4.0 caiu 0,049. A vantagem da 4.0 sobre ela subiu de 0,026 para 0,167.
- **A linha "isoladas" não mede o modelo em produção.** Ela treina só com as 463 notas de menos de um dia, sem o histórico anterior. Mostra o que acontece sem histórico.
- **O 0,809 não se reproduziu.** Hoje, as mesmas primeiras 388 dão 0,698. A causa não foi identificada. Candidatos: notas reavaliadas mudaram de data e de janela, e o peso de artista 0,3 foi escolhido sobre esses dados, o que tende a inflar o resultado.

Todas as janelas medem ordenação de faixas já avaliadas, não a qualidade das rádios inéditas. Isso agora é medido pelo registro de exposição.

## Registro de exposição

Cada faixa enviada ao player (a primeira e mais 15) grava rádio, posição, origem, artista novo e propensão, no banco `NeuralTuneExposureDB`. O `NeuralTuneDB` não muda de versão, então um backup antigo continua abrindo as notas.

O painel "Como as rádios estão indo" fica na aba de rádios e mostra faixas ouvidas, conclusão e notas por rádio, por origem e por artista novo. Faixa que nunca tocou não conta contra a rádio. Com menos de 20 ouvidas não há percentual. Como você escolhe qual rádio iniciar, diferença entre rádios é associação, não causa.

### Experimento sorteado

Cada rádio sorteia uma variante, com 50% de chance: `padrao` ou `exploratorio`, esta com o dobro da temperatura, limitada a 1. Como a variante vem do sorteio, a diferença entre elas estima efeito causal da exploração.

A unidade de análise é a rádio, não a faixa: faixas de uma sessão se parecem, e contá-las como independentes exageraria a evidência. O painel só dá veredito com 10 rádios por variante, cada uma com pelo menos 3 faixas ouvidas. Na simulação, com 60 rádios, um efeito plantado de 20 pontos foi detectado em pelo menos 18 de 20 sementes, e sem efeito houve no máximo 22 falsos alarmes em 200. Deep Cuts fica fora do sorteio, e a ordem das faixas nele é embaralhada para a posição não explicar diferença entre artistas novos e conhecidos.

### Ordenação em faixas inéditas

Complementa o NDCG: a AUC mede a chance de uma faixa ouvida até o fim ter tido pontuação maior que uma abandonada, com 50% para o acaso. Exige 10 faixas de cada lado. Mede só faixas que tocaram, e conclusão é um sinal mais fraco que uma nota.

**Estado.** Tudo foi validado com dados simulados. Nenhum resultado com escuta real existe ainda.

`play_events` passou a guardar quem escolheu a faixa: `radio`, `autoplay` ou `organic`. Escuta de rádio pesa como não voluntária na plasticidade. O histórico anterior segue voluntário. A propensão é uma aproximação, $\min(1, k\,p_i)$, para $k$ sorteios.

## Recursos de uso diário

| Recurso | Comportamento | Limite |
|---|---|---|
| Rádio contínua | Com menos de 3 faixas na fila, repõe 5 da mesma rádio, revalidadas no escudo. Tocar algo de fora encerra a sessão | Teto de 120 faixas por rádio. O que aprende dura só a sessão |
| Mais assim / menos assim | Botões na barra do player. Reordenam a fila na hora, preservam a fila manual. "Menos" pula a faixa e tira o artista da sessão | Faixas sem dados acústicos não mudam de posição |
| Por que essa faixa | Linha em cada faixa da rádio, com os maiores componentes reais da pontuação | Não diz por qual caminho a faixa foi encontrada |
| Backup automático | Toda semana grava o JSON completo na pasta escolhida, relê, confere e mantém 8 cópias. Export muito menor que o maior anterior não apaga cópias antigas | Exige escolher a pasta uma vez. A permissão pode expirar e pedir um clique |
| Descobertas da Semana | Playlist privada renovada a cada 7 dias: inéditas, até 2 por artista, cerca de 40% de artistas novos | Reproduções no celular não chegam ao registro de exposição |

## Histórico de escuta

O escudo agora exclui também o que foi ouvido por pelo menos 5 s, por URI e por identidade de música. Faixa avaliada, curtida ou ouvida não é inédita.

O importador lê o histórico estendido do Spotify (`Streaming_History_Audio_*.json`) e o formato curto da exportação comum. Guarda um registro por faixa em `NeuralTuneHistoryDB`, com faixa, artista e contagens. IP, país, plataforma e demais campos não são lidos. Sessões privadas e podcasts são ignorados, e reproduções anteriores à última importação não contam de novo, por isso todos os arquivos de um pedido entram de uma vez.

O histórico alimenta o sinal implícito apenas em faixas com dados acústicos e o reconhecimento de artistas, que é por nome, porque o arquivo não traz URI de artista. Fica fora dos backups: é grande, e o arquivo original continua com o usuário. O formato foi testado com arquivos sintéticos baseados na documentação do Spotify, não com um export real.

## Memória de mais/menos assim

Os sinais podem valer além da sessão, como evidência na plasticidade: "mais" pesa como 4★ e "menos" como 2★, escolha de modelagem. Se isso ajuda é uma hipótese, por isso cada rádio sorteia, independente da variante de temperatura, se usa essa memória. O painel compara com e sem memória, com os mesmos critérios do outro experimento. A decisão de ligar para todos fica para depois dos dados.

## Alcance do Deep Cuts

Com o hash de reserva, `queryArtistRelated` funciona sem abrir página de artista: um conjunto de artistas relacionados, incluindo artistas ainda não avaliados. Ainda assim, 0 de 30 faixas vinham de artistas novos, porque os favoritos ocupavam as vagas de sementes. Agora são 3 favoritos e até 5 relacionados desconhecidos, e o autoteste no cliente mediu 12 de 30 faixas de artistas novos.

## Descobertas

1. Não há sinal de música no renderer: a captura pedida inicialmente é impossível sem loopback.
2. A Web API responde 429 em todos os endpoints testados, e não recusa só o `audio-features`.
3. As operações GraphQL de discografia só existem depois de carregar páginas de artista. As que carregam ao iniciar (`getAlbumNameAndTracks`, `getArtistNameAndTracks`, `getTrackName`, `queryTrackArtists`) bastam para a descoberta.
4. A fórmula de local scaling não reverte um hub uniforme; Mutual Proximity sim.
5. $B_i$ puro do ACT-R impede a redescoberta de favoritos muito ouvidos.
6. Com a nota do artista presente, Kuramoto, circadiano e preditivo não acrescentaram quase nada.

## Dados preservados

A avaliação agregada desta etapa usou 388 notas. Backups locais não são distribuídos.

**Reverter:** copie `neuraltune-v3-implantado.js` do backup v3 para `%APPDATA%\spicetify\Extensions\neuraltune.js` e rode `spicetify apply`.

## O próximo passo com mais valor

Reavaliar calibração e preditivo com mais notas e com a síntese v3 completa. A aba de Ciência já mostra a avaliação a cada abertura do Spotify.
