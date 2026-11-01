# Diagnóstico Forense, Auditoria Completa e Reparo Definitivo — NeuralTune 4.0

**Data da auditoria:** 31/10/2026  

---

## 1. Resumo Executivo (6 Bugs Encontrados e Corrigidos)

Além do defeito principal que fechava o modal ao clicar na aba **Rádios Personalizadas**, a auditoria profunda ponta a ponta revelou **5 outros bugs reais de integração e runtime** que afetavam rádios pré-configuradas, latência de início, fila do Spotify, descoberta de Deep Cuts e rádios de cluster:

1. **Bug 1 (Crítico — Fechamento da modal ao trocar de aba ou acionar botões):**
   - **Arquivo:** `src/ui/DashboardModal.ts` (`render`, `renderRatingsTab`, `renderBlacklistTab`)
   - **Causa raiz:** `container.replaceWith(newContent)` era executado dentro de `tabBtn.onclick = async () => ...` na retomada da microtask (antes do evento `click` borbulhar até `.GenericModal__overlay`). Quando o listener do `Spicetify.PopupModal` (`spicetifyWrapper.js:76`) avaliava `overlay.querySelector(".GenericModal").contains(event.target)`, o botão clicado já estava desconectado do DOM (`contains === false`), fechando o modal imediatamente.
   - **Correção:** `container` e `tabsNav` permanecem montados de forma persistente; apenas `.neuraltune-dashboard-body` é atualizado in-place com controle de sequência (`renderSeq`), e todos os botões interativos chamam `e?.stopPropagation?.()`.

2. **Bug 2 (Alto — Rádio Estudo e Rádios Pré-Configuradas falhando ou sem vetor acústico alvo):**
   - **Arquivo:** `src/index.ts` (`composeRadio`)
   - **Causa raiz:** `composeRadio` só relaxava filtros rígidos quando `parsed !== null` (rádios por texto), nunca para rádios pré-configuradas (`study`, `gym`, `work`, `relax`), e passava `target: undefined` para `EigenResonanceRanker` nas rádios pré-configuradas. Como o `/v1/audio-features` retorna HTTP 429 e `instrumentalness` sintetizada via `Spicetify.getAudioData` é descalibrada, a **Rádio Estudo** (`instrumentalOnly: true`) rejeitava quase toda a biblioteca.
   - **Correção:** Definidos vetores acústicos alvo (`PRESET_TARGET_PROMPTS`) para `gym`, `work`, `study` e `relax`, e ativado o relaxamento automático de filtros rígidos sempre que `predictions.length < MIN_HARMONIC_QUEUE` tanto em rádios pré-configuradas quanto em prompts.

3. **Bug 3 (Alto — Latência bloqueante de 15–25 segundos ao iniciar qualquer rádio):**
   - **Arquivo:** `src/index.ts` (`composeRadio`) e `src/radios/CandidateHarvester.ts` (`fetchRemote`)
   - **Causa raiz:** A cada clique em uma rádio, `composeRadio` aguardava de forma síncrona `features.ensure` para um lote grande de faixas e `features.ensureAnalyzed` para 30 faixas não analisadas da biblioteca com `200ms` de espaçamento + 30 chamadas `Spicetify.getAudioData` (~15–25s travado antes de tocar a 1ª música), além de `CandidateHarvester` buscar as playlists disponíveis de forma estritamente sequencial.
   - **Correção:** `CandidateHarvester` paralelizado em lotes de 5 playlists (`BATCH_CONCURRENCY = 5`). Em `composeRadio`, se já houver ao menos `MIN_HARMONIC_QUEUE` (5) faixas com dados harmônicos em cache, a análise adicional (`ensureAnalyzed`) roda de forma assíncrona em background, reduzindo o tempo de resposta das rádios para **65ms–177ms**.

4. **Bug 4 (Médio — Poluição e duplicação da fila do Spotify ao trocar de rádio ou clicar em faixa):**
   - **Arquivo:** `src/queue/SmartPlaybackEngine.ts` (`startPlayback`) e `src/index.ts` (`smartBridge.setQueue`)
   - **Causa raiz:** `SmartPlaybackEngine` usava apenas `addToQueue`, empilhando 15 novas faixas atrás das 15 faixas da rádio anterior na fila explícita do Spotify.
   - **Correção:** Implementado `setQueue` em `SmartPlaybackBridge`, que limpa as faixas enfileiradas anteriormente (`clearQueue` / `removeFromQueue`) antes de enfileirar a nova sequência.

5. **Bug 5 (Alto — Deep Cuts retornando 0 faixas nos primeiros segundos após abrir o Spotify ou após visitar página de artista):**
   - **Arquivo:** `src/index.ts` (`FALLBACK_GRAPHQL_DEFINITIONS`, `discoveryCrawler`) e `src/discovery/GraphqlDiscoveryBridge.ts` (`createGraphqlDiscoveryBridge`)
   - **Causa raiz:**
     - As operações GraphQL do Spotify (`getAlbumNameAndTracks`, `getArtistNameAndTracks`, `getTrackName`, `queryTrackArtists`, `queryArtistRelated`, `queryArtistDiscographyAlbums`) ficam em módulos Webpack preguiçosos (`xpui-modules.js` e `xpui-routes-artist.js`) que só populam `Spicetify.GraphQL.Definitions` quando determinadas rotas da interface são montadas.
     - Além disso, `createGraphqlDiscoveryBridge` não preservava `fetchAlbumDeepCuts` quando `queryArtistDiscographyAlbums` passava a existir.
   - **Correção:** Extraídos os descritores persistidos SHA-256 exatos do cliente (`FALLBACK_GRAPHQL_DEFINITIONS`) como fallback em `graphql()`, e preservados `fetchAlbumDeepCuts` e o fallback `createTopTracksDiscoveryBridge` em `createGraphqlDiscoveryBridge`.

6. **Bug 6 (Médio — Ausência de lista visual de faixas recomendadas e botão de Rádio de Cluster sem navegação):**
   - **Arquivo:** `src/ui/DashboardModal.ts` (`renderRadiosTab`, `renderPreferencesTab`)
   - **Correção:** Adicionada a seção `#nt-radio-results` na aba **Rádios Personalizadas** exibindo todas as faixas geradas com clique direto para tocar (`.nt-play-track`), botão de repetição (`#nt-radio-retry`) em caso de erro, e navegação automática do botão `.nt-cluster-radio` (na aba **Preferências Aprendidas**) para a aba **Rádios Personalizadas**.

---

## 2. Resultados dos Testes

### 2.1. Suíte Automatizada (Node.js Test Runner)
- **Comando:** `npm test`
- **Total:** **386 testes executados — 386 aprovados, 0 falhas** (`duration_ms: 5303ms`).
- **Novos testes adicionados em `tests/DashboardRadios.test.ts` (9 testes de integração):**
  1. Abertura da aba **Rádios Personalizadas** dentro da estrutura exata do `Spicetify.PopupModal` sem fechar o modal.
  2. Navegação repetida entre todas as 8 abas preservando o modal aberto.
  3. Fluxo ponta a ponta do **Deep Cuts** (filtragem de histórico e blacklist, renderização das faixas e clique para tocar faixa específica).
  4. Rádios pré-configuradas e rádio por prompt renderizando recomendações e iniciando reprodução.
  5. Tratamento de erro e lista vazia no Deep Cuts com botão `#nt-radio-retry`.
  6. `SmartPlaybackEngine.startPlayback` substituindo a fila anterior via `setQueue` sem duplicar faixas.
  7. `createGraphqlDiscoveryBridge` preservando `fetchAlbumDeepCuts` e fazendo fallback quando `queryAlbumTracks` está ausente.
  8. `CandidateHarvester` colhendo playlists em lotes paralelos e tolerando falha individual de playlist.
  9. Botão `.nt-cluster-radio` na aba **Preferências Aprendidas** gerando a rádio do cluster e navegando para **Rádios Personalizadas**.

### 2.2. Autoteste Ponta a Ponta no Cliente Spotify Real (`neuraltune:self-test-v6`)
Avaliação histórica registrada no Spotify Desktop com **658 avaliações reais** e um conjunto de faixas candidatas (`"allPassed": true`). Caminhos locais, identificadores da máquina e detalhes da conta foram removidos:

| Subsistema / Teste | Status no Spotify Real | Resultado / Métricas Reais | Latência Real |
| :--- | :--- | :--- | :--- |
| **8 Abas do Dashboard** (`explain`, `ratings`, `blacklist`, `radios`, `preferences`, `science`, `data`, `perf`) | `ok: true` | `modalClosedByClick: false` em todas as 8 abas | `21ms–35ms` (render) |
| **Rádio por Preferências** (`preference`) | `ok: true` | 30 faixas | `1465ms` (1º harvest) / `102ms` (cache) |
| **Rádio de Descoberta** (`discovery`) | `ok: true` | 30 faixas | `177ms` |
| **Rádio Academia** (`gym`) | `ok: true` | 30 faixas | `65ms` |
| **Rádio Trabalho** (`work`) | `ok: true` | 30 faixas | `138ms` |
| **Rádio Estudo** (`study`) | `ok: true` | 30 faixas | `169ms` |
| **Rádio Relax** (`relax`) | `ok: true` | 30 faixas | `139ms` |
| **Prompt:** `"foco noturno instrumental lento"` | `ok: true` | 30 faixas (`["instrumental","foco","andamento lento"]`) | `70ms` |
| **Prompt:** `"treino pesado anos 90/2000"` | `ok: true` | 30 faixas (`["energia alta","época 1990 a 2009"]`) | `153ms` |
| **Prompt:** `"músicas esquecidas sem repetir"` | `ok: true` | 30 faixas (`["sem repetição"]`) | `118ms` |
| **Rádio de Cluster** (`clusterRadio`) | `ok: true` | Clusters detectados, 30 faixas geradas | `138ms` |
| **Deep Cuts** (`findDiscoveries`) | `ok: true` | **30 faixas inéditas** (`30/30 com artistas`, `17 de álbuns`, `13 de top tracks`) | `7701ms` |
| **Autopilot** (`autopilot`) | `ok: true` | Piscina de faixas elegíveis, 3 faixas compostas | `115ms` |

---

## 3. Evolução: Modo 100% Inéditas (Zero Avaliadas ★ e Zero Curtidas ♥)

Para garantir que **nenhuma música já avaliada com estrelas (`0★` a `5★`)** e **nenhuma música já curtida (`♥`) no Spotify** jamais apareça nas recomendações das Rádios Personalizadas, Deep Cuts ou Autopilot:

1. **Escudo de Exclusão Multi-Camadas (`collectUnheardShield` em `src/index.ts` e `CandidateHarvester.ts`):**
   - Exclui **100% dos URIs com qualquer nota (`0★` a `5★`)** em `storage.getAllRatings()` (`ratedUris`).
   - Exclui **100% dos URIs curtidos (`♥`)** na biblioteca do Spotify via `LibraryAPI.getTracks` (`libraryUris`), `Spicetify.Player.getHeart()` e verificação em lote via `Spicetify.Platform.LibraryAPI.contains(...uris)`.
   - Exclui **versões duplicadas / remasters / edições deluxe / singles** de músicas já avaliadas ou curtidas por chave normalizada `título::artistaPrincipal` (`normalizeSongKey`).
   - Exclui músicas e artistas bloqueados (`BlacklistManager`).

2. **Motor Multi-Fonte de Candidatos Inéditos (`gatherUnheardCandidates` em `src/index.ts`):**
   - **Fonte 1:** Faixas das playlists do usuário que ainda não foram curtidas (`♥`) nem avaliadas com estrelas (`★`).
   - **Fonte 2:** Recomendações nativas do cliente Spotify via `Spicetify.Platform.PlaylistAPI.getRecommendedTracks(playlistUri, [], 25, { decorateWithBpmAndKey: true })`, já decoradas com BPM e tom Camelot reais sem sofrer HTTP 429.
   - **Fonte 3:** Descoberta autônoma GraphQL (`findDiscoveries`) varrendo faixas lado B de álbuns bem avaliados (`getAlbumNameAndTracks`), top tracks de artistas favoritos (`getArtistNameAndTracks`) e artistas relacionados (`queryArtistRelated`) com rotação de sementes (`discoverySeedRotation`).

3. **Melhorias na Interface de Rádios Personalizadas (`src/ui/DashboardModal.ts`):**
   - **Banner Escudo 100% Inéditas (`#nt-unheard-shield`):** Exibe em tempo real quantas músicas avaliadas (`★`), curtidas (`♥`) e bloqueadas (`🚫`) estão blindadas fora das recomendações.
   - **Chips de Prompt Rápido (`.nt-quick-prompt`):** 6 sugestões de 1 clique para gerar rádios por linguagem natural instantaneamente.
   - **Botão `🔄 Nova Seleção` (`#nt-radio-refresh`) e `💾 Exportar JSPF` (`#nt-radio-export-inline`):** Rotaciona as sementes de descoberta para gerar uma nova seleção inédita com 1 clique.
   - **Avaliação Rápida Inline (`🚫`, `4★`, `5★` — `.nt-rate-rec`) e Badges Acústicos (`BPM`, `Camelot`, `E:%`):** Permite avaliar ou bloquear qualquer faixa recomendada diretamente na lista; ao avaliar, a faixa é salva no modelo e removida imediatamente da lista de inéditas e da fila do Spotify (`evictRatedOrLikedFromPools`).

4. **Verificação no Spotify Real (`neuraltune:self-test-v8` — `388/388` testes unitários + E2E no cliente real):**
   - `harvestSources`: avaliações, biblioteca e playlists contribuíram para a coleta (contagens da conta omitidas).
   - `shieldCounts`: o escudo considerou avaliações, curtidas e bloqueios (contagens da conta omitidas).
   - Todas as **6 rádios pré-configuradas**, **3 rádios por prompt**, **rádio de cluster**, **Deep Cuts** (`30 faixas`, `20 de álbuns`, `10 de top tracks`) e **Autopilot** passaram com `ratedLeaks: 0`, `likedLeaks: 0` e `"allPassed": true`.
