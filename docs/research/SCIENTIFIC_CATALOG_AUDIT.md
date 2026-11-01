# Auditoria do catálogo científico

Gerado por `scripts/research/audit_catalog.mjs` e `generate_catalog_audit.mjs`. Dados completos em `docs/research/data/catalog_inventory.json`, com os 600 registros e todas as propriedades pedidas.

## Contagens

- Registros extraídos: **600** (o catálogo declara 600).
- Duplicatas por título normalizado: **0**.
- Com DOI: **563**; sem DOI: **37**.

| Verificação no Crossref | Registros |
|---|---|
| VERIFIED | 554 |
| NO_DOI | 37 |
| TITLE_MISMATCH | 3 |
| NOT_FOUND | 6 |

| Tipo de publicação | Registros |
|---|---|
| JOURNAL | 523 |
| REVIEW | 11 |
| OTHER | 1 |
| UNKNOWN | 43 |
| CONFERENCE | 13 |
| PREPRINT | 6 |
| BOOK_OR_CHAPTER | 3 |

`REVIEW` é inferido do título. `UNKNOWN` são registros sem metadados no Crossref.

| Acesso ao texto (todos os 600) | Registros |
|---|---|
| METADATA_ONLY | 434 |
| ABSTRACT_ONLY | 166 |

O catálogo inteiro passou por verificação de **metadados**. Isso não significa leitura: só as 40 prioritárias tiveram busca de texto. O título indica relação direta com música em 123 registros; os outros 477 tratam de EEG, conectividade ou métodos, sem entrada viável no NeuralTune sem sensores.

## Classificação por eixo

Feita por palavras-chave no título. É triagem, não avaliação de conteúdo.

| Eixo | Registros |
|---|---|
| A | 46 |
| B | 47 |
| C | 34 |
| D | 41 |
| E | 10 |
| F | 51 |
| G | 81 |
| H | 51 |

## Problemas encontrados

| ID | Problema | Título no catálogo | Crossref |
| --- | --- | --- | --- |
| NT-064 | TITLE_MISMATCH | Developing an efficient test of musical imagery ability: Applying mode | An efficient and adaptive test of auditory mental imagery |
| NT-112 | NOT_FOUND | Melodic pitch expectation interacts with neural responses to syntactic | não encontrado |
| NT-136 | NOT_FOUND | How to Knit Your Own Markov Blanket: | não encontrado |
| NT-237 | NOT_FOUND | Adam: A method for stochastic optimization | não encontrado |
| NT-240 | NOT_FOUND | Event-driven eligibility propagation in large sparse networks: efficie | não encontrado |
| NT-302 | NOT_FOUND | S-JEPA: towards seamless cross-dataset transfer through dynamic spatia | não encontrado |
| NT-499 | TITLE_MISMATCH | LOF: Identifying Density-Based Local Outliers | LOF |
| NT-501 | TITLE_MISMATCH | SzCORE: seizure community open-source research evaluation framework fo | A real‐world comparison among third‐generation antiseizure m |
| NT-502 | NOT_FOUND | CHB-MIT Scalp EEG Database | não encontrado |

NT-501 é o único caso sério: o DOI aponta para outro artigo. NT-112 tem um ponto final a mais no DOI. Em NT-237, NT-240 e similares o DOI existe, mas não é registrado no Crossref. Nenhum destes é usado no motor.

## Seleção

Prioridade por evidência musical direta, matemática reproduzível e aplicabilidade. Lista em `NEURALTUNE_SCIENTIFIC_FOUNDATIONS.md`.

| Acesso às 40 prioritárias | Referências |
|---|---|
| FULL_TEXT | 14 |
| ABSTRACT_ONLY | 20 |
| METADATA_ONLY | 6 |

`FULL_TEXT` significa texto obtido do Europe PMC em acesso aberto. Dele foram lidos trechos dirigidos, não o artigo inteiro, em especial NT-059, NT-003, NT-041, NT-081 e NT-068. Textos não são versionados aqui.
