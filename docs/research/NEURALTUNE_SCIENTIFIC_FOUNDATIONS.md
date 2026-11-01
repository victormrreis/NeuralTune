# Fundamentos científicos do NeuralTune

**Inspiração biológica não é validação biológica.** Nada no NeuralTune mede cérebro, emoção ou fisiologia. O sistema infere preferências a partir de notas, reproduções e análise de áudio.

## Como ler

As sínteses editoriais são paráfrases breves dos resumos consultados; não reproduzem os textos dos artigos. As referências identificam as fontes originais. Os itens de aplicação são análise própria. Onde a fonte não foi acessada, não inferimos seus resultados pelo título.

Tratamento completo dos 11 itens exigiria leitura integral das 40 referências. Isso **não foi feito**: há 14 textos disponíveis, lidos por trechos, e o restante é resumo ou só metadados.

## Principais conclusões para o software

- **PPM-Decay (NT-059)** é a referência de maior aproveitamento: dá kernel exato e método reproduzível.
- **NT-060 e NT-061** dão a forma do modelo (interação e termos quadráticos), mas são resultados populacionais em estímulos controlados. O motor aprende o sinal de cada usuário.
- **Kuramoto** aparece em NT-003 e NT-041 como hipótese entre outras. No experimento interno não acrescentou nada à diferença de tempo.
- **Plasticidade (NT-164, NT-273)** é sináptica. Daqui saem apenas limites e decaimento, propriedades que se justificam também sem biologia.
- **Sem uso possível:** a maior parte da seção de decodificação EEG, conectividade e aquisição de sinais exige sensores que o NeuralTune não tem e não vai pedir.

## Referências prioritárias

### NT-059. PPM-Decay: A computational model of auditory prediction with memory decay

- **Referência:** Peter M. C. Harrison, Roberta Bianco, Maria Chait, Marcus T. Pearce (2020). PLoS computational biology https://doi.org/10.1371/journal.pcbi.1008304
- **Acesso:** `FULL_TEXT` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** O modelo PPM-Decay dá menos influência a observações antigas, permitindo estudar adaptação a sequências cuja estrutura muda.
- **Aplicação real no software:** DecayedPpm: kernel w(t) e PPM método A
- **Dados do NeuralTune:** Sequências de classes de altura, IOI e brilho derivadas de segments[]
- **Experimento para demonstrar benefício:** Comparar NDCG com e sem o termo de informação nas notas reais (ablação em execução no cliente)
- **Adaptação e limite:** Eventos não são notas; decaimento medido em segundos da faixa, não em memória do ouvinte

### NT-075. Statistical learning and probabilistic prediction in music cognition: mechanisms of stylistic enculturation.

- **Referência:** Marcus T. Pearce (2018). Annals of the New York Academy of Sciences https://doi.org/10.1111/nyas.13654
- **Acesso:** `FULL_TEXT` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** A revisão relaciona a experiência com uma cultura musical ao aprendizado de regularidades e à formação de expectativas probabilísticas.
- **Aplicação real no software:** Motivação do aprendizado estatístico por sequência
- **Dados do NeuralTune:** segments[].pitches
- **Experimento para demonstrar benefício:** Mesmo experimento de NT-059
- **Adaptação e limite:** Revisão sobre enculturação; o motor mede só a faixa isolada

### NT-060. Uncertainty and surprise jointly predict musical pleasure and amygdala, hippocampus, and auditory cortex activity.

- **Referência:** Vincent K.M. Cheung, Peter M.C. Harrison, Lars Meyer, Marcus T. Pearce, John-Dylan Haynes, Stefan Koelsch et al. (2019). Current biology : CB https://doi.org/10.1016/j.cub.2019.09.067
- **Acesso:** `ABSTRACT_ONLY` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** O estudo combina incerteza anterior ao evento e surpresa ao ouvi-lo para investigar relações não lineares com prazer musical.
- **Aplicação real no software:** Termos S, H e S×H do modelo de preferência
- **Dados do NeuralTune:** Surpresa e incerteza por faixa + notas
- **Experimento para demonstrar benefício:** Ajuste individual com n ≥ 30 e teste fora da amostra
- **Adaptação e limite:** Resultado de acordes em laboratório; aqui é média por faixa

### NT-061. Predictability and uncertainty in the pleasure of music: a reward for learning?

- **Referência:** Benjamin P. Gold, Marcus T. Pearce, Ernest Mas-Herrero, Alain Dagher, Robert J. Zatorre (2019). The Journal of neuroscience : the official journal of the Society for Neuroscience https://doi.org/10.1523/JNEUROSCI.0428-19.2019
- **Acesso:** `ABSTRACT_ONLY` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** Os experimentos usam medidas informacionais de previsibilidade e incerteza para estudar preferências musicais e a hipótese de recompensa pelo aprendizado.
- **Aplicação real no software:** Termos quadráticos S² e H²
- **Dados do NeuralTune:** Surpresa e incerteza por faixa + notas
- **Experimento para demonstrar benefício:** Verificar sinal e ganho no usuário real
- **Adaptação e limite:** Estímulos e participantes diferentes; o sinal é aprendido, não assumido

### NT-054. Musical prediction error responses similarly reduced by predictive uncertainty in musicians and non‐musicians.

- **Referência:** David R. Quiroga‐Martinez, Niels C. Hansen, Andreas Højlund, Marcus Pearce, Elvira Brattico, Peter Vuust et al. (2020). The European journal of neuroscience https://doi.org/10.1111/ejn.14667
- **Acesso:** `ABSTRACT_ONLY` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** Músicos e não músicos apresentaram redução de algumas respostas de erro preditivo em condições musicais mais incertas.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-069. Reduced prediction error responses in high-as compared to low-uncertainty musical contexts.

- **Referência:** David R. Quiroga-Martinez, Niels C. Hansen, Andreas Højlund, Marcus T. Pearce, Elvira Brattico, Peter Vuust et al. (2019). Cortex; a journal devoted to the study of the nervous system and behavior https://doi.org/10.1016/j.cortex.2019.06.010
- **Acesso:** `ABSTRACT_ONLY`
- **Síntese editorial (paráfrase):** O trabalho compara sequências com diferentes níveis de incerteza para investigar como o contexto modula respostas neurais a desvios.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-066. Intracranial Recordings and Computational Modeling of Music Reveal the Time Course of Prediction Error Signaling in Frontal and Temporal Cortices.

- **Referência:** Diana Omigie, Marcus Pearce, Katia Lehongre, Dominique Hasboun, Vincent Navarro, Claude Adam et al. (2019). Journal of cognitive neuroscience https://doi.org/10.1162/jocn_a_01388
- **Acesso:** `ABSTRACT_ONLY`
- **Síntese editorial (paráfrase):** Registros intracranianos durante a escuta de melodias permitem examinar quando surgem sinais associados à imprevisibilidade musical.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-104. Probabilistic models of expectation violation predict psychophysiological emotional responses to live concert music

- **Referência:** Hauke Egermann, Marcus T. Pearce, Geraint A. Wiggins, Stephen McAdams (2013). Cognitive, affective & behavioral neuroscience https://doi.org/10.3758/s13415-013-0161-y
- **Acesso:** `ABSTRACT_ONLY`
- **Síntese editorial (paráfrase):** Um concerto de flauta serviu para comparar expectativas estimadas por modelo com relatos emocionais e medidas psicofisiológicas da plateia.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-100. Predictive uncertainty in auditory sequence processing.

- **Referência:** Niels Chr. Hansen, Marcus T. Pearce (2014). Frontiers in psychology https://doi.org/10.3389/fpsyg.2014.01052
- **Acesso:** `FULL_TEXT` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** A pesquisa examina se a entropia de distribuições preditivas representa a incerteza sentida antes do próximo evento musical.
- **Aplicação real no software:** Definição de incerteza como entropia preditiva
- **Dados do NeuralTune:** Distribuição do PPM
- **Experimento para demonstrar benefício:** Propriedades em tests/Neuroscience.test.ts
- **Adaptação e limite:** Sequências auditivas de laboratório

### NT-076. Information-theoretic properties of auditory sequences dynamically influence expectation and memory.

- **Referência:** Kat Agres, Samer Abdallah, Marcus Pearce (2018). Cognitive science https://doi.org/10.1111/cogs.12477
- **Acesso:** `ABSTRACT_ONLY` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** A previsibilidade das sequências influenciou julgamentos de expectativa e desempenho de memória ao longo de exposições repetidas.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-116. Auditory expectation: The information dynamics of music perception and cognition.

- **Referência:** Marcus T. Pearce, Geraint A. Wiggins (2012). Topics in cognitive science https://doi.org/10.1111/j.1756-8765.2012.01214.x
- **Acesso:** `ABSTRACT_ONLY`
- **Síntese editorial (paráfrase):** O texto reúne evidências de diferentes áreas para discutir expectativas musicais a partir de modelos cognitivos probabilísticos.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-063. Information-theoretic modelling of perceived musical complexity.

- **Referência:** Sarah A. Sauvé, Marcus T. Pearce (2019).  https://doi.org/10.1525/mp.2019.37.2.165
- **Acesso:** `ABSTRACT_ONLY` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** O estudo relaciona complexidade percebida a medidas informacionais de melodia e harmonia, considerando diferenças individuais.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-043. Predictive uncertainty underlies auditory boundary perception.

- **Referência:** Niels Chr. Hansen, Haley E. Kragness, Peter Vuust, Laurel Trainor, Marcus T. Pearce (2021). Psychological science https://doi.org/10.1177/0956797621997349
- **Acesso:** `ABSTRACT_ONLY` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** Experimentos com sequências sonoras relacionam maior incerteza preditiva a sinais perceptivos de encerramento de frases.
- **Aplicação real no software:** Atenção a fronteiras na morfologia
- **Dados do NeuralTune:** segments[] e sections
- **Experimento para demonstrar benefício:** Custo de emenda com e sem morfologia
- **Adaptação e limite:** Motivação indireta

### NT-058. Auditory but Not Audiovisual Cues Lead to Higher Neural Sensitivity to the Statistical Regularities of an Unfamiliar Musical Style.

- **Referência:** Ioanna Zioga, Peter M. C. Harrison, Marcus T. Pearce, Joydeep Bhattacharya, Caroline Di Bernardi Luft (2020). Journal of cognitive neuroscience https://doi.org/10.1162/jocn_a_01614
- **Acesso:** `ABSTRACT_ONLY`
- **Síntese editorial (paráfrase):** O estudo compara aprendizagem de uma gramática musical com apresentação apenas auditiva ou acompanhada de pistas visuais.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-077. Simulating melodic and harmonic expectations for tonal cadences using probabilistic models

- **Referência:** David R. W. Sears, Marcus T. Pearce, William E. Caplin, Stephen McAdams (2018).  https://doi.org/10.1080/09298215.2017.1367010
- **Acesso:** `METADATA_ONLY`
- **Síntese editorial (paráfrase):** indisponível: método, dados e resultados não foram acessados e não são descritos aqui.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-080. Compression-based Modelling of Musical Similarity Perception.

- **Referência:** Marcus Pearce, Daniel Müllensiefen (2017).  https://doi.org/10.1080/09298215.2017.1305419
- **Acesso:** `METADATA_ONLY`
- **Síntese editorial (paráfrase):** indisponível: método, dados e resultados não foram acessados e não são descritos aqui.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-107. Multiple Viewpoint Systems: Time Complexity and the Construction of Domains for Complex Musical Viewpoints in the Harmonisation Problem.

- **Referência:** Raymond P. Whorley, Geraint A. Wiggins, Christophe Rhodes, Marcus T. Pearce (2013).  https://doi.org/10.1080/09298215.2013.831457
- **Acesso:** `METADATA_ONLY` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** indisponível: método, dados e resultados não foram acessados e não são descritos aqui.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-120. Time-series analysis of Music: Perceptual and Information Dynamics.

- **Referência:** Marcus T. Pearce (2011).  https://doi.org/10.18061/1811/51214
- **Acesso:** `METADATA_ONLY` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** indisponível: método, dados e resultados não foram acessados e não são descritos aqui.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-032. Auditory and reward structures reflect the pleasure of musical expectancies during naturalistic listening.

- **Referência:** Benjamin P. Gold, Marcus T. Pearce, Anthony R. McIntosh, Catie Chang, Alain Dagher, Robert J. Zatorre et al. (2023). Frontiers in neuroscience https://doi.org/10.3389/fnins.2023.1209398
- **Acesso:** `FULL_TEXT`
- **Síntese editorial (paráfrase):** O trabalho investiga como expectativas e prazer durante a escuta se relacionam a sistemas auditivos e de recompensa.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-035. Cognitive and sensory expectations independently shape musical expectancy and pleasure.

- **Referência:** Vincent K. M. Cheung, Peter M. C. Harrison, Stefan Koelsch, Marcus T. Pearce, Angela D. Friederici, Lars Meyer et al. (2023). Philosophical transactions of the Royal Society of London. Series B, Biological sciences https://doi.org/10.1098/rstb.2022.0420
- **Acesso:** `FULL_TEXT`
- **Síntese editorial (paráfrase):** Modelos de expectativas sensoriais e cognitivas explicaram contribuições distintas aos julgamentos de surpresa e agradabilidade de acordes.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-022. Relationships between surprise, liking, and error perception in musical listening.

- **Referência:** Amira Korkor, Valdas Noreika, Caroline Di Bernardi Luft, Marcus Pearce (2025).  https://doi.org/10.1037/aca0000811
- **Acesso:** `METADATA_ONLY`
- **Síntese editorial (paráfrase):** indisponível: método, dados e resultados não foram acessados e não são descritos aqui.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-025. Perceptual representations mediate effects of stimulus properties on liking for music.

- **Referência:** Ana Clemente, Thomas M. Kaplan, Marcus T. Pearce (2024). Annals of the New York Academy of Sciences https://doi.org/10.1111/nyas.15106
- **Acesso:** `ABSTRACT_ONLY`
- **Síntese editorial (paráfrase):** A percepção das propriedades musicais mediou sua relação com o gosto; diferenças entre pessoas e estímulos tiveram peso importante.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-029. The association between liking, learning and creativity in music.

- **Referência:** Ioanna Zioga, Peter M. C. Harrison, Marcus Pearce, Joydeep Bhattacharya, Caroline Di Bernardi Luft (2024). Scientific reports https://doi.org/10.1038/s41598-024-70027-z
- **Acesso:** `FULL_TEXT`
- **Síntese editorial (paráfrase):** Após aprender uma gramática musical, participantes avaliaram notas e criaram composições; o estudo relaciona preferência, probabilidade e criatividade.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-056. Decomposing neural responses to melodic surprise in musicians and non-musicians: evidence for a hierarchy of predictions in the auditory system.

- **Referência:** D.R. Quiroga-Martinez, N.C. Hansen, A. Højlund, M. Pearce, E. Brattico, P. Vuust et al. (2020). NeuroImage https://doi.org/10.1016/j.neuroimage.2020.116816
- **Acesso:** `ABSTRACT_ONLY`
- **Síntese editorial (paráfrase):** O trabalho distingue adaptação sensorial de respostas preditivas mais tardias, alertando contra atribuir toda resposta à surpresa probabilística.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-062. Reward prediction tells us less than expected about musical pleasure

- **Referência:** Rémi de Fleurian, Peter M. C. Harrison, Marcus T. Pearce, David R. Quiroga-Martinez (2019). Proceedings of the National Academy of Sciences of the United States of America https://doi.org/10.1073/pnas.1913244116
- **Acesso:** `METADATA_ONLY`
- **Síntese editorial (paráfrase):** indisponível: método, dados e resultados não foram acessados e não são descritos aqui.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-021. The Effect of Previously Encountered Sensory Information on Neural Representations of Predictability: Evidence From Human EEG.

- **Referência:** Kaho Magami, Roberta Bianco, Edward Hall, Marcus Pearce, Maria Chait (2025). The European journal of neuroscience https://doi.org/10.1111/ejn.70300
- **Acesso:** `FULL_TEXT`
- **Síntese editorial (paráfrase):** Os experimentos de EEG sugerem que o uso do contexto anterior varia conforme a estrutura das interrupções nas sequências sonoras.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-003. Dynamic models for musical rhythm perception and coordination

- **Referência:** Edward W. Large, Iran Roman, Ji Chul Kim, Jonathan Cannon, Jesse K. Pazdera, Laurel J. Trainor et al. (2023). Frontiers in computational neuroscience https://doi.org/10.3389/fncom.2023.1151895
- **Acesso:** `FULL_TEXT` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** A revisão compara modelos dinâmicos, mecanismos neurais e inferência bayesiana para diferentes aspectos da percepção e coordenação rítmica.
- **Aplicação real no software:** Revisão que situa Kuramoto como hipótese
- **Dados do NeuralTune:** beats[], segments[]
- **Experimento para demonstrar benefício:** AUC de grooves: Kuramoto 0,51 contra padrão 1,00
- **Adaptação e limite:** Modelos descrevem percepção, não compatibilidade entre faixas

### NT-006. Neural entrainment to music is sensitive to melodic spectral complexity

- **Referência:** Indiana Wollman, Pablo Arias, Jean-Julien Aucouturier, Benjamin Morillon (2020). Journal of neurophysiology https://doi.org/10.1152/jn.00758.2018
- **Acesso:** `ABSTRACT_ONLY`
- **Síntese editorial (paráfrase):** A complexidade espectral modulou o acoplamento entre estímulo musical e atividade neural; esse acoplamento não equivale diretamente à emoção.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-014. Cortical and behavioral tracking of rhythm in music: Effects of pitch predictability, enjoyment, and expertise

- **Referência:** Anne Keitel, Claire Pelofi, Xinyi Guan, Emily Watson, Lucy Wight, Sarah Allen et al. (2025). Annals of the New York Academy of Sciences https://doi.org/10.1111/nyas.15315
- **Acesso:** `FULL_TEXT`
- **Síntese editorial (paráfrase):** O estudo combina EEG e acompanhamento manual do pulso para investigar como previsibilidade tonal, experiência e prazer afetam o processamento rítmico.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-041. Modeling enculturated bias in entrainment to rhythmic patterns

- **Referência:** Thomas Kaplan, Jonathan Cannon, Lorenzo Jamone, Marcus Pearce (2022). PLoS computational biology https://doi.org/10.1371/journal.pcbi.1010579
- **Acesso:** `FULL_TEXT` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** O modelo pPIPPET combina inferência de fase com escolha de padrões temporais, incorporando expectativas adquiridas em contextos culturais.
- **Aplicação real no software:** Mostra que modelagem rítmica bayesiana é alternativa a osciladores
- **Dados do NeuralTune:** beats[]
- **Experimento para demonstrar benefício:** Não implementado (pPIPPET exige padrões de entrada que o cliente não dá)
- **Adaptação e limite:** Exigiria adaptação profunda

### NT-068. Neural entrainment is associated with subjective groove and complexity for performed but not mechanical musical rhythms.

- **Referência:** Daniel J. Cameron, Ioanna Zioga, Job P. Lindsen, Marcus T. Pearce, Geraint A. Wiggins, Keith Potter et al. (2019). Experimental brain research https://doi.org/10.1007/s00221-019-05557-4
- **Acesso:** `FULL_TEXT` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** A relação entre sincronização neural e avaliações de groove ou complexidade dependeu de o ritmo ter execução humana ou temporização mecânica.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-081. A probabilistic model of meter perception: simulating enculturation

- **Referência:** Bastiaan van der Weij, Marcus T. Pearce, Henkjan Honing (2017). Frontiers in psychology https://doi.org/10.3389/fpsyg.2017.00824
- **Acesso:** `FULL_TEXT` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** O modelo infere métrica a partir de regularidades aprendidas e avalia como essa inferência ajuda a antecipar eventos rítmicos.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-082. Perception of rhythmic similarity is asymmetrical, and is influenced by musical training, expressive performance, and musical context.

- **Referência:** Daniel Cameron, Keith Potter, Geraint Wiggins, Marcus Pearce (2017).  https://doi.org/10.1163/22134468-00002085
- **Acesso:** `ABSTRACT_ONLY` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** Julgamentos de semelhança rítmica variaram com contexto, expressividade da execução e experiência musical.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-070. What makes rhythms hard to perform? An investigation using Steve Reich’s Clapping Music.

- **Referência:** Sam Duffy, Marcus Pearce (2018). PloS one https://doi.org/10.1371/journal.pone.0205847
- **Acesso:** `FULL_TEXT`
- **Síntese editorial (paráfrase):** Dados de um aplicativo baseado em padrões rítmicos permitem comparar hipóteses sobre dificuldade de execução e transições entre padrões.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-096. Nonlinear changes in the rhythm of European art music: Quantitative support for historical musicology.

- **Referência:** Niels Chr. Hansen, Makiko Sadakata, Marcus Pearce (2016).  https://doi.org/10.1525/mp.2016.33.4.414
- **Acesso:** `ABSTRACT_ONLY`
- **Síntese editorial (paráfrase):** A análise histórica de repertórios usa variação de durações e modelos não lineares para examinar mudanças no ritmo de música europeia.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-164. The temporal paradox of Hebbian learning and homeostatic plasticity

- **Referência:** Friedemann Zenke, Wulfram Gerstner, Surya Ganguli (2017). Current opinion in neurobiology https://doi.org/10.1016/j.conb.2017.03.015
- **Acesso:** `ABSTRACT_ONLY` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** Os autores discutem por que estabilização lenta pode ser insuficiente para conter instabilidades hebbianas e propõem compensação rápida adicional.
- **Aplicação real no software:** Necessidade de estabilização: decaimento e limites
- **Dados do NeuralTune:** Notas e reproduções
- **Experimento para demonstrar benefício:** Ablação da plasticidade
- **Adaptação e limite:** Sinapses; sem correspondência fisiológica

### NT-220. Learning input correlations through nonlinear temporally asymmetric Hebbian plasticity

- **Referência:** R. Gütig, R. Aharonov, S. Rotter, Haim Sompolinsky (2003). The Journal of neuroscience : the official journal of the Society for Neuroscience https://doi.org/10.1523/JNEUROSCI.23-09-03697.2003
- **Acesso:** `ABSTRACT_ONLY`
- **Síntese editorial (paráfrase):** Uma regra hebbiana temporalmente assimétrica e não linear procura equilibrar estabilidade sináptica e sensibilidade às correlações de entrada.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-269. Temporal whitening by power-law adaptation in neocortical neurons

- **Referência:** Christian Pozzorini, Richard Naud, Skander Mensi, Wulfram Gerstner (2013). Nature neuroscience https://doi.org/10.1038/nn.3431
- **Acesso:** `ABSTRACT_ONLY` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** Registros e modelagem relacionam adaptação em múltiplas escalas à redução de correlações temporais na atividade de neurônios corticais.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

### NT-273. Equilibrium properties of temporally asymmetric Hebbian plasticity

- **Referência:** Jonathan Rubin, Daniel D. Lee, H. Sompolinsky (2001). Physical review letters https://doi.org/10.1103/PhysRevLett.86.364
- **Acesso:** `ABSTRACT_ONLY` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** A análise teórica mostra que a forma de limitar os pesos altera o equilíbrio de regras hebbianas temporalmente assimétricas.
- **Aplicação real no software:** Regras limitadas: pesos com soft bounds
- **Dados do NeuralTune:** Notas e reproduções
- **Experimento para demonstrar benefício:** Propriedade de limitação em tests/Neuroscience.test.ts
- **Adaptação e limite:** Sinapses; usado só como argumento de estabilidade

### NT-139. Predictive coding networks for temporal prediction

- **Referência:** Beren Millidge, Mufeng Tang, Mahyar Osanlouy, Nicol S. Harper, Rafal Bogacz (2024). PLoS computational biology https://doi.org/10.1371/journal.pcbi.1011183
- **Acesso:** `FULL_TEXT` · entre as 20 com maior potencial
- **Síntese editorial (paráfrase):** O trabalho formula predição temporal em redes recorrentes com operações locais e compara seu comportamento à filtragem de Kalman.
- **Aplicação real no software:** nenhuma nesta versão.
- **Dados do NeuralTune:** não avaliado.
- **Experimento para demonstrar benefício:** não definido.
- **Adaptação e limite:** não avaliado.

