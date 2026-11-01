# Arquitetura e viabilidade de dados

Linha de base antes da 4.0: 281 testes passando, 7.843 linhas em `src/`, Spotify 1.3.6.1921, Spicetify 2.46+.

## Como as capacidades foram verificadas

Por sonda dentro do cliente real (`ApiCapabilityProbe.ts`), que grava só formatos, nunca conteúdo. Reiniciar o Spotify com porta de depuração foi negado pelo sistema de permissões e não foi contornado.

| Capacidade | Medido no cliente real |
|---|---|
| `Spicetify.getAudioData` | **Funciona**: `segments`, `beats`, `sections` |
| `/v1/audio-features` | **429** |
| `/v1/tracks`, `/v1/artists/*`, `/v1/albums/*` | **429** em todos |
| `LibraryAPI.getTracks` | Funciona |
| `RootlistAPI.getContents`, `PlaylistAPI` | Funcionam |
| `PlayerAPI._queue._queueState` | Funciona |
| `Spicetify.addToQueue` | Presente, não exercitada no cliente real |
| `Spicetify.GraphQL` | 71 definições ao iniciar |
| `queryArtistDiscographyAlbums`, `queryArtistRelated` | **Ausentes ao iniciar**: blocos do bundle carregados só em páginas de artista |
| `getArtistNameAndTracks` | **Funciona**, mas devolveu só 10 faixas com limite 200 |
| `getAlbumNameAndTracks`, `getTrackName`, `queryTrackArtists` | **Funcionam** ao iniciar |
| `getUserMedia`, `getDisplayMedia` | Presentes, não exercitadas no cliente real |

**Correção de premissa:** a documentação da 3.0 falava em recusa definitiva do `audio-features`, com base em fóruns. Medido, é 429 em toda a Web API. A causa exata é desconhecida: pode ser limite por token ou efeito de chamadas anteriores. A `getAudioData` usa outro host e segue funcionando.

**Áudio:** com música tocando, a sessão ativa do Windows pertence ao processo principal `Spotify.exe`, e os renderers não têm DLLs de áudio. Não há sinal de música na página, então DRM ou elemento `<audio>` nem entram em questão.

## Matriz algoritmo × dados

| Algoritmo | Dados que exige | Disponível | Situação |
|---|---|---|---|
| PPM harmônico, rítmico, timbral | `segments[]` | Sim | Implementado |
| Surpresa melódica | Sequência de notas | **Não** | Bloqueado, recusa explícita |
| Ritmo por padrão | `beats[]`, `segments[]` | Sim | Implementado |
| Kuramoto | Frequências | Sim | Implementado só para comparação |
| Plasticidade | Notas, `play_events` | Sim | Implementado |
| Separação de voluntário e involuntário | Origem da reprodução | Sim, para novos eventos | `play_events.origin`; histórico anterior tratado como voluntário |
| Morfologia | `segments[]` | Sim | Implementado |
| Associação de skip | Linha do tempo + 12 skips | Sim, pouca amostra | Implementado, sem uso na interface |
| Von Mises e CUSUM | Timestamps | Sim | Implementado, desligado |
| Popularidade na descoberta | `/v1/tracks` ou GraphQL | **Parcial** | Posição no top do artista; faixas de álbum ficam neutras |
| Descoberta fora da biblioteca | Álbuns das notas altas e GraphQL | Sim | Implementado: 30 faixas no cliente real, 21 de álbuns e 9 do top do artista |
| Artistas relacionados | `queryArtistRelated` | Sim, com hash de reserva | 3 favoritos e até 5 relacionados desconhecidos como sementes |
| Calibração | Clusters | Sim | Implementado, desligado |
| IPS | Log de exposição | Sim, para novas rádios | Propensão aproximada do sorteio; peso 1 quando desconhecida |
| Autopilot | Fila, `addToQueue` | Sim | Implementado |
| Gêneros | `/v1/artists` | **Não hoje** | Sem fonte; propagação pronta |
| EEG, MEG, fMRI | Sensores | **Não** | Fora de escopo |

## Módulos

Novos: `src/neuroscience/` (4), `src/discovery/` (2), `src/evaluation/`, `core/NeuralContextModel`, `FeatureFlags`, `ApiCapabilityProbe`, `SegmentMorphologyEngine`, `CircadianSessionController`, `CalibratedRanker`, `queue/AutopilotDaemon`, `ui/TasteVisualizer`.

Armazenamento: sem mudança de esquema, `NeuralTuneDB` segue em v2. Novos campos ficam dentro de `acousticFeatures`, e `SYNTHESIS_VERSION=3` força o recálculo gradual.
