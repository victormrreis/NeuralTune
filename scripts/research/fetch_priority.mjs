// Retrieves abstract and open-access status of the priority references from Europe PMC.
// Third-party text is not stored in metadata. Source availability is checked afresh.
// Usage: node scripts/research/fetch_priority.mjs <fulltextDir>
import fs from 'node:fs';
import path from 'node:path';

export const PRIORITY_40 = [
  59, 75, 60, 61, 54, 69, 66, 104, 100, 76, 116, 63, 43, 58, 77, 80, 107, 120, 32, 35, 22, 25, 29, 56, 62, 21,
  3, 6, 14, 41, 68, 81, 82, 70, 96,
  164, 220, 269, 273, 139
].map((n) => `NT-${String(n).padStart(3, '0')}`);

export const TOP_20 = [59, 75, 60, 61, 100, 76, 63, 43, 54, 107, 120, 3, 41, 81, 82, 68, 164, 269, 273, 139]
  .map((n) => `NT-${String(n).padStart(3, '0')}`);

const fullTextDir = process.argv[2];
const inventory = JSON.parse(fs.readFileSync('docs/research/data/catalog_inventory.json', 'utf8'));
const previous = JSON.parse(fs.readFileSync('docs/research/data/priority_sources.json', 'utf8'));
const out = {};
if (fullTextDir) fs.mkdirSync(fullTextDir, { recursive: true });

function strip(text) {
  return (text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

for (const id of PRIORITY_40) {
  const record = inventory.find((r) => r.id === id);
  const entry = { id, title: record.title, year: record.year, doi: record.doi, authors: record.authors.slice(0, 6), status: 'METADATA_ONLY' };

  if (previous[id]?.editorialSummary) entry.editorialSummary = previous[id].editorialSummary;
  try {
    const query = record.doi ? `DOI:"${record.doi}"` : `TITLE:"${record.title}"`;
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&resultType=core&format=json&pageSize=1`;
    const hit = (await (await fetch(url)).json()).resultList?.result?.[0];

    if (hit) {
      entry.hasAbstract = !!strip(hit.abstractText);
      entry.journal = hit.journalInfo?.journal?.title ?? null;
      entry.pmcid = hit.pmcid ?? null;
      entry.openAccess = hit.isOpenAccess === 'Y';
      entry.pubType = hit.pubTypeList?.pubType ?? [];
      if (entry.hasAbstract) entry.status = 'ABSTRACT_ONLY';

      if (hit.pmcid && hit.isOpenAccess === 'Y' && hit.inEPMC === 'Y' && fullTextDir) {
        const xml = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/${hit.pmcid}/fullTextXML`);
        if (xml.ok) {
          fs.writeFileSync(path.join(fullTextDir, `${id}.xml`), await xml.text());
          entry.status = 'FULL_TEXT';
        }
      }
    }
  } catch (err) {
    entry.error = String(err).slice(0, 100);
  }

  if (entry.status !== 'FULL_TEXT' && !entry.hasAbstract && record.doi) {
    // Fetch availability again instead of depending on copyrighted cache text.
    try {
      const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(record.doi)}`);
      if (response.ok) {
        const { message } = await response.json();
        entry.hasAbstract = !!strip(message?.abstract);
        if (entry.hasAbstract) entry.status = 'ABSTRACT_ONLY';
      }
    } catch {
      // Metadata remains usable when a source is temporarily unavailable.
    }
  }

  out[id] = entry;
  await new Promise((resolve) => setTimeout(resolve, 150));
}

fs.writeFileSync('docs/research/data/priority_sources.json', JSON.stringify(out, null, 1));
const counts = Object.values(out).reduce((m, e) => { m[e.status] = (m[e.status] ?? 0) + 1; return m; }, {});
console.log(counts);
for (const e of Object.values(out)) console.log(e.id, e.status.padEnd(14), (e.title ?? '').slice(0, 72));
