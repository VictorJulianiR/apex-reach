# Pesquisa: quality gates offline para Apex/SFDX

_Levantamento em 3 de agosto de 2026. Foram priorizados padrões ISO/IEC, artigos originais ou validações empíricas, documentação oficial da Salesforce e documentação/código do PMD._

## Conclusão executiva

A literatura pode transformar o analisador de um detector de código possivelmente morto em um **sistema de inteligência de manutenção**. O ganho não vem de inventar uma nota única de “qualidade”, mas de combinar três tipos de evidência:

1. **fatos estruturais reproduzíveis**, como tamanho, complexidade, duplicação, dependências, ciclos e alcançabilidade;
2. **história local**, como churn e regressões em relação ao próprio baseline;
3. **regras específicas da plataforma**, como operações limitadas dentro de loops, CRUD/FLS, sharing e qualidade básica dos testes Apex.

Esse conjunto consegue responder offline a perguntas de alto valor:

- onde a manutenção é mais arriscada;
- quais classes concentram simultaneamente tamanho, complexidade, acoplamento e mudança;
- quais mudanças novas pioraram o sistema;
- onde duplicação e ciclos ampliam o raio de impacto;
- quais testes apenas executam linhas e quais contêm sinais mínimos de verificação;
- quais achados são fatos, heurísticas ou inferências com incerteza.

O limite científico é igualmente importante: **métrica interna não é sinônimo de qualidade externa nem prova de defeito**. A ISO/IEC 25010 define um modelo de qualidade com nove características, mas não converte uma métrica isolada em uma nota universal ([ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html)). A ISO/IEC 25023, que define medidas para avaliar esse modelo, deliberadamente não fixa faixas universais: níveis de aceitação dependem do produto, categoria, integridade e necessidades dos usuários ([ISO/IEC 25023:2016](https://www.iso.org/standard/35747.html)).

Portanto, a recomendação é:

- usar thresholds conhecidos como **defaults iniciais explicáveis**, não como leis;
- bloquear principalmente **regressões em código novo** e problemas de alta certeza;
- tratar dívida legada como inventário priorizado, não como falha imediata do build;
- calibrar limites com o próprio repositório e corpora Apex públicos;
- manter as dimensões separadas no JSON e no relatório, sem escondê-las em um score composto.

## Base normativa

### ISO/IEC 25010: qualidade é multidimensional

O modelo SQuaRE organiza qualidade de produto em características e subcaracterísticas. Para este analisador, o mapeamento mais defensável é:

| Dimensão do analisador | Interpretação no modelo de qualidade |
|---|---|
| complexidade, tamanho, coesão e acoplamento | sinais de analisabilidade, modificabilidade, modularidade e testabilidade |
| ciclos e dependências arquiteturais | modularidade, analisabilidade e modificabilidade |
| duplicação | modificabilidade e reusabilidade, com ressalvas contextuais |
| regras de governor limits | eficiência de desempenho e confiabilidade |
| CRUD/FLS, sharing e injeção | segurança |
| testes e cobertura | evidência parcial de testabilidade e confiabilidade |
| código inalcançável | manutenibilidade e capacidade Apex recuperável |

Esse mapeamento é uma taxonomia para organizar evidências; não autoriza afirmar conformidade ISO apenas porque algumas métricas foram calculadas.

### ISO/IEC 5055: análise automática deve olhar violações arquiteturais e de código

A ISO/IEC 5055 padroniza medidas automáticas de qualidade estrutural para confiabilidade, segurança, eficiência de desempenho e manutenibilidade. As medidas são construídas a partir da detecção e contagem de violações de boas práticas arquiteturais e de código que podem causar risco operacional ou custo excessivo ([ISO/IEC 5055:2021](https://www.iso.org/contents/data/standard/08/06/80623.html)).

Aplicação prática: o produto deve combinar métricas contínuas com achados concretos. “Complexidade 17” é menos acionável que “complexidade 17, introduzida neste diff, em método com DML dentro de loop e sem teste que o alcance”.

### ISO/IEC/IEEE 15939: cada medida precisa servir a uma necessidade

A ISO/IEC/IEEE 15939 descreve um processo para identificar necessidades de informação, definir/selecionar medidas, aplicá-las e verificar se os resultados são válidos ([ISO/IEC/IEEE 15939:2017](https://www.iso.org/standard/71197.html)). Isso favorece um modelo em que cada gate declara:

- qual pergunta responde;
- como é calculado;
- em qual escopo se aplica;
- qual decisão pode tomar;
- quais limitações e fontes de incerteza possui.

Esse desenho evita o anti-padrão “colecionar métricas porque são populares”.

## Métricas e gates recomendados

### 1. Complexidade ciclomática

McCabe definiu a complexidade ciclomática a partir do grafo de fluxo de controle; para um grafo conectado, ela representa o número de caminhos linearmente independentes e pode ser calculada por `V(G) = E - N + 2` ([artigo original, 1976](https://www.cs.du.edu/~snarayan/sada/teaching/COMP3705/lecture/p1/mccabe.pdf)). Na forma operacional usual por método, inicia em 1 e soma pontos de decisão.

Valor para o app:

- é determinística e calculável diretamente do AST;
- localiza métodos que exigem mais casos de teste para cobrir decisões;
- permite explicar exatamente quais nós contribuíram para o valor;
- já possui implementação e convenções Apex no PMD.

O PMD para Apex reporta por padrão métodos com complexidade `>= 10` e classes cuja soma chega a `40`; sua documentação classifica 1–4 como baixa, 5–7 moderada, 8–10 alta e 11+ muito alta ([regra `CyclomaticComplexity`](https://pmd.github.io/pmd/pmd_rules_apex_design.html#cyclomaticcomplexity)). Esses números são bons **defaults de compatibilidade**, mas o próprio trabalho sobre derivação de thresholds observa que o 10 de McCabe veio de experiência em um contexto particular e não foi proposto como universal ([Alves, Ypma e Visser, 2010](https://webarchive.di.uminho.pt/wiki.di.uminho.pt/twiki/pub/Personal/Joost/PublicationList/AlvesYpmaVisserICSM2010.pdf)).

Gate recomendado:

- `warn` em método existente `>= 10`;
- `fail` quando código novo cria método `>= 15` ou aumenta um método que já estava acima do limite;
- `fail` em salto grande configurável, por exemplo `delta >= 5` no mesmo método;
- não falhar uma base legada inteira apenas porque já contém métodos acima do default.

O output deve guardar tanto o valor quanto a decomposição por decisão/linha. Isso torna o resultado auditável e protege contra diferenças entre variantes da métrica, por exemplo se operadores booleanos contam ou não.

### 2. Complexidade cognitiva

Complexidade cognitiva foi criada pela Sonar para aproximar dificuldade de compreensão: penaliza quebras de fluxo e adiciona peso por aninhamento, sem punir igualmente todos os atalhos sintáticos ([white paper da Sonar](https://www.sonarsource.com/resources/cognitive-complexity/)). O PMD implementa a métrica para Apex e usa defaults de `15` por método e `50` por classe ([regra `CognitiveComplexity`](https://pmd.github.io/pmd/pmd_rules_apex_design.html#cognitivecomplexity)).

Há evidência empírica melhor que simples opinião de ferramenta: uma meta-análise com aproximadamente 24 mil avaliações de compreensão sobre 427 trechos encontrou correlação positiva com tempo de compreensão e avaliações subjetivas, mas resultados mistos para correção das tarefas e medidas fisiológicas ([Muñoz Barón, Wyrich e Wagner, 2020](https://doi.org/10.1145/3382494.3410636)).

Gate recomendado:

- usar `15` como `warn` inicial compatível com PMD;
- bloquear regressões em código novo, não todo legado;
- mostrar complexidade ciclomática e cognitiva lado a lado, porque medem aspectos diferentes;
- nunca traduzir o valor diretamente em probabilidade de defeito.

Prioridade: **alta**. Para revisão humana, tende a ser mais útil que ciclomática isolada porque explicita aninhamento e fluxo, mas deve continuar sendo uma heurística de compreensibilidade.

### 3. Tamanho: NCSS, linhas e superfície pública

Tamanho precisa ser medido porque confunde outras métricas. Um estudo clássico mostrou que, após controlar tamanho da classe, associações entre várias métricas OO e fault-proneness desapareceram no sistema estudado, colocando em dúvida interpretações causais de métricas correlacionadas com tamanho ([El Emam et al., 2001](https://doi.org/10.1109/32.935855)).

Recomendação:

- calcular `physicalLines`, `logicalLines/NCSS`, bytes/caracteres Apex e contagens de métodos/campos;
- nunca apresentar complexidade, WMC, RFC, CBO ou LCOM sem tamanho no mesmo registro;
- normalizar rankings quando apropriado, mas preservar os valores brutos;
- separar classe de produção, teste, trigger, controller, DTO e generated code.

O PMD Apex adota por padrão NCSS `40` para método e `500` para classe, superfície pública `20`, lista de parâmetros `4` e campos `15` ([regras de design Apex](https://pmd.github.io/pmd/pmd_rules_apex_design.html)). São defaults operacionais úteis, mas não evidência de que 39 é “bom” e 40 é “ruim”.

Gate recomendado: `warn` absoluto + `fail` apenas em regressão de código novo ou aumento acima do orçamento acordado.

### 4. Métricas CK: acoplamento, resposta, herança, coesão e carga da classe

Chidamber e Kemerer propuseram uma suíte de seis métricas de design OO: WMC, DIT, NOC, CBO, RFC e LCOM ([artigo original](https://doi.org/10.1109/32.295895)). Um estudo empírico posterior em oito sistemas C++ encontrou que várias dessas métricas eram úteis para prever classes propensas a falhas naquele contexto ([Basili, Briand e Melo, 1996](https://www.cs.umd.edu/users/basili/publications/journals/J62.pdf)). A evidência não justifica transportar coeficientes ou thresholds diretamente para Apex; estudos cross-project mostram que modelos de defeito raramente transferem bem sem compatibilidade mensurada de processo e dados ([Zimmermann et al., 2009](https://thomas-zimmermann.com/publications/files/zimmermann-esecfse-2009.pdf)).

Definições a versionar no app:

| Métrica | Definição operacional proposta para Apex | Uso recomendado |
|---|---|---|
| `WMC` | soma da complexidade ciclomática dos métodos; guardar também `WMC_1`, que é apenas a contagem de métodos | carga de decisão da classe |
| `DIT` | maior caminho local de herança conhecido até uma raiz | sinal de profundidade; baixa confiança quando superclasse está fora do checkout |
| `NOC` | número de filhos diretos conhecidos no universo analisado | impacto potencial de mudança; nunca penalizar isoladamente |
| `CBO` | número de tipos distintos aos quais a classe se acopla, com tipos de aresta separados | acoplamento e raio de impacto |
| `RFC` | métodos locais potencialmente executáveis em resposta mais métodos distintos chamados diretamente | superfície comportamental e esforço de teste |
| `LCOM` | publicar explicitamente a variante, inicialmente `LCOM1`: pares de métodos sem campos compartilhados menos pares com campos compartilhados, truncado em zero | indício de múltiplas responsabilidades |

Cuidados específicos:

- CBO não deve misturar `extends`, assinatura, construção, chamada, SOQL/SObject e referência por metadata sem preservar o tipo da aresta;
- DIT/NOC ficam incompletos com managed packages e dependências ausentes;
- métodos estáticos utilitários e DTOs podem ter LCOM “ruim” sem problema de design;
- `global`/`public` em Apex pode refletir exigência de plataforma, package ou integração;
- triggers e test classes precisam de perfis próprios;
- tamanho deve entrar no relatório e em qualquer modelo estatístico.

Gate recomendado: CK começa como `info/warn` e ranking. Depois de baseline local, pode bloquear **novas regressões extremas**, preferencialmente por percentil e delta. Não usar números universais encontrados em blogs.

### 5. Maintainability Index: somente diagnóstico secundário

O Maintainability Index original combina volume de Halstead, complexidade ciclomática e linhas de código em uma regressão ([Oman e Hagemeister, 1992](https://doi.org/10.1109/ICSM.1992.242525)). A variante atual do Visual Studio usa:

```text
MI = max(0, (171 - 5.2 ln(HalsteadVolume) - 0.23 CC - 16.2 ln(LOC)) * 100 / 171)
```

e faixas 0–9, 10–19 e 20–100 ([documentação da Microsoft](https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-maintainability-index-range-and-meaning)). Isso por si só demonstra um problema de comparabilidade: há variantes da fórmula, escalas e termos de comentário diferentes.

Além disso, uma nota composta esconde a causa do problema e mistura métricas fortemente relacionadas a tamanho. O trabalho que revisitou o índice destaca que uma nota única dificulta root-cause analysis: uma pontuação baixa não diz ao mantenedor qual mudança executar ([Kuipers e Visser, 2007](https://citeseerx.ist.psu.edu/document?doi=56d36e4adaa50e51632df197b7f01329015f9655&repid=rep1&type=pdf)).

Recomendação:

- não implementar MI no primeiro roadmap;
- se implementado, declarar `formulaId`, versão, termos e escala;
- nunca usá-lo como gate bloqueante ou score principal;
- sempre exibir os componentes que produziram o índice.

### 6. Churn e hotspots

Métricas estáticas dizem onde o código parece difícil; histórico diz onde o time realmente mexe. Em um estudo do Windows Server 2003, medidas **relativas** de churn foram preditores melhores de densidade de defeitos que churn absoluto, com o modelo daquele caso discriminando binários propensos/não propensos a falhas com 89% de acurácia ([Nagappan e Ball, 2005](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/icse05churn.pdf)). Outro estudo em seis grandes projetos open source encontrou que complexidade do processo de mudanças superou preditores históricos como número de mudanças e falhas anteriores naquele conjunto ([Hassan, 2009](https://doi.org/10.1109/ICSE.2009.5070510)).

Implementação offline via Git:

- commits que tocaram arquivo/classe em janelas de 90, 180 e 365 dias;
- linhas adicionadas/removidas e churn relativo a NCSS/tamanho;
- número de autores distintos, com opção de anonimizar/hash;
- idade e data da última mudança;
- co-change entre classes;
- churn corretivo somente se houver uma convenção local confiável para identificar bugs.

O principal produto deve ser um ranking de **hotspots**, não um gate absoluto:

```text
hotspot = percentile(churn_relativo) × percentile(risco_estrutural)
```

O `risco_estrutural` deve continuar decomponível; por exemplo, máximo ou combinação versionada de complexidade cognitiva, tamanho, CBO e ciclos. Classes difíceis mas estáveis podem não merecer prioridade imediata; classes simples e muito alteradas merecem observação; a interseção é o alvo de revisão/refatoração.

Gate recomendado: bloquear apenas regressões novas em hotspots já críticos ou aumento abrupto de risco; churn isolado é informação, não falha.

### 7. Duplicação

O Salesforce Code Analyzer já oferece CPD para Apex, Visualforce, HTML, JavaScript, TypeScript e XML. O default é `100` tokens mínimos por bloco duplicado ([documentação oficial do engine CPD](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/engine-cpd.html)). Essa integração é preferível a criar um detector próprio no início.

A evidência é matizada. Um estudo de sistemas comerciais e open source encontrou mudanças inconsistentes frequentes e defeitos induzidos por mudanças inconsistentes em clones ([Juergens et al., 2009](https://doi.org/10.1109/ICSE.2009.5070547)). Entretanto, outro estudo identificou usos intencionais em que clonagem funcionava como ferramenta de engenharia, e não como dano universal ([Kapser e Godfrey, 2008](https://doi.org/10.1007/s10664-008-9076-6)).

Gate recomendado:

- `warn` para clones existentes;
- `fail` para **nova duplicação** acima do mínimo configurado;
- prioridade máxima para clones que mudaram de forma inconsistente, pertencem a hotspots ou contêm regra de negócio/segurança;
- permitir suppressions justificadas e com validade.

Métricas úteis: tokens/NCSS duplicados, percentual do código produtivo duplicado, número de grupos, dispersão entre módulos e divergência histórica dos membros do clone.

### 8. Cobertura e qualidade de testes

Salesforce exige pelo menos 75% de cobertura Apex para deploy de produção e que todo trigger tenha alguma cobertura. A própria documentação oficial diz para **não focar no percentual**, mas cobrir casos positivos, negativos, bulk e single-record ([Application Unit Tests](https://help.salesforce.com/s/articleView?id=sf.code_run_tests.htm&language=en_US&type=5)). A Salesforce também afirma explicitamente que 100% de cobertura não prova que o código funciona e recomenda assertions significativas ([Apex Best Practices](https://developer.salesforce.com/blogs/2015/01/apex-best-practices-15-apex-commandments)). Fora do ecossistema, um estudo ICSE controlando tamanho da suíte encontrou que cobertura não era fortemente correlacionada à efetividade da suíte ([Inozemtseva e Holmes, 2014](https://cs.uwaterloo.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf)).

Offline, sem executar na org, o app pode medir:

- test classes e test methods;
- presença, quantidade e localização de assertions;
- test methods sem assertion alcançável;
- uso de `seeAllData=true`;
- uso de `Test.startTest/stopTest` quando há async/limites;
- mapeamento teste → produção pelo grafo de chamadas;
- classes produtivas sem qualquer caminho vindo de teste;
- branches/decisões de alta complexidade sem evidência estática de cenário correspondente, marcadas como heurística;
- concentração: um único teste cobrindo grande componente é mais frágil que cobertura distribuída, mas isso não deve ser gate sem execução.

O PMD já fornece `ApexUnitTestClassShouldHaveAsserts`, suporte a padrões customizados de assertion, `ApexUnitTestShouldNotUseSeeAllDataTrue` e outras regras Apex ([PMD Best Practices](https://pmd.github.io/pmd/pmd_rules_apex_bestpractices.html)).

Gate offline recomendado:

- `fail` em novo test method sem assertion reconhecida, com configuração para helpers próprios;
- `fail` em novo `seeAllData=true`, salvo suppression justificada;
- `warn` em produção nova sem incoming path de teste;
- cobertura percentual só entra como evidência `observed` quando importada de resultado de teste/Tooling API, nunca inferida do AST.

Mutation testing seria um estágio posterior e não puramente estático. Há evidência de que testes que matam mutantes se relacionam a falhas reais e levam a melhorias da suíte em escala, mas executar mutantes Apex exige custo de deploy/compilação/teste em uma org ([Petrović et al., 2021](https://research.google/pubs/long-term-effects-of-mutation-testing/)). Portanto, deve ser um plugin opcional conectado à org, não requisito do núcleo offline.

### 9. Ciclos e arquitetura

O grafo já necessário para reachability fornece quase de graça:

- strongly connected components (SCCs);
- ciclos de classe e de módulo;
- fan-in/fan-out;
- centralidade e raio de impacto;
- dependências cruzando boundaries declarados;
- co-change que não corresponde à estrutura declarada.

Há evidência empírica de risco: um estudo de seis aplicações encontrou concentração de defeitos e componentes defeituosos em componentes dentro de ciclos ou dependentes deles, embora os autores ressaltem limites de generalização ([Oyetoyan et al., 2013](https://doi.org/10.1016/j.jss.2013.07.039)). Estudos de modularização em larga escala reforçam que dependências intermodulares, herança, associações e chamadas podem dificultar manutenção mesmo quando classes isoladas parecem limpas ([Sarkar, Kak e Rama, 2008](https://engineering.purdue.edu/RVL/Publications/Sarkar08Metrics.pdf)).

Gate recomendado:

- `fail` para **novo ciclo entre módulos/camadas**;
- `warn` para novo ciclo entre classes do mesmo módulo;
- inventariar ciclos legados por SCC, tamanho, número/tipo de arestas, churn e entrada/saída;
- priorizar ciclos em hotspots, não o ciclo mais longo por si só;
- permitir políticas arquiteturais declarativas, por exemplo `trigger -> handler -> service -> selector`, e detectar arestas proibidas.

Para Apex/SFDX, “módulo” não deve ser inferido apenas de pasta. O usuário precisa poder declarar boundaries por package directory, namespace, prefixo, tags/config ou arquivo de política.

### 10. Regras específicas de Salesforce: maior retorno prático

Apesar do foco acadêmico, os gates com melhor relação sinal/ação provavelmente serão regras específicas da plataforma. A Salesforce distribui o Code Analyzer com PMD, CPD e Graph Engine, e permite regras customizadas e severidade configurável ([documentação do PMD engine](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/engine-pmd.html)).

Prioridade de integração:

- SOQL, SOSL, DML, email, approval ou enqueue/schedule dentro de loops: risco direto de governor limit; o PMD Apex fornece `OperationWithLimitsInLoop` ([regra oficial](https://pmd.github.io/pmd/pmd_rules_apex_performance.html#operationwithlimitsinloop));
- chamadas caras de schema dentro de loops: `OperationWithHighCostInLoop`;
- CRUD/FLS e sharing: `ApexCRUDViolation` e `ApexSharingViolations`, preservando os falsos positivos e customizações documentados pelo próprio PMD ([regras de segurança](https://pmd.github.io/pmd/pmd_rules_apex_security.html));
- SOQL injection, XSS, crypto inseguro, endpoint inseguro e redirect aberto;
- lógica em trigger, múltiplos triggers por objeto/evento, recursão e handlers sem bulkificação;
- queries não seletivas ou sem limites somente quando houver evidência suficiente; seletividade real pode depender de dados/índices da org.

Esses achados devem entrar no mesmo modelo de evidência do analisador, em vez de aparecer como um relatório PMD separado e desconectado.

## Thresholds: política defensável

### Por que não existe número mágico universal

Métricas de software frequentemente têm distribuições assimétricas/heavy-tailed. Métodos de thresholds relativos assumem explicitamente que é natural existir uma cauda pequena de entidades acima do limite e recomendam avaliar a parcela do volume de código que respeita o threshold, não exigir que 100% das entidades obedeçam ([Oliveira, Valente e Lima, 2014](https://homepages.dcc.ufmg.br/~mtov/pub/2014_csmrwcre_thresholds.pdf)).

Além disso:

- thresholds históricos vieram de linguagens e contextos diferentes;
- Apex tem entry points, limites e metadata próprios;
- classes geradas, DTOs, controllers, handlers, tests e serviços têm perfis distintos;
- tamanho confunde muitas métricas;
- modelos de defeito não transferem automaticamente entre projetos.

### Modelo recomendado: defaults + baseline + ratchet

Cada regra pode ter três camadas:

1. **default de referência**: por exemplo, PMD Apex `CC >= 10`, cognitiva `>= 15`, NCSS de método `>= 40`;
2. **baseline do projeto**: distribuição por tipo de artefato, com mediana, P75, P90, P95 e P99;
3. **gate diferencial**: impede que código alterado crie nova violação, agrave uma existente ou ultrapasse um budget.

Exemplo:

```yaml
profile: apex-quality/v1
baseline: .apex-quality/baseline-v1.json
gates:
  cognitive-complexity:
    legacy: warn
    newCode:
      warnAt: 15
      failAt: 20
      failOnIncreaseAbove: 15
  dependency-cycle:
    legacy: warn
    newInterModuleCycle: fail
  duplication:
    legacy: warn
    newTokens: fail
```

Um baseline não deve silenciar dívida: ele congela a quantidade/localização conhecida para que a dívida não cresça. Reduzir dívida atualiza o baseline para baixo; piorar exige justificativa explícita.

## Modelo versionado de quality gate

### Separar fatos, findings e policy

O contrato de dados deve impedir que cálculo e julgamento virem a mesma coisa:

- `facts`: contagens AST, arestas do grafo, spans duplicados, decisões de fluxo, revisões Git e localizações exatas;
- `findings`: interpretação versionada desses fatos, com severidade, confiança, limitações e explicação;
- `policy`: decisão configurável do cliente sobre quando um finding passa, avisa, exige revisão ou falha.

Essa separação permite recalibrar um threshold sem reanalisar oito milhões de linhas, comparar políticas sobre o mesmo snapshot e auditar por que uma decisão mudou.

O relatório final pode organizar os achados em três lanes independentes:

1. `hard_deterministic`: parser, segurança/governor limits de alta confiança, novos ciclos e nova duplicação;
2. `maintainability_review`: complexidade, tamanho, CK, churn, hotspots e dívida legada;
3. `capacity_recovery`: alcançabilidade, tamanho recuperável e risco dinâmico/metadata.

Uma lane não substitui a outra: uma classe inalcançável pode ser bem escrita; uma classe alcançável pode ser o maior hotspot do sistema.

### Estados

Todo gate deve produzir um destes estados:

- `pass`: evidência suficiente e condição satisfeita;
- `warn`: risco/revisão, sem bloqueio;
- `fail`: condição bloqueante violada;
- `indeterminate`: faltam dados ou confiança para decidir;
- `not_applicable`: regra não se aplica ao artefato.

`indeterminate` é essencial. Parser parcial, dependência managed ausente, metadata incompleta ou ausência de histórico não podem virar `pass` silencioso.

### Registro mínimo por achado

```json
{
  "schemaVersion": "apex-quality-result/1.0",
  "analyzerVersion": "0.2.0",
  "profile": { "id": "apex-quality", "version": "1.0.0" },
  "source": { "revision": "git-sha", "scope": "all", "baselineRevision": "git-sha" },
  "finding": {
    "ruleId": "complexity.cognitive.method",
    "ruleVersion": "1.0.0",
    "status": "warn",
    "severity": "medium",
    "confidence": "high",
    "subject": "ClassName.method(Type)",
    "value": 18,
    "unit": "points",
    "threshold": { "operator": ">=", "value": 15, "origin": "pmd-default" },
    "baseline": { "previous": 12, "delta": 6, "projectPercentile": 97 },
    "evidence": [
      { "file": "force-app/main/default/classes/ClassName.cls", "line": 42, "kind": "nested-if" }
    ],
    "limitations": [],
    "remediation": "review-or-extract-decision-block"
  }
}
```

### Confiança

- `high`: AST completo, símbolo resolvido, regra determinística;
- `medium`: inferência local razoável, mas há resolução dinâmica/externa possível;
- `low`: correspondência textual, metadata incompleta ou heurística;
- `unknown`: análise não conseguiu estabelecer validade.

Severidade e confiança são eixos independentes: uma possível falha de segurança pode ter severidade alta e confiança média; uma complexidade precisamente calculada pode ter confiança alta e severidade baixa.

### Evidência e proveniência

Cada métrica/achado precisa registrar:

- fórmula/algoritmo e versão;
- parser/engine e versão;
- arquivo, linhas e nós AST relevantes;
- escopo analisado e exclusões;
- baseline e revisão Git;
- threshold e sua origem (`standard`, `tool-default`, `project-baseline`, `policy`);
- limitações;
- suppression, com motivo, autor/owner e expiração.

A própria Salesforce recomenda motivo e limite máximo para suppressions no Code Analyzer, para impedir que dívida suprimida cresça sem controle ([documentação de suppressions](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/suppress-violations.html)). O modelo local deve acrescentar `expiresAt` e, opcionalmente, issue/ticket.

## Roadmap offline priorizado

### Fase 1 — complexidade, tamanho e regras Apex de alto sinal

Entrega:

- complexidade ciclomática e cognitiva por método/classe;
- NCSS, linhas, métodos, campos, parâmetros e superfície pública;
- import/normalização do output PMD para regras de governor limits, testes e segurança;
- decomposition/evidence por linha;
- profile versionado e gate diferencial.

Por quê: baixo custo relativo, alta explicabilidade e suporte Apex já existente. Evita reimplementar imediatamente regras maduras.

### Fase 2 — duplicação e arquitetura sobre o grafo existente

Entrega:

- CPD integrado, grupos e percentual de duplicação;
- SCCs/ciclos, fan-in/fan-out e centralidade;
- boundaries configuráveis e arestas proibidas;
- CBO e RFC com tipos de aresta preservados;
- “novo ciclo” e “nova duplicação” como gates.

Por quê: reutiliza infraestrutura de parsing/grafo e conecta risco local ao raio de impacto.

### Fase 3 — Git mining e hotspots

Entrega:

- churn relativo, frequência, autores, idade, co-change;
- ranking hotspot = mudança × risco estrutural;
- comparação por revisão e janelas temporais;
- anonimização de identidade e modo snapshot sem `.git`.

Por quê: transforma inventário estático em priorização econômica. Não há threshold universal; o próprio projeto fornece o baseline.

### Fase 4 — qualidade estática dos testes

Entrega:

- assertions, `seeAllData`, helpers customizados;
- grafo teste → produção e produção sem caminho de teste;
- import opcional de cobertura em JSON/JUnit/Tooling API;
- cruzamento de complexidade decisória com linhas/branches cobertos quando dados existirem.

Por quê: cobertura isolada é fraca; o cruzamento de execução, assertions, cenários e risco estrutural produz evidência melhor.

### Fase 5 — calibração e modelos locais

Entrega:

- benchmark em Apex Recipes, NPSP, EDA e histórico do próprio cliente;
- distribuição por arquétipo Apex;
- thresholds relativos por volume/percentil;
- validação manual amostral e medição de precisão/recall dos achados;
- modelo de defect-proneness apenas se houver labels locais confiáveis.

Por quê: literatura sobre defect prediction dá suporte a priorização, não a importar um modelo universal. Qualquer modelo deve ser local, calibrado, explicável e avaliado fora da amostra.

## O que não fazer

- não gerar uma nota única de 0–100 e chamá-la de “qualidade do sistema”;
- não multiplicar métricas arbitrariamente sem preservar os componentes;
- não reprovar todo legado no primeiro scan;
- não declarar classe defeituosa porque está acima de um threshold;
- não comparar repositórios em linguagens/perfis diferentes sem normalização;
- não misturar produção, testes, generated code e managed packages;
- não tratar ausência de evidência como evidência de ausência;
- não usar LLM para calcular ou alterar fatos do gate.

O LLM pode explicar clusters, redigir narrativa e sugerir ordem de investigação. O JSON determinístico deve continuar sendo a fonte de verdade.

## Síntese de prioridade e força da evidência

| Capacidade | Valor para Apex | Evidência | Política inicial |
|---|---:|---|---|
| regras de governor limits/segurança | muito alto | plataforma + ferramenta oficial | fail em código novo, com confiança/suppression |
| complexidade cognitiva/ciclomática | alto | teoria + validação empírica parcial + PMD Apex | defaults + ratchet |
| tamanho/NCSS | alto | medida objetiva e controle de confundimento | contexto/budget, não score isolado |
| ciclos/arquitetura | alto | estudos empíricos + grafo já disponível | fail em ciclo novo entre módulos |
| duplicação | alto | evidência empírica mista; CPD oficial | fail em duplicação nova; revisar legado |
| churn/hotspots | muito alto para priorização | estudos empíricos de processo | ranking relativo, sem threshold universal |
| CBO/RFC/WMC | médio-alto | CK + validações contextuais | ranking e regressão; calibrar localmente |
| DIT/NOC/LCOM | médio/contextual | CK; sensíveis a perfil e universo | informativo antes de calibrar |
| cobertura | necessária, insuficiente | requisito Salesforce + evidência de limitações | importar como evidência, nunca como prova |
| Maintainability Index | baixo como gate | histórico, mas agregado e opaco | diagnóstico opcional, nunca bloqueante |
| defect prediction universal | baixo/arriscado | baixa transferibilidade cross-project | somente modelo local validado |

## Recomendação final

O maior power-up da literatura é mudar a unidade de decisão de “métrica acima do limite” para **evidência contextualizada de risco e regressão**. O primeiro release melhorado deveria juntar:

1. complexidade cognitiva/ciclomática e NCSS;
2. regras Salesforce de alto sinal via PMD;
3. CPD;
4. ciclos e acoplamento usando o grafo já construído;
5. baseline versionado com gate apenas sobre código novo;
6. hotspots Git na fase seguinte.

Isso já permite um relatório muito mais forte: não apenas “há 20 classes grandes”, mas “estas cinco classes concentram 62% do churn recente, estão no mesmo ciclo, têm métodos acima dos defaults Apex, duplicação divergente e baixa evidência de testes”. Essa conclusão continua verificável sem enviar uma única linha do cliente para um modelo externo.
