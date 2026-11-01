# NeuralTune Brain 2.0: arquitetura e validação

Válido para Spotify 1.3.6.1921 com Spicetify. As assinaturas de `RootlistAPI`, `PlaylistAPI` e `setPublishedState` foram lidas do bundle `xpui-modules.js` dessa versão.

## 1. Modelo matemático

### 1.1 Espaço acústico

Cada faixa vira um ponto `x ∈ [0,1]⁸`:

`[tempo, energy, valence, danceability, acousticness, instrumentalness, speechiness, liveness]`

O tempo é normalizado por `(bpm − 50) / 150`. Dimensões ausentes recebem a média populacional μ e ficam marcadas como desconhecidas: quando só o tempo está disponível, o modelo não aprende nada sobre energia.

**Por que centralizar.** Todos os valores são positivos, então o cosseno cru entre músicas opostas ainda é alto (0,30 entre metal e ambient). Por isso a similaridade usa `z = (x − μ) / σ`, truncado em ±3. Com isso, o mesmo par fica em −0,35 e um par parecido em 0,98. μ e σ são estimativas arredondadas do catálogo, não ajustadas à biblioteca do usuário.

### 1.2 Vetor do usuário

Partindo de `u₀ = μ`, cada nota aplica nas dimensões conhecidas:

```
u ← clamp(u + η · w · k · (x − u))     η = 0,12
```

| Nota | w | k |
|---|---|---|
| 5★ | +1,0 | 1 |
| 4★ | +0,5 | 1 |
| 3★ | 0 | sem efeito no vetor; ainda reduz a incerteza do bandit |
| 2★ | −0,3 | RBF |
| 1★ | −0,6 | RBF |
| 0★ | −1,0 | RBF, mais uma zona de evitação |

`k = exp(−d² / 2h²)`, com `h = 0,6` e `d²` a distância quadrática média em z. Sem esse fator, rejeitar uma faixa muito distante do perfil empurraria o vetor com **mais** força, o inverso do desejado.

**0★** cria uma zona de evitação: a faixa penaliza só a sua vizinhança acústica (`−25 · max RBF`, até 256 zonas). O gênero recebe apenas o ajuste bayesiano proporcional, então não é aniquilado.

### 1.3 O modelo é função pura das avaliações

O gradiente depende da ordem. Atualizar incrementalmente tornaria Desfazer, reavaliar e importar impossíveis de reverter com exatidão. Por isso `retrain()` refaz tudo em ordem cronológica a cada mudança. Isso custa O(n) e fica abaixo de 200 ms por avaliação com 20 000 avaliações (há teste cobrindo esse limite).

### 1.4 Bandit contextual (LinUCB)

```
φ = [1, z] / ‖[1, z]‖
A = λI + Σ φφᵀ        b = Σ w·φ        θ = A⁻¹b
r̂ = θᵀφ              incerteza = √(φᵀA⁻¹φ) ∈ (0, 1]
```

O termo de explotação é `18 · r̂`. O de exploração é `40 · α · incerteza`, com `α = explorationFactor` (0,2 por padrão), e cai à medida que regiões parecidas recebem avaliações.

Só notas explícitas treinam o bandit. Skips e reproduções completas entram na fadiga e no histórico, mas não na recompensa.

### 1.5 Anti-fadiga

Exposição acumulada, com um termo por audição:

```
E(Δt) = 0,55·e^(−Δt/30min) + 0,30·e^(−Δt/2h) + 0,15·e^(−Δt/24h)
F = E_faixa + 0,5·max(E_artista) + termo de sequência
penalidade = 40 · (1 − e^(−F))
```

Audições abaixo de 5 s (saltos automáticos e cliques errados) não cansam. Eventos com mais de 72 h são descartados.

### 1.6 Pontuação e explicação

```
score = clamp(50 + acústica + LinUCB + exploração + artista + atributos − evitação − fadiga)
```

| Componente | Máximo |
|---|---|
| Afinidade acústica: `cos(z_x, z_u) · (1 − e^(−n/8))` | ±22 |
| Previsão LinUCB | ±18 |
| Artista (bayesiano) | ±20 |
| Gênero, época e faixas acústicas (bayesiano) | ±25 |
| Exploração | até 40·α |
| Evitação | até −25 |
| Fadiga | até −40 |

Cada percentual é `pontos / soma dos pontos positivos`. O texto no painel segue o formato `64% afinidade acústica (alta energia + baixa valência), +36% afinidade com o artista, -5% penalidade por repetição recente`.

## 2. Limitações conhecidas

- **`/v1/audio-features`**: o Spotify fechou o endpoint para apps novos em novembro de 2024. Não foi possível verificar se o token do cliente desktop passa. Um 403 desativa a consulta até reiniciar o Spotify, e a faixa atual usa o tempo da `audio-analysis`. Nesse cenário o vetor aprende só o andamento, e o peso real fica em artista, atributos e fadiga.
- **Gêneros**: nada popula `TrackMetadata.genres` na reprodução real, então o sinal de gênero só existe em dados importados com esse campo.
- **Total de Reproduções** conta a partir desta versão. A v1 não gravava histórico.
- **Atalhos** funcionam com o Spotify em foco, não em todo o sistema operacional.

## 3. Compilar e validar (PowerShell)

```powershell
Set-Location %USERPROFILE%\Documents\NeuralTune
npm test
npm run build
npm run install:spicetify
```

O passo final copia o bundle, roda `spicetify apply` e reinicia o Spotify. Na primeira abertura, o IndexedDB migra de v1 para v2 só adicionando stores: as notas existentes não são alteradas.

Para diagnosticar pelo console do Spotify:

```powershell
spicetify enable-devtools
```

Depois, com o Spotify aberto, `Ctrl+Shift+I` e, no console:

```js
NeuralTune.getAudioDiagnostics()
```

| `status` | Significado |
|---|---|
| `available` | O vetor acústico completo está ativo |
| `unavailable` com `HTTP 403` | O endpoint recusou: só o tempo é aprendido |
| `backing-off` | Limite de requisições, nova tentativa em 60 s |
| `unknown` | Ainda não houve consulta: toque uma música |

### Roteiro manual

1. Com o teclado ABNT2, `Ctrl+Alt+4` deve acender 4 estrelas sem piscar a barra.
2. Clique no slider de volume e repita: o atalho deve continuar funcionando.
3. `Ctrl+Alt+0` deve pular **uma** faixa, sem som residual, e o volume deve voltar em menos de 1 s.
4. `Ctrl+Alt+Z` e `Ctrl+Alt+Y` devem desfazer e refazer.
5. `Ctrl+Alt+E` deve pedir uma pasta e gravar o JSON e o CSV. Abra o CSV no Excel e confira as colunas e os acentos.
6. `Ctrl+Alt+M` → **Exportar & Sincronizar** → **Sincronizar playlists agora**: as três playlists devem surgir na biblioteca.

### Reverter

O backup da v1 está em `%USERPROFILE%\Documents\NeuralTune-backup-v1-2026-10-31`. Para voltar:

```powershell
Copy-Item %USERPROFILE%\Documents\NeuralTune-backup-v1-2026-10-31\dist\neuraltune.js $env:APPDATA\spicetify\Extensions\neuraltune.js -Force
spicetify apply
```

O código v1 abre o banco com a versão 1 e falha ao encontrar a v2, caindo em memória. Para preservar as notas, exporte o JSON antes de reverter.


---

# NeuralTune 3.0: Eigen-Resonance + Omni-RecSys

Atualização: a sonda da versão 4.0 mediu **429 em toda a Web API**, e não recusa específica do udio-features. Ver `docs/research/ARCHITECTURE_AND_DATA_FEASIBILITY.md`.

Esta parte substitui as limitações da seção 2 quanto a `audio-features`, gêneros e feedback implícito. Testes: 281, todos passando (`npm test`).

## 3.0 Evidências que definiram a arquitetura

Medições feitas na máquina de produção, Spotify 1.3.6.1921:

- Com música tocando, a sessão de áudio ativa do Windows pertence ao processo principal `Spotify.exe`. Os renderers CEF não carregam `AudioSes`/`MMDevAPI`, e não há processo `audio.mojom.AudioService`. **Logo, não há sinal de música no renderer**: `createMediaElementSource` capturaria silêncio.
- `/v1/audio-features` foi recusado; `audio-analysis` (`Spicetify.getAudioData`) respondeu com a árvore completa, o que foi confirmado por registros reais no IndexedDB.

| Fonte de dados | Cobre | Limite |
|---|---|---|
| `audio-analysis` → `AudioAnalysisSynthesizer` | Qualquer faixa, sem tocá-la | É remota: o sistema **não** é 100% independente do Spotify |
| Captura por loopback → `LocalAudioDSPEngine` | Só o que está tocando, com tudo que o Windows emitir | Exige dispositivo de loopback e clique do usuário |

## 3.1 Espaço hiperbólico (Poincaré)

Na bola $\mathbb{B}^d$ de curvatura $-1$, a métrica é $g_x=\lambda_x^2 I$ com $\lambda_x=\frac{2}{1-\|x\|^2}$, e

$$d(u,v)=\operatorname{arcosh}\alpha,\qquad \alpha=1+\frac{2\|u-v\|^2}{(1-\|u\|^2)(1-\|v\|^2)}$$

**Gradiente.** Pela regra da cadeia, $\nabla_E d=\frac{\nabla_u\alpha}{\sqrt{\alpha^2-1}}$, com

$$\nabla_u\alpha=\frac{4(u-v)}{(1-\|u\|^2)(1-\|v\|^2)}+\frac{4\|u-v\|^2\,u}{(1-\|u\|^2)^2(1-\|v\|^2)}$$

Como $g_u^{-1}=\frac{(1-\|u\|^2)^2}{4}I$, vem $\nabla_R=\frac{(1-\|u\|^2)^2}{4}\nabla_E$. Todo gradiente de distância tem norma riemanniana 1, e $\nabla_R d=-\log_u(v)/d$: os testes verificam as duas identidades, além de que um passo $t$ encurta a distância em exatamente $t$.

**Atualização.** $u_{t+1}=\exp_u(-\eta_r\operatorname{sign}(r-3)\nabla_R)$, com $\exp_u(v)=u\oplus\tanh\!\big(\tfrac{\lambda_u\|v\|}{2}\big)\tfrac{v}{\|v\|}$. Duas adições à regra pedida: $\eta_r\propto|r-3|$, para 5★ puxar mais que 4★; e, para $r<3$, $\eta_r\propto e^{-d/2}$, porque o gradiente tem norma 1 em todo lugar e, sem isso, uma faixa rejeitada em um galho distante empurraria o perfil tanto quanto uma vizinha.

**Limite.** Não há taxonomia nos dados, então a árvore não é aprendida. Faixas entram por $\exp_0(0{,}25\,z)$ a partir do vetor acústico, e artistas são o gyromidpoint das suas faixas.

## 3.2 Roda de Camelot

Com $f=7p \bmod 12$ a posição no círculo de quintas, maior: $n=((f+7)\bmod 12)+1$; menor usa a relativa maior, $p+3$. Assim, Dó maior = 8B e Lá menor = 8A.

A compatibilidade forma a matriz de adjacência $24\times24$

$$C=(I_{12}+P+P^\top)\otimes I_2+I_{12}\otimes X$$

com $P$ a permutação cíclica e $X$ a troca de anel. Toda chave tem exatamente 4 vizinhas, ela própria incluída. A especificação permitia “alternância de modo” sem manter o número; isso tornaria quaisquer duas chaves compatíveis, então a troca $A\leftrightarrow B$ exige o mesmo número.

## 3.3 Thompson e entropia

Por dimensão, $(\mu_k,\tau_k)\sim\text{Normal-Gama}$ sobre $x_k=r\,z_k$, com atualização conjugada fechada, e $\theta^*\sim P(\theta\mid\mathcal D)$. As dimensões são independentes, então correlações de gosto ficam de fora deste módulo.

A distribuição que minimiza $F=\bar U-TH$, com $H$ em bits e $U_i=-\text{utilidade}_i$, é $p_i\propto\exp(-U_i\ln 2/T)$. O fator $\ln 2$ é necessário porque $H$ está em bits; um teste confirma que é o mínimo sob perturbações. Temperaturas: 0,1 em foco, 0,8 em descoberta e fim de semana, 0,3 no restante.

## 3.4 Sintetizador acústico

Pilar 1 implementado em `AudioAnalysisSynthesizer.ts`. **Os coeficientes são heurísticos e não foram ajustados contra valores reais do Spotify, por falta de pares rotulados.** Ordenam faixas de forma plausível, mas não reproduzem os números de `audio-features`. Por isso os filtros de rádio cedem ao vetor-alvo quando eliminariam quase tudo.

Medição em produção, com tom e modo vindos do cabeçalho da análise:

| Dimensão | Mín | Mediana | Máx |
|---|---|---|---|
| BPM | 79,9 | 125,0 | 190,7 |
| energy | 0,61 | 0,73 | 0,79 |
| danceability | 0,21 | 0,50 | 0,57 |
| acousticness | 0,19 | 0,22 | 0,45 |
| instrumentalness | 0,04 | 0,35 | 0,68 |
| speechiness | 0,04 | 0,09 | 0,11 |
| valence | 0,19 | 0,61 | 0,72 |

Amostra de 6 faixas totalmente decodificadas; por isso são indicativos, não uma calibração. `liveness` tinha mediana 0,61 e teve o viés corrigido: registros antigos são refeitos pela `SYNTHESIS_VERSION`.

## 3.5 Mistura de gostos

DP-means online: nota ≥4★ a uma distância RMS $>1{,}2$ de todos os centroides cria um cluster, até $K=6$. `userVector` permanece para a interface.

$$\text{Afinidade}(z)=\max_k\ \pi_k^{\beta}\cos(z,c_k)\,\exp\!\Big(-\frac{\|z-c_k\|^2/8}{2h^2}\Big)$$

O portão gaussiano é adição à fórmula pedida. O cosseno ignora magnitude, e uma faixa mediana alinhada com um centroide forte seria tratada como membro dele: sem esse termo, o teste de pop intermediário não separava a faixa do meio dos extremos.

## 3.6 Feedback implícito e bandit

$\phi(z)$ tem 21 termos: bias, 8 lineares, 8 quadráticos centrados e 4 cruzamentos. Um teste com XOR de energia × acústica prova a fronteira não linear. Sinais implícitos alimentam só o bandit, com confiança $c=\min(0{,}6;\ 0{,}15\ln(1+n))$. Nota explícita tem soberania.

## 3.7 Grafo

$y^{(l+1)}=(1-\alpha)\tilde A y^{(l)}+\alpha y^{(0)}$, com $\alpha=0{,}5$, 2 saltos e penalidade $d_j^{-0{,}75}$ no emissor. Gêneros vêm de `/v1/artists` quando esse endpoint responder, e são propagados pelos vizinhos. Se ele recusar, não há gêneros a propagar.

## 3.8 Memória cognitiva

Saciação em 30 min, 2 h e 24 h, encerrada em 48 h. Depois de 72 h, $B_i=\ln\sum_k\Delta t_k^{-d_i}$, com $d_i=d_0e^{-\beta a_i}$, e bônus de 8 a 12 pontos dentro da zona que uma exposição percorre entre 7 e 30 dias.

Desvio da fórmula: compara-se $B_i-0{,}7\ln m$. $B_i$ puro cresce com cada audição, e um favorito ouvido ao longo de meses nunca entraria na zona, justamente o caso que o pilar quer resolver.

## 3.9 Trajetória da fila

$\pi(i+1)=\arg\max[\lambda_1\text{Score}-\lambda_2\text{Cost}+\lambda_3\log\det L]$, pelo MAP guloso de Chen et al. (2018), com Cholesky incremental em $O(KN)$ por passo. O ganho usa o resíduo relativo com piso de 0,02, senão quase duplicatas tornam $\log\det$ ilimitado e ele vence a nota.

**Hubness.** A fórmula $\hat S=S/\sqrt{\bar S_k\bar S_k}$ não reverte um hub uniforme: ultrapassá-lo exigiria $s>\sqrt{hx}$ com $x>s$, logo $s>h$. Ela suaviza, e a Mutual Proximity por postos remove o hub. A matriz resultante não é garantidamente semidefinida positiva; o resíduo é limitado por baixo, então o método é heurístico.

`HarmonicQueueSolver` (beam search com restrições rígidas, ±8%) é usado quando o prompt pede mixagem harmônica ou DJ. É heurística para o MILP, sem certificado de otimalidade; em instâncias pequenas coincidiu com a força bruta.

## 3.10 Limitações

- Pesos da pontuação e do sintetizador são escolhas manuais: não há métrica offline de qualidade de recomendação.
- Filtro de década só atua em faixas com `releaseYear`, que itens da biblioteca não trazem.
- `audio-analysis` é por faixa: rádios analisam no máximo 30 faixas novas por vez, e o restante entra sem tonalidade até ser processado.
- O cálculo de fadiga e do grafo não usa skips fora dos sinais descritos; sinais implícitos não movem clusters nem `userVector`.
- JSPF usa links do Spotify: o ListenBrainz identifica por MusicBrainz ID e pode não resolver todas as faixas.
- Captura por loopback validada com sinal gerado no Chromium, não dentro do cliente Spotify, cujas permissões de mídia não foram testadas.
- Não houve auditoria dos 515 repositórios citados: as técnicas foram implementadas a partir das descrições.

## 3.11 Compilar e aplicar

```powershell
Set-Location %USERPROFILE%\Documents\NeuralTune
npm test
npm run build
npm run install:spicetify
```

Para voltar à 2.0, copie `%USERPROFILE%\Documents\NeuralTune-backup-v2-2026-10-31\dist\neuraltune.js` para `$env:APPDATA\spicetify\Extensions\neuraltune.js` e rode `spicetify apply`. O banco segue em v2, compatível.