// Parses the scientific catalog, verifies every DOI on Crossref and classifies records by research axis.
// Usage: node scripts/research/audit_catalog.mjs <catalog.txt>
// Output: docs/research/data/catalog_inventory.json. Crossref responses are cached, so reruns are offline.
import fs from 'node:fs';
import path from 'node:path';

const catalogPath = process.argv[2];
const outDir = path.resolve('docs/research/data');
const cachePath = path.join(outDir, 'crossref_cache.json');
fs.mkdirSync(outDir, { recursive: true });

const AXES = {
  A: /auditory|audition|hearing|sound|acoustic|timbre|pitch|cochlea|speech envelope|melod/i,
  B: /predict|expectation|expectanc|surprise|prediction error|mismatch|forward model/i,
  C: /plasticity|hebbian|stdp|learning rule|habituation|reward|reinforcement|adaptation/i,
  D: /synchron|entrain|oscillat|kuramoto|rhythm|beat|phase.?lock|phase.?amplitude|coupl/i,
  E: /entropy|information theor|mutual information|transfer entropy|complexity|predictab/i,
  F: /hodgkin|integrate.and.fire|spiking|recurrent|neural mass|attractor|mean.field|population dynamics|dynamical system|wilson|cowan/i,
  G: /music|emotion|pleasure|groove|familiar|novelty|musical/i,
  H: /bayes|inference|latent|hidden markov|state.?space|connectivity|granger|dynamic causal|graph/i
};

const MUSIC = /music|melod|rhythm|beat|groove|tonal|harmon|song|meter\b|tempo/i;
const MATH = /model|dynamic|theor|algorithm|equation|bayes|entropy|markov|kuramoto|oscillator|statistic|information/i;

function parseCatalog(text) {
  const records = [];
  let section = null;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^Publicações: \d+/.test(line)) section = lines[i - 1].trim();

    const entry = /^(\d{3})\. (\[MAT\] )?(.+)$/.exec(line);
    if (!entry) continue;

    const meta = /Ano:\s*([^|]*)\|\s*Tipo:\s*(.+)$/.exec(lines[i + 1] ?? '');
    const link = /Link:\s*(\S*)/.exec(lines[i + 2] ?? '');
    const url = link?.[1] ?? '';
    const doi = /doi\.org\/(.+)$/i.exec(url)?.[1] ?? null;

    records.push({
      id: `NT-${entry[1]}`,
      title: entry[3].trim(),
      catalogMath: !!entry[2],
      year: Number.parseInt(meta?.[1] ?? '', 10) || null,
      catalogType: meta?.[2]?.trim() ?? null,
      url,
      doi,
      section
    });
  }
  return records;
}

function normalizeTitle(title) {
  return title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function words(title) {
  return new Set(normalizeTitle(title).split(' ').filter((w) => w.length > 3));
}

function titleSimilarity(a, b) {
  const [x, y] = [words(a), words(b)];
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared++;
  return shared / Math.min(x.size, y.size);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function crossref(doi) {
  const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=neuraltune-audit@example.invalid`, {
    headers: { 'User-Agent': 'NeuralTune-catalog-audit/1.0' }
  });
  if (response.status === 404) return { status: 'NOT_FOUND' };
  if (!response.ok) return { status: `HTTP_${response.status}` };

  const { message: m } = await response.json();
  return {
    status: 'FOUND',
    title: m.title?.[0] ?? null,
    authors: (m.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean),
    year: m.issued?.['date-parts']?.[0]?.[0] ?? null,
    type: m.type ?? null,
    container: m['container-title']?.[0] ?? null,
    hasAbstract: !!m.abstract,
    license: (m.license ?? []).map((l) => l.URL)
  };
}

const text = fs.readFileSync(catalogPath, 'utf8');
const records = parseCatalog(text);
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};

// Do not persist legacy third-party abstracts, including on an offline rerun.
for (const entry of Object.values(cache)) delete entry.abstract;

const pending = records.filter((r) => r.doi && !(cache[r.doi]?.status === 'FOUND' || cache[r.doi]?.status === 'NOT_FOUND'));
console.log(`registros=${records.length} comDOI=${records.filter((r) => r.doi).length} aConsultar=${pending.length}`);

let index = 0;
async function worker() {
  while (index < pending.length) {
    const record = pending[index++];
    try {
      cache[record.doi] = await crossref(record.doi);
    } catch (err) {
      cache[record.doi] = { status: 'NETWORK_ERROR', detail: String(err).slice(0, 120) };
    }
    if (index % 50 === 0) {
      fs.writeFileSync(cachePath, JSON.stringify(cache));
      console.log(`  ${index}/${pending.length}`);
    }
    await sleep(120);
  }
}
await Promise.all([worker(), worker(), worker()]);
fs.writeFileSync(cachePath, JSON.stringify(cache));

const seen = new Map();
for (const record of records) {
  const found = record.doi ? cache[record.doi] : null;
  const axes = Object.entries(AXES).filter(([, pattern]) => pattern.test(record.title)).map(([axis]) => axis);

  const key = normalizeTitle(record.title);
  record.duplicateOf = seen.get(key) ?? null;
  if (!seen.has(key)) seen.set(key, record.id);

  let verification = 'NO_DOI';
  if (found?.status === 'FOUND') {
    const match = titleSimilarity(record.title, found.title ?? '');
    verification = match >= 0.6 ? 'VERIFIED' : 'TITLE_MISMATCH';
    record.crossrefTitle = found.title;
    record.titleMatch = Math.round(match * 100) / 100;
    record.yearMismatch = record.year && found.year && Math.abs(record.year - found.year) > 1 ? found.year : null;
  } else if (found) {
    verification = found.status;
  }

  const crossrefType = found?.type ?? null;
  const publicationType = !crossrefType ? 'UNKNOWN'
    : crossrefType === 'posted-content' ? 'PREPRINT'
    : crossrefType === 'proceedings-article' ? 'CONFERENCE'
    : crossrefType === 'journal-article' ? (/review|survey|tutorial/i.test(record.title) ? 'REVIEW' : 'JOURNAL')
    : crossrefType.startsWith('book') ? 'BOOK_OR_CHAPTER'
    : 'OTHER';

  record.verification = verification;
  record.authors = found?.authors ?? [];
  record.publicationType = publicationType;
  record.container = found?.container ?? null;
  record.textAvailability = found?.hasAbstract ? 'ABSTRACT_ONLY' : 'METADATA_ONLY';
  record.axes = axes;
  record.music = MUSIC.test(record.title);
  record.mathInTitle = MATH.test(record.title) || record.catalogMath;
  record.relevance = axes.length + (record.music ? 3 : 0) + (record.mathInTitle ? 1 : 0)
    + (record.section?.startsWith('SELEÇÃO') ? 2 : 0) + (record.section?.startsWith('MÚSICA') ? 2 : 0)
    + (verification === 'VERIFIED' ? 1 : 0);
}

fs.writeFileSync(path.join(outDir, 'catalog_inventory.json'), JSON.stringify(records, null, 1));

const count = (fn) => records.reduce((map, r) => { const k = fn(r); map[k] = (map[k] ?? 0) + 1; return map; }, {});
console.log('verificacao', count((r) => r.verification));
console.log('tipo', count((r) => r.publicationType));
console.log('texto', count((r) => r.textAvailability));
console.log('duplicatas', records.filter((r) => r.duplicateOf).length, 'semMusica', records.filter((r) => !r.music).length);
console.log('eixos', Object.fromEntries(Object.keys(AXES).map((a) => [a, records.filter((r) => r.axes.includes(a)).length])));
console.log('divergenciaAno', records.filter((r) => r.yearMismatch).length);
