// Generates SCIENTIFIC_CATALOG_AUDIT.md and NEURALTUNE_SCIENTIFIC_FOUNDATIONS.md from the audited data.
// Editorial summaries are original paraphrases; source text is not reproduced.
import fs from 'node:fs';

const inventory = JSON.parse(fs.readFileSync('docs/research/data/catalog_inventory.json', 'utf8'));
const priority = JSON.parse(fs.readFileSync('docs/research/data/priority_sources.json', 'utf8'));

const TOP_20 = [59, 75, 60, 61, 100, 76, 63, 43, 54, 107, 120, 3, 41, 81, 82, 68, 164, 269, 273, 139]
  .map((n) => `NT-${String(n).padStart(3, '0')}`);

const count = (fn) => inventory.reduce((map, r) => { const k = fn(r); map[k] = (map[k] ?? 0) + 1; return map; }, {});
const table = (rows) => rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
const pipe = (text) => String(text ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ');

const USE = {
  'NT-059': ['DecayedPpm: kernel w(t) e PPM método A', 'Sequências de classes de altura, IOI e brilho derivadas de segments[]', 'Comparar NDCG com e sem o termo de informação nas notas reais (ablação em execução no cliente)', 'Eventos não são notas; decaimento medido em segundos da faixa, não em memória do ouvinte'],
  'NT-075': ['Motivação do aprendizado estatístico por sequência', 'segments[].pitches', 'Mesmo experimento de NT-059', 'Revisão sobre enculturação; o motor mede só a faixa isolada'],
  'NT-060': ['Termos S, H e S×H do modelo de preferência', 'Surpresa e incerteza por faixa + notas', 'Ajuste individual com n ≥ 30 e teste fora da amostra', 'Resultado de acordes em laboratório; aqui é média por faixa'],
  'NT-061': ['Termos quadráticos S² e H²', 'Surpresa e incerteza por faixa + notas', 'Verificar sinal e ganho no usuário real', 'Estímulos e participantes diferentes; o sinal é aprendido, não assumido'],
  'NT-100': ['Definição de incerteza como entropia preditiva', 'Distribuição do PPM', 'Propriedades em tests/Neuroscience.test.ts', 'Sequências auditivas de laboratório'],
  'NT-003': ['Revisão que situa Kuramoto como hipótese', 'beats[], segments[]', 'AUC de grooves: Kuramoto 0,51 contra padrão 1,00', 'Modelos descrevem percepção, não compatibilidade entre faixas'],
  'NT-041': ['Mostra que modelagem rítmica bayesiana é alternativa a osciladores', 'beats[]', 'Não implementado (pPIPPET exige padrões de entrada que o cliente não dá)', 'Exigiria adaptação profunda'],
  'NT-273': ['Regras limitadas: pesos com soft bounds', 'Notas e reproduções', 'Propriedade de limitação em tests/Neuroscience.test.ts', 'Sinapses; usado só como argumento de estabilidade'],
  'NT-164': ['Necessidade de estabilização: decaimento e limites', 'Notas e reproduções', 'Ablação da plasticidade', 'Sinapses; sem correspondência fisiológica'],
  'NT-043': ['Atenção a fronteiras na morfologia', 'segments[] e sections', 'Custo de emenda com e sem morfologia', 'Motivação indireta']
};

const axes = 'ABCDEFGH'.split('');
const audit = `# Auditoria do catálogo científico

Gerado por \`scripts/research/audit_catalog.mjs\` e \`generate_catalog_audit.mjs\`. Dados completos em \`docs/research/data/catalog_inventory.json\`, com os 600 registros e todas as propriedades pedidas.

## Contagens

- Registros extraídos: **${inventory.length}** (o catálogo declara 600).
- Duplicatas por título normalizado: **${inventory.filter((r) => r.duplicateOf).length}**.
- Com DOI: **${inventory.filter((r) => r.doi).length}**; sem DOI: **${inventory.filter((r) => !r.doi).length}**.

| Verificação no Crossref | Registros |
|---|---|
${table(Object.entries(count((r) => r.verification)).map(([k, v]) => [k, v]))}

| Tipo de publicação | Registros |
|---|---|
${table(Object.entries(count((r) => r.publicationType)).map(([k, v]) => [k, v]))}

\`REVIEW\` é inferido do título. \`UNKNOWN\` são registros sem metadados no Crossref.

| Acesso ao texto (todos os 600) | Registros |
|---|---|
${table(Object.entries(count((r) => r.textAvailability)).map(([k, v]) => [k, v]))}

O catálogo inteiro passou por verificação de **metadados**. Isso não significa leitura: só as 40 prioritárias tiveram busca de texto. O título indica relação direta com música em ${inventory.filter((r) => r.music).length} registros; os outros ${inventory.filter((r) => !r.music).length} tratam de EEG, conectividade ou métodos, sem entrada viável no NeuralTune sem sensores.

## Classificação por eixo

Feita por palavras-chave no título. É triagem, não avaliação de conteúdo.

| Eixo | Registros |
|---|---|
${table(axes.map((a) => [a, inventory.filter((r) => r.axes.includes(a)).length]))}

## Problemas encontrados

${table([['ID', 'Problema', 'Título no catálogo', 'Crossref'], ['---', '---', '---', '---'],
  ...inventory.filter((r) => ['TITLE_MISMATCH', 'NOT_FOUND'].includes(r.verification)).map((r) => [r.id, r.verification, pipe(r.title).slice(0, 70), pipe(r.crossrefTitle ?? 'não encontrado').slice(0, 60)])])}

NT-501 é o único caso sério: o DOI aponta para outro artigo. NT-112 tem um ponto final a mais no DOI. Em NT-237, NT-240 e similares o DOI existe, mas não é registrado no Crossref. Nenhum destes é usado no motor.

## Seleção

Prioridade por evidência musical direta, matemática reproduzível e aplicabilidade. Lista em \`NEURALTUNE_SCIENTIFIC_FOUNDATIONS.md\`.

| Acesso às 40 prioritárias | Referências |
|---|---|
${table(Object.entries(Object.values(priority).reduce((m, e) => { m[e.status] = (m[e.status] ?? 0) + 1; return m; }, {})).map(([k, v]) => [k, v]))}

\`FULL_TEXT\` significa texto obtido do Europe PMC em acesso aberto. Dele foram lidos trechos dirigidos, não o artigo inteiro, em especial NT-059, NT-003, NT-041, NT-081 e NT-068. Textos não são versionados aqui.
`;

const entry = (e) => {
  const use = USE[e.id];
  const summary = e.editorialSummary ?? null;
  return `### ${e.id}. ${e.title}

- **Referência:** ${e.authors.join(', ')}${e.authors.length === 6 ? ' et al.' : ''} (${e.year}). ${e.journal ?? ''} ${e.doi ? `https://doi.org/${e.doi}` : ''}
- **Acesso:** \`${e.status}\`${TOP_20.includes(e.id) ? ' · entre as 20 com maior potencial' : ''}
- **Síntese editorial (paráfrase):** ${summary ?? 'indisponível: método, dados e resultados não foram acessados e não são descritos aqui.'}
- **Aplicação real no software:** ${use?.[0] ?? 'nenhuma nesta versão.'}
- **Dados do NeuralTune:** ${use?.[1] ?? 'não avaliado.'}
- **Experimento para demonstrar benefício:** ${use?.[2] ?? 'não definido.'}
- **Adaptação e limite:** ${use?.[3] ?? 'não avaliado.'}
`;
};

const foundations = `# Fundamentos científicos do NeuralTune

**Inspiração biológica não é validação biológica.** Nada no NeuralTune mede cérebro, emoção ou fisiologia. O sistema infere preferências a partir de notas, reproduções e análise de áudio.

## Como ler

As sínteses editoriais são paráfrases breves dos resumos consultados; não reproduzem os textos dos artigos. As referências identificam as fontes originais. Os itens de aplicação são análise própria. Onde a fonte não foi acessada, não inferimos seus resultados pelo título.

Tratamento completo dos 11 itens exigiria leitura integral das 40 referências. Isso **não foi feito**: há ${Object.values(priority).filter((e) => e.status === 'FULL_TEXT').length} textos disponíveis, lidos por trechos, e o restante é resumo ou só metadados.

## Principais conclusões para o software

- **PPM-Decay (NT-059)** é a referência de maior aproveitamento: dá kernel exato e método reproduzível.
- **NT-060 e NT-061** dão a forma do modelo (interação e termos quadráticos), mas são resultados populacionais em estímulos controlados. O motor aprende o sinal de cada usuário.
- **Kuramoto** aparece em NT-003 e NT-041 como hipótese entre outras. No experimento interno não acrescentou nada à diferença de tempo.
- **Plasticidade (NT-164, NT-273)** é sináptica. Daqui saem apenas limites e decaimento, propriedades que se justificam também sem biologia.
- **Sem uso possível:** a maior parte da seção de decodificação EEG, conectividade e aquisição de sinais exige sensores que o NeuralTune não tem e não vai pedir.

## Referências prioritárias

${Object.values(priority).map(entry).join('\n')}
`;

fs.writeFileSync('docs/research/SCIENTIFIC_CATALOG_AUDIT.md', audit);
fs.writeFileSync('docs/research/NEURALTUNE_SCIENTIFIC_FOUNDATIONS.md', foundations);
console.log('gerado', audit.length, foundations.length);
