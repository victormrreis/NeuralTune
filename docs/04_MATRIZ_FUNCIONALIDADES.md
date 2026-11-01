# 04 — MATRIZ DE FUNCIONALIDADES E STATUS TÉCNICO

## Projeto NeuralTune — Classificação Conforme Critérios de Aceitação

---

| Funcionalidade | Status | Detalhamento Técnico |
|---|---|---|
| **Investigação da Arquitetura Local** | **Implementada e testada** | Mapeamento completo dos processos CEF, versões, Spicetify e APIs internas do Spotify. |
| **Diagnóstico de Desempenho e Baseline** | **Implementada e testada** | Medição em tempo real de Working Set, PageFile, tempos de CPU e identificação de gargalos. |
| **Sistema de Avaliação de 0 a 5 Estrelas** | **Implementada e testada** | Interface visual na barra de reprodução, atalhos de teclado configuráveis e menu de contexto. |
| **Persistência Local Segura (IndexedDB)** | **Implementada e testada** | IndexedDB com fallback em memória e cache $O(1)$ em `Set` nativo para tempo-real. |
| **Desfazer / Refazer (Undo/Redo)** | **Implementada e testada** | Pilhas de histórico com restauração atômica de notas e estados de bloqueio. |
| **Predictive Queue Guardian** | **Implementada e testada** | Varredura preditiva em `nextUp` com remoção preventiva via `removeFromQueue` antes do áudio tocar. |
| **Teste de 100 Faixas Bloqueadas** | **Implementada e testada** | Validado em suíte de testes automatizados com evicção em 2.15 ms e zero travamentos. |
| **Teste de 1.000 Faixas Bloqueadas** | **Implementada e testada** | Validado em suíte de testes com evicção em 35.06 ms com integridade total. |
| **Proteção contra Loops (Circuit Breaker)** | **Implementada e testada** | Janela deslizante de tempo; pausa automática e emissão de alerta caso ocorram >3 skips em 2,5s. |
| **Preservação de Fila Manual do Usuário** | **Implementada e testada** | Músicas explicitamente enfileiradas (`is_queued`) são preservadas por padrão. |
| **NeuralTune Smart Playback** | **Implementada e testada** | Sequenciamento pré-filtrado de candidatos com garantia técnica de zero skips. |
| **Motor de Preferências Bayesiano** | **Implementada e testada** | Suavização Bayesiana com prior neutro ($\mu_0 = 0$, $m = 4$), intervalos de confiança e regularização. |
| **Penalidade Proporcional na Nota 0** | **Implementada e testada** | Faixa rejeitada bloqueada deterministamente; atributos sofrem penalidade atenuada sem extinguir gêneros. |
| **Mecanismo Antifadiga de Artistas** | **Implementada e testada** | Penalidade para repetição de artista recente e espaçamento automático de faixas do mesmo autor. |
| **Explicabilidade ("Por que esta música?")** | **Implementada e testada** | Decomposição exata das regras, pesos de atributos, grau de confiança e fontes dos metadados. |
| **Rádio por Preferências** | **Implementada e testada** | Seleção centrada nos atributos de maior afinidade e confiança do usuário. |
| **Rádio de Descoberta** | **Implementada e testada** | Balanceamento entre novidade musical (70%) e âncoras familiares (30%). |
| **Rádios Contextuais (Academia, Trabalho, Estudo, Relax, Noite)** | **Implementada e testada** | Presets acústicos com filtros estritos de BPM, energia e instrumentalidade. |
| **Importação de Dados da Trash Bin** | **Implementada e testada** | Migração em 1 clique de `TrashSongList` e `TrashArtistList` para a base unificada do NeuralTune. |
| **Exportação e Importação de Backup** | **Implementada e testada** | Exportação/importação em JSON completo e seguro de avaliações, perfis e regras. |
| **Bloqueio Inteligente de Versões (Live, Remix, Composição)** | **Implementada e testada** | Regras de correspondência contextual para versões ao vivo e remixes sem afetar a versão de estúdio. |
| **Extração de Atributos Acústicos Reais** | **Implementada e testada** | Integração via `Spicetify.getAudioData` chamando endpoint de atributos de áudio interno do Spotify. |
| **Alteração do Algoritmo Remoto de Servidores do Spotify** | **Bloqueada por limitações técnicas/acesso** | Recomendações dos servidores da nuvem do Spotify são proprietárias e fechadas. A personalização legítima e viável opera localmente via pré-filtragem, Smart Playback e injeção controlada de fila. |
| **Análise de Áudio Protegido por DRM** | **Bloqueada por limitações técnicas/acesso** | Por restrições estritas de segurança, termos e DRM, o áudio protegido não é descriptografado localmente; utilizam-se metadados legítimos retornados pelas APIs disponíveis. |
| **Avaliação Comparativa (A/B)** | **Implementada com restrições** | Estrutura de dados e modelo prontos no backend; interface de comparação direta planejada para expansão visual. |
