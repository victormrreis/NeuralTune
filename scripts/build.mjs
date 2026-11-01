import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('../', import.meta.url));

const banner = `// NAME: NeuralTune
// AUTHOR: Victor Martins
// DESCRIPTION: Sistema Avançado de Personalização Musical, Filtragem Preditiva e Otimização Profunda do Spotify
// VERSION: 4.0.0
`;

async function build() {
  console.log('[NeuralTune] Iniciando compilação do bundle Spicetify...');

  const distDir = path.join(projectDir, 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const result = await esbuild.build({
    absWorkingDir: projectDir,
    entryPoints: [path.join(projectDir, 'src/index.ts')],
    bundle: true,
    outfile: path.join(distDir, 'neuraltune.js'),
    format: 'iife',
    platform: 'browser',
    target: ['chrome90'],
    banner: { js: banner },
    sourcemap: false,
    minify: false, // Keep readable for inspection & debugging
    legalComments: 'inline'
  });

  const stats = fs.statSync(path.join(distDir, 'neuraltune.js'));
  console.log(`[NeuralTune] Bundle gerado com sucesso em dist/neuraltune.js (${Math.round(stats.size / 1024)} KB)`);
}

build().catch((err) => {
  console.error('[NeuralTune] Falha no build:', err);
  process.exit(1);
});
