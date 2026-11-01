# NeuralTune

Extensão em TypeScript para recomendação musical local no Spotify Desktop via Spicetify. Oferece avaliações de 0 a 5 estrelas, bloqueios, rádios personalizadas, histórico local e explicações das recomendações.

## Requisitos

- Spotify Desktop com Spicetify instalado e configurado.
- Node.js 24 e npm (a suíte usa `--experimental-strip-types`).
- Windows para os scripts PowerShell de instalação e restauração.

## Preparar, testar e compilar

Na raiz do projeto:

```powershell
npm ci
npm test
npm run build
```

O build gera `dist/neuraltune.js`. `dist/` e `node_modules/` não são versionados.

## Instalar no Spotify

Depois de compilar e revisar o código, execute manualmente:

```powershell
npm run install:spicetify
```

**Atenção:** esse comando copia a extensão, salva um backup da configuração do Spicetify e executa `spicetify apply`, que pode reiniciar o Spotify. Não faz parte dos testes nem do build.

Para desativar a extensão e restaurar o backup da configuração, quando disponível:

```powershell
npm run restore:backup
```

A restauração também executa `spicetify apply`. O backup de configuração não substitui um backup das notas.

## Uso

Avalie pela barra do player ou por `Ctrl + Alt + 0` a `5`. `0★` bloqueia a faixa; `Ctrl + Alt + Z` desfaz e `Ctrl + Alt + M` abre o painel. As rádios combinam preferências, regras de bloqueio e espaçamento de artistas. Consulte o manual em `docs/02_MANUAL_DO_USUARIO.md`.

## Privacidade

As notas e o histórico são armazenados localmente, no computador do usuário. Exportações e backups podem conter informações pessoais: mantenha-os fora do Git e revise-os antes de compartilhar. A extensão usa as interfaces do Spotify para consultar metadados e controlar a reprodução; isso não significa operação totalmente offline. Recursos opcionais de criação/sincronização de playlists gravam playlists na conta Spotify quando acionados.

## Evidências e limitações

- A suíte de referência tem 613 testes; testes de tempo podem variar conforme a carga da máquina.
- O resultado vigente documentado é **NDCG@10 de 0,649**, contra **0,438 ao acaso**, medido nas notas de **uma pessoa**. Não é uma avaliação representativa de todos os usuários nem uma promessa de desempenho.
- Recursos de interface foram validados no Chromium com stubs; isso não comprova compatibilidade completa com todas as versões do Spotify Desktop.
- O importador de histórico foi testado com arquivos sintéticos, não com todos os formatos reais possíveis.
- Mudanças nas interfaces do Spotify/Spicetify, limites de API e metadados ausentes podem afetar os recursos. Não há garantia de zero skips.
- Relatórios históricos em `docs/research/` preservam medições anteriores e números agregados da conta usada na avaliação. Consulte `docs/research/NEURALTUNE_4_FINAL_REPORT.md` para o diagnóstico mais recente.

## Estrutura

- `src/`: extensão, armazenamento local, recomendação e interface.
- `tests/`: testes automatizados.
- `scripts/`: build, instalação, restauração e pesquisa.
- `docs/`: arquitetura, manual e relatórios.

## Licença

MIT. Copyright (c) 2026 Victor Martins. Veja `LICENSE`.

## Independência e riscos

O NeuralTune não é afiliado, endossado ou mantido pelo Spotify. Usa APIs internas não oficiais do cliente, que podem mudar ou deixar de funcionar sem aviso. O uso é por conta e risco de quem instala. O projeto não contorna DRM nem baixa áudio.
