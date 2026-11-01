# 02 — MANUAL DO USUÁRIO — NEURALTUNE

## Sistema Avançado de Personalização Musical, Filtragem Preditiva e Otimização do Spotify

---

## 1. VISÃO GERAL

O **NeuralTune** é uma camada de inteligência e controle musical integrada ao Spotify Desktop através do Spicetify. Ele substitui extensões frágeis como a Trash Bin e soluciona estruturalmente o problema de pular músicas repetidamente em fila (*skip storms*).

Além da filtragem preventiva, o NeuralTune introduz um sistema de avaliação de **0 a 5 estrelas**, um motor de preferências multidimensional com aprendizado Bayesiano, rádios inteligentes contextuais e explicabilidade auditável (*"Por que esta música?"*).

---

## 2. INSTALAÇÃO E ATIVAÇÃO

### 2.1 Requisitos
- Windows 11
- Spotify Desktop instalado
- Spicetify CLI v2.46+ instalado

### 2.2 Instalação com um único comando
Abra o PowerShell na pasta do projeto e execute:

```powershell
npm run install:spicetify
```

O script realizará automaticamente:
1. Compilação do bundle de produção `dist/neuraltune.js`.
2. Backup de segurança da sua configuração anterior (`config-xpui.ini.neuraltune.bak`).
3. Cópia da extensão para o diretório de extensões do Spicetify.
4. Registro e aplicação via `spicetify apply`.

---

## 3. SISTEMA DE AVALIAÇÃO DE 0 A 5 ESTRELAS

O NeuralTune permite avaliar qualquer faixa em reprodução através de 3 métodos:

### 3.1 Interface Visual na Barra de Reprodução (Now Playing Bar)
No canto inferior esquerdo, ao lado do botão de curtir e do título da música, o widget do NeuralTune exibe:
- **Ícone de Lixeira / Bloqueio (Nota 0):** Rejeição absoluta da faixa.
- **5 Estrelas Interativas (Notas 1 a 5):** Clique sobre qualquer estrela para classificar. O hover dinâmico pré-visualiza a nota.

### 3.2 Escala de Notas e Consequências

| Nota | Significado | Efeito Determinístico | Efeito Estatístico no Perfil |
|---|---|---|---|
| **0** | Rejeição Total | Faixa banida e adicionada à blacklist | Penalidade moderada nos atributos (sem extinguir gêneros inteiros) |
| **1** | Detesto | Faixa excluída das recomendações | Forte sinal negativo ponderado |
| **2** | Não gosto | Baixa prioridade | Sinal negativo moderado |
| **3** | Indiferente | Faixa neutra | Nenhum impacto nos pesos de preferência |
| **4** | Gosto | Prioridade alta | Sinal positivo nos atributos |
| **5** | Adoro | Prioridade máxima | Forte sinal positivo e âncora de afinidade |

### 3.3 Atalhos de Teclado Rápidos

| Atalho | Ação Executada |
|---|---|
| `Ctrl + Alt + 0` | Avaliar com 0 estrelas (Bloquear e avançar imediatamente) |
| `Ctrl + Alt + 1` | Avaliar com 1 estrela (Detesto) |
| `Ctrl + Alt + 2` | Avaliar com 2 estrelas (Não gosto) |
| `Ctrl + Alt + 3` | Avaliar com 3 estrelas (Indiferente) |
| `Ctrl + Alt + 4` | Avaliar com 4 estrelas (Gosto) |
| `Ctrl + Alt + 5` | Avaliar com 5 estrelas (Adoro) |
| `Ctrl + Alt + Z` | **Desfazer** última avaliação |
| `Ctrl + Alt + Y` | **Refazer** avaliação desfeita |
| `Ctrl + Alt + M` | Abrir o **Dashboard do NeuralTune** |
| `Ctrl + Alt + L` | Curtir música atual |
| `Ctrl + Alt + H` | Bloquear música atual (compatibilidade) |
| `Ctrl + Alt + N` | Próxima música |

### 3.4 Menu de Contexto
Clique com o botão direito sobre qualquer música em qualquer playlist, álbum ou lista e selecione a nota desejada no menu de contexto do NeuralTune.

---

## 4. ELIMINAÇÃO DOS SKIPS SUCESSIVOS

O NeuralTune resolve a limitação da Trash Bin através de duas frentes:

### 4.1 Predictive Queue Guardian (Filas Nativas e Autoplay)
- Ao contrário da Trash Bin (que espera a música começar a tocar para forçar um skip reativo), o Guardian inspeciona as próximas faixas da fila (`nextUp`) com antecedência.
- Faixas bloqueadas por nota 0 ou pertencentes a artistas bloqueados são removidas silenciosamente usando `Spicetify.removeFromQueue` **antes** que o player avance para elas.
- Músicas adicionadas manualmente por você na fila (`is_queued`) são preservadas por padrão.
- **Circuito de Proteção Anti-Loop:** Se múltiplos skips ocorrerem em fração de segundo (ex: contexto com apenas músicas bloqueadas), o NeuralTune pausa a reprodução automaticamente e emite aviso, impedindo que o Spotify entre em ciclo infinito de congelamento.

### 4.2 NeuralTune Smart Playback (Rádios e Descoberta)
- Para sessões de rádio personalizadas, o NeuralTune opera em modo gerenciado.
- Os candidatos são obtidos e 100% filtrados **antes** do início do playback.
- Nenhuma música rejeitada chega sequer à fila do reprodutor: **zero skips**.

---

## 5. DASHBOARD DO NEURALTUNE (`Ctrl + Alt + M`)

Pressione `Ctrl + Alt + M` ou clique no botão de estrela no menu superior para abrir o Dashboard:

### Aba 1: "Por que esta música?" (Explicabilidade)
Apresenta o raio-X da faixa atual:
- Pontuação calculada de afinidade (0 a 100)
- Grau de confiança estatística (%)
- Fatores favoráveis listados em verde (+%)
- Fatores desfavoráveis listados em vermelho (-%)
- Indicador de novidade e fontes dos metadados (BPM, tonalidade, acústica, histórico).

### Aba 2: Minhas Avaliações
- Gráfico da distribuição das suas notas.
- Histórico completo de músicas avaliadas com botão de edição ou remoção rápida.

### Aba 3: Blacklist & Trash Bin
- Lista completa de músicas e artistas bloqueados.
- Botão **"Importar dados da Trash Bin"**: transfere sua lista existente da Trash Bin em 1 clique sem duplicatas.
- Aba **"Exportar & Sincronizar"**: exporta JSON completo e CSV, sincroniza playlists e importa backups. `Ctrl+Alt+E` exporta JSON e CSV de uma vez.

### Aba 4: Rádios Personalizadas
Inicie rádios com filtragem estrita pré-reprodução:
- 🎵 **Preferências:** Centrada nas faixas mais bem avaliadas e atributos consolidados.
- 🧭 **Descoberta:** Prioriza músicas que você ainda não avaliou com controle de novidade.
- ⚡ **Academia:** Alta energia ($\ge 0.70$) e andamento acelerado (BPM $\ge 125$).
- 💼 **Trabalho:** Energia moderada sem ruídos ou variações bruscas.
- 📚 **Estudo:** Exclusivamente instrumental, acústica e foco.
- 🌙 **Relax:** Baixa energia e andamento calmo.

### Aba 5: Preferências Aprendidas
- Tabela com os pesos estatísticos calculados para cada gênero, época e andamento musical.
- Permite visualizar o grau de certeza do motor e resetar preferências indesejadas.

### Aba 6: Desempenho & Diagnóstico
- Latência média em milissegundos para avaliação da fila e pontuação Bayesiana.
- Estado do circuito de proteção e consumo de memória.

---

## 6. REVERSÃO E DESINSTALAÇÃO

Para desinstalar o NeuralTune e restaurar o estado original do Spotify a qualquer momento:

```powershell
npm run restore:backup
```

O comando desativa a extensão no Spicetify, restaura o arquivo `config-xpui.ini.neuraltune.bak` e re-aplica as configurações limpas ao Spotify.
