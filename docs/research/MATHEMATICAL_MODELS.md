# Modelos matemáticos do NeuralTune 4.0

Constantes não fundamentadas em fonte são escolhas de engenharia e estão marcadas como tais. A base (vetor, LinUCB, Poincaré, Thompson) está em `docs/05_BRAIN_2_ARQUITETURA.md`.

## 1. Previsão: PPM com decaimento

Kernel de Harrison et al. (2020):

$$w(t)=w_\infty+(w_0-w_\infty)\,2^{-t/t_{0.5}}$$

Contagem decaída: $c(s\mid\text{ctx})=\sum_k w(t-t_k)$. Com o método A do PPM, da ordem máxima à zero:

$$P(s)=\sum_{o}\Big[\prod_{o'>o}\tfrac{1}{n_{o'}+1}\Big]\frac{c_o(s)}{n_o+1}+\frac{\prod_o\frac{1}{n_o+1}}{|A|}$$

Surpresa $S=-\log_2P(x_t\mid\text{ctx})$ e entropia $H=-\sum P\log_2P$, calculadas **antes** de aprender o evento, normalizadas por $\log_2|A|$.

Parâmetros de engenharia: ordem 2, $w_0=1$, $w_\infty=0{,}2$, $t_{0.5}=60$ s.

| Sequência | Símbolos | Fonte |
|---|---|---|
| Harmônica | Classe de altura dominante, com repetições fundidas | `segments[].pitches` |
| Rítmica | $\operatorname{round}\log_2(d_t/d_{t-1})$, 7 classes | `segments[].duration` |
| Timbral | Brilho em 6 quantis | `segments[].timbre[1]` |
| **Melódica** | **Não calculada** | chroma polifônico não é melodia |

## 2. Preferência por informação

Regressão ridge, com colunas centradas, em cinco termos:

$$\hat r=\beta_1S+\beta_2H+\beta_3SH+\beta_4S^2+\beta_5H^2$$

A forma vem de Cheung (2019) e Gold (2019). Os sinais são aprendidos por usuário e o modelo só opina com $n\ge30$. Um teste mostra que ele recupera tanto o U invertido quanto o oposto.

## 3. Ritmo

- Regularidade: $1-\min(1,\ \sigma_{IBI}/\mu_{IBI})$.
- Padrão: histograma de 16 posições do compasso, pesado por nível.
- Síncope: fração de energia a mais de 1/8 de batida da grade.
- Compatibilidade: $\tfrac12\text{sim}_\text{tempo}+\tfrac12\text{sim}_\text{padrão}$, com o melhor deslocamento de batida inteira.

Kuramoto implementado: $\dot\theta_i=\omega_i+\frac KN\sum_j\sin(\theta_j-\theta_i)$ e $re^{i\psi}=\frac1N\sum_je^{i\theta_j}$.

**Por que não entrou no ranking.** Para duas faixas, $\phi=\theta_1-\theta_2$ dá

$$\dot\phi=\Delta\omega-K\sin\phi$$

que tem ponto fixo só se $|\Delta\omega|\le K$. O resultado depende unicamente da diferença de tempo, então Kuramoto não carrega informação além do BPM. O experimento confirmou: AUC 0,51.

## 4. Plasticidade

$$w_{t+1}=w_t+\eta\,|\Delta_t|\,(b-w_t),\quad b=\operatorname{sign}\Delta_t$$

Traços duradouro ($t_{1/2}=180$ d, $\eta=0{,}2$) e momentâneo (45 min, $\eta=0{,}5$), com afinidade $0{,}7w_d+0{,}3w_m$.

| Evento | $\Delta_t$ |
|---|---|
| Nota 0 a 5★ | $-1,\ -0{,}6,\ -0{,}3,\ 0,\ 0{,}5,\ 1$ |
| Escuta completa voluntária | $+0{,}25$ |
| Escuta completa não voluntária | $+0{,}1$ |
| Escuta parcial | $+0{,}03$ |
| Skip isolado | $0$ |
| Skip repetido ($\ge2$) | $-0{,}2$ |
| Exposição involuntária | $0$ |
| Mais assim (variante com memória) | $+0{,}5$ |
| Menos assim (variante com memória) | $-0{,}3$ |

Essa tabela é escolha de modelagem. Não há análogo de STDP: nenhum evento digital tem tempo de disparo.

## 5. Morfologia e emenda

Vetor por seção: nível médio, brilho, densidade de onsets e chave estimada. Core é a janela de 30 s que maximiza nível médio mais densidade.

$$\text{SeamCost}(i,j)=\|v_\text{outro}(i)-v_\text{intro}(j)\|^2_W+\gamma\,\text{CamelotDist}(i,j)+\gamma_t\,\big|\rho-\operatorname{round}\rho\big|$$

com $\rho=|\log_2(\text{BPM}_i/\text{BPM}_j)|$. Pesos: escalas típicas, não percepção.

**Atribuição de skip.** Compara o nível em $[t_s-10,t_s]$ com o restante da faixa, com IC de 95% sobre a diferença pareada, exigindo $n\ge12$. Relata associação em muitos eventos, nunca causa de um skip.

## 6. Tempo e sessão

Von Mises com $\hat\kappa$ de Banerjee, encolhido pelo prior $n/(n+5)$:

$$p(\theta\mid k)=\frac{e^{\kappa\cos(\theta-\mu)}}{2\pi I_0(\kappa)},\qquad P(k\mid h,d)\propto\pi_k\,p(\theta_h\mid k)\,p(\theta_d\mid k)$$

CUSUM unilateral (Page, 1954): $S_t=\max(0,S_{t-1}+\hat r_t-r_t-\delta)$, com $\delta=0{,}15$, limiar 2,5, mínimo de 4 eventos e carência de 6. Dois skips não atingem o limiar. Horário não mede humor nem ritmo biológico.

## 7. Calibração

Steck (2018): $\tilde Q=(1-\epsilon)Q+\epsilon P$, $D_{KL}(P\|\tilde Q)$ e, em ordem gulosa,

$$U(x\mid S)=(1-\lambda)\text{Score}(x)-\lambda\,\Delta D_{KL}$$

Classes são clusters acústicos. IPS: $w=1/\max(0{,}1,\hat\pi)$ com a propensão gravada no registro de exposição, $\hat\pi=\min(1,k\,p_i)$ para $k$ sorteios, uma aproximação da inclusão sem reposição. Sem ela, peso 1.

## 8. Descoberta

$$\text{Gain}(x)=\text{Score}(x)\,(1-\beta\,\text{Pop}(x)^2)\,\mathbb I(x\notin H)$$

$\text{Pop}\in[0,1]$, $\beta=0{,}8$, o que mantém o fator positivo. Sem contagem de plays, $\text{Pop}=1-p/N$ pela posição $p$ no top do artista; em faixas de álbum é desconhecida e vale 0,5.

## 9. Autopilot

$$J=0{,}4P+0{,}1D+0{,}2C+0{,}15K+0{,}15E-0{,}1R$$

Termos em $[0,1]$. $E$ é a fração de escutas concluídas, nunca tempo na plataforma. Pesos manuais. **Esta função está testada, mas o Autopilot em produção usa a composição do `EigenResonanceRanker`**, que já combina esses sinais.

## 10. PCA

Power iteration com deflação de Hotelling, $\Sigma\leftarrow\Sigma-\lambda vv^\top$. Validado contra Jacobi, com $|v_1^\top v_2|<10^{-6}$ (medido $2{,}2\times10^{-13}$).

## 11. Arquitetura unificada

$z_t=f(H_t,C_t,A_t)$ é mantido como termos aditivos sobre a pontuação 3.0, cada um desligável:

$$U(x)=U_{3.0}(x)+\sum_{m\in\text{ligados}}\text{termo}_m(x,t)$$

Um modelo único treinado não teria dados: há centenas de notas de uma pessoa.
