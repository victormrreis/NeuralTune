# Comparação com projetos de referência

Verificado em 31/10/2026 pela API do GitHub. "Lido" significa o README: o código dos repositórios não foi auditado. Nada foi copiado de nenhum deles.

| Repositório | Existe | Licença | O que o README confirma | Situação no NeuralTune |
|---|---|---|---|---|
| `deezer/recsys25-reacta` | Sim | Sem SPDX | Áudio e memória humana em recomendação sequencial | Ideia próxima de `CognitiveMemoryModel`, sem reuso de código |
| `deezer/recsys24-pisa` | Sim | Sem SPDX | Transformers com ACT-R para sessões, com repetição | ACT-R usado em forma mínima; transformer inviável: exige sessões em volume |
| `deezer/interpretable_nn_attribution` | Sim | Nenhuma | Atribuição para redes de sinais implícitos | Não aplicado: aqui a decomposição é aditiva por construção |
| `deezer/consistency` | Sim | Nenhuma | Consistência de embeddings médios | Não aplicado |
| `deezer/spiky_svd` | Sim | Nenhuma | SVDs com picos em recomendação musical | Sem aplicação: exige matriz de muitos usuários |
| `deezer/similar_artists_ranking` | Sim | Nenhuma | Ranqueamento de artistas no cold start com graph autoencoders gravitacionais | Inviável: exige grafo de artistas de catálogo inteiro |
| `Polochon-street/bliss-rs` | Sim | GPL-3.0 | Biblioteca de análise de músicas para playlists | Descrição apenas. GPL: não copiar; extensão não tem PCM |
| `spotify-research/cosernn` | Sim | Apache-2.0 | Embeddings contextuais e sequenciais de usuário | Requer dados de escala industrial. Compatível em licença, mas sem dados |
| `meta-recsys/generative-recommenders` | Sim | Apache-2.0 | Descrição cita sequências em escala de trilhões | Inviável localmente |
| `metabrainz/troi-recommendation-playground` | Sim | GPL-2.0 | Playground de recomendação | JSPF segue o padrão público, sem usar o código |

Repositórios sem licença declarada não concedem direito de reuso. Implementações próprias partem de ideias publicadas nos artigos.

## Reprodutível, adaptável, inviável

**Reproduzido a partir de publicação:** calibração de Steck (2018), PPM com decaimento, ACT-R em forma mínima, DPP guloso, propagação em grafo.

**Com adaptação:** repetição na linha do PISA, reduzida a ativação por faixa; sessão contextual, reduzida a termos aditivos.

**Inviável aqui:** qualquer método que dependa de dados de muitos usuários. O NeuralTune tem um usuário e centenas de notas, então fatoração colaborativa, grafos de catálogo e transformers não têm sinal para aprender.

## Diferença estrutural

Sistemas industriais aprendem com bilhões de interações e têm logs de exposição. O NeuralTune tem uma pessoa, sem esse log. Por isso a arquitetura foi aprimorada de forma incremental: termos pequenos, interpretáveis e desligáveis, em vez de um modelo que os dados não sustentariam.
