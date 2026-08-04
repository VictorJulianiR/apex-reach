# Pesquisa: análise estática para recuperar capacidade Apex em projetos SFDX

> **Atualização de implementação (v0.2.0):** a decisão final do produto substitui a recomendação inicial de confiança por candidato descrita abaixo. No universo fechado declarado pelo usuário, alcançabilidade é binária (`production`, `test-only`, `unreachable`). Anotações e visibilidade são exposição, não chamadas. Lacunas reais, como `Type.forName` computado em um caminho de produção, bloqueiam a conclusão inteira e apontam arquivo/linha; não viram probabilidade aplicada ao candidato. Consulte o ADR 0001 e `docs/validation.md` para o comportamento validado.

_Levantamento em 3 de agosto de 2026. Fontes priorizadas: documentação e código/repositórios mantidos pela Salesforce, além da documentação primária do PMD quando aplicável._

## Recomendação executiva

A ferramenta deve construir um **grafo de dependências e alcançabilidade** a partir de AST, Apex e metadata SFDX. O resultado não deve ser um booleano “usado/não usado”, mas uma classificação com evidências:

- `reachable`: alcançável a partir de uma raiz de produção;
- `platform_entry_point`: chamado pela plataforma ou externamente, mesmo sem chamada Apex local;
- `candidate_unreachable`: não alcançável no universo analisado;
- `dynamic_resolution_risk`: há resolução por string/configuração ou metadata ausente;
- `test_only_reachable`: só há caminho a partir de testes.

O relatório pode usar LLM para explicar e agrupar achados, mas a descoberta, o tamanho estimado e todas as evidências devem sair do analisador determinístico.

## O que o limite de Apex realmente mede

O limite padrão publicado é **6 MB de Apex por org**; uma classe ou trigger pode ter até 1 milhão de caracteres. Código de managed packages 1GP/2GP e classes definidas com `@isTest` não entram no teto de 6 MB. O limite pode ser aumentado por suporte, mas a própria documentação recomenda corrigir o uso antes disso ([Salesforce Developer Limits and Allocations Quick Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf)).

Consequências para a ferramenta:

1. bytes, linhas ou caracteres brutos de `.cls`/`.trigger` são apenas uma estimativa offline;
2. testes devem ser identificados separadamente — eles ajudam a provar referências, mas não representam economia no teto;
3. namespace e estado de gerenciamento importam, pois código de managed package tem outra contabilização;
4. remover um método só gera economia depois que a classe for alterada/deployada; portanto, a unidade de recomendação deve ser classe/trigger, com métodos candidatos como explicação interna.

Quando houver acesso opcional à org, a medição por artefato deve vir de `LengthWithoutComments` nos objetos Tooling API `ApexClass` e `ApexTrigger`, preservando também `NamespacePrefix` e `ManageableState` para explicar exclusões ([ApexClass](https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_apexclass.htm), [ApexTrigger](https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_apextrigger.htm), [Tooling API PDF](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_tooling.pdf)). O REST Limits resource e `sf org list limits` são bons para capturar os limites que a org expõe, mas a lista depende da org/edição; a implementação não deve presumir uma chave de Apex sempre presente ([Limits resource](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_limits.htm), [comando CLI](https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_org_list_limits.html)).

## Parser e representação

Não foi encontrada uma gramática Apex standalone oficial, documentada como API pública estável. A rota pública mantida pela Salesforce é o Salesforce Code Analyzer v5 com PMD:

- o engine PMD analisa `.cls`, `.trigger`, Visualforce e XML, suporta regras Java e XPath sobre o AST ([documentação do engine PMD](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/engine-pmd.html));
- `sf code-analyzer ast-dump` exporta AST em JSON ou XML para Apex, Visualforce, HTML, XML e JavaScript ([referência CLI](https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_code-analyzer.html));
- o Code Analyzer é oficial e open source ([repositório](https://github.com/forcedotcom/code-analyzer)).

Recomendação de implementação: criar uma interface interna de parser. Usar `ast-dump` para fixtures, descoberta do AST e validação de compatibilidade; para milhões de linhas, benchmarkar o custo e preferir integração PMD em processo/lotes se invocar um processo por arquivo for caro. Regex deve ser reservada para formatos simples e sinais dinâmicos, nunca para interpretar Apex.

O Salesforce Graph Engine já faz análise interprocedural e fornece uma boa taxonomia de entry points, mas não deve ser o motor único de dead-code. A documentação lista limitações, inclusive ausência de suporte a triggers e anonymous Apex em sua análise ([como trabalhar com SFGE](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/engine-sfge-work-with.html)).

## Grafo mínimo

### Nós

- classes, interfaces, enums, inner types, constructors e métodos Apex;
- triggers e o objeto/eventos que os disparam;
- páginas/componentes Visualforce;
- bundles Aura e LWC;
- Flows e demais componentes de metadata que referenciem Apex;
- nós “externo/configuração/runtime” quando o alvo não puder ser resolvido localmente.

### Arestas extraídas do Apex

- chamadas de método e constructor;
- `new`, referências `.class`, tipos de parâmetros/retornos/campos e casts;
- `extends`, `implements` e overrides;
- acesso a propriedades e initializers estáticos;
- chamada de trigger para handler;
- literais resolvíveis em `Type.forName(...)` e padrões equivalentes, mantendo aresta “dinâmica” quando o valor não é literal.

### Arestas fora do Apex

- **LWC:** imports `@salesforce/apex/[namespace.]Class.method` são arestas exatas de classe e método ([documentação oficial](https://developer.salesforce.com/docs/platform/lwc/guide/apex-import-method.html));
- **Aura:** `aura:component controller="namespace.Class"` referencia a classe server-side; o bundle JavaScript chama suas actions ([referência do atributo `controller`](https://developer.salesforce.com/docs/platform/lightning-component-reference/guide/aura-component.html));
- **Visualforce:** `controller`, `extensions` e expressões/action bindings devem gerar arestas para classes, propriedades e métodos;
- **Flow:** `actionCalls` em `*.flow-meta.xml` devem ser associados ao método `@InvocableMethod`; métodos invocáveis são expostos a Flow e outros consumidores da plataforma ([exemplo oficial](https://developer.salesforce.com/docs/platform/lwc/guide/use-flow-custom-property-editor-action-example.html));
- **metadata/configuração:** procurar nomes de classes em Custom Metadata records, Custom Settings exportados, labels, quick actions e outros XMLs. Correspondência textual aqui é evidência dinâmica, não prova de chamada.

A `MetadataComponentDependency` da Tooling API pode enriquecer a análise de uma org implantada, mas foi introduzida como API beta/pilot e tem cobertura/limitações próprias. Deve ser evidência adicional, nunca a única fonte do grafo ([anúncio oficial e exemplo de grafo](https://developer.salesforce.com/blogs/2020/01/learn-moar-with-spring-20-release-highlights-for-developers), [objeto Tooling API](https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_metadatacomponentdependency.htm)).

## Raízes que impedem um falso “morto”

O conjunto inicial deve incluir:

- todos os triggers;
- métodos `@AuraEnabled`, `@InvocableMethod`, `@NamespaceAccessible`, `@RemoteAction`;
- métodos `global`, métodos públicos de Visualforce controllers e métodos que retornam `PageReference`;
- `Messaging.InboundEmailHandler.handleInboundEmail()`;
- Apex REST (`@RestResource` e `@HttpGet/@HttpPost/@HttpPut/@HttpPatch/@HttpDelete`) e SOAP (`webservice`);
- callbacks/implementações invocados pela plataforma, incluindo `Queueable`, `Schedulable`, `Batchable` e seus métodos de contrato;
- entry points async, como `@future`;
- classes/métodos referenciados por LWC, Aura, Visualforce, Flow e metadata;
- APIs públicas/globais potencialmente consumidas fora do repositório.

A lista de entry points que o próprio Graph Engine usa confirma boa parte desse conjunto ([regras SFGE](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/rules-sfge.html)). Triggers são iniciados por eventos DML da plataforma, não por uma chamada de método local ([visão geral oficial de Apex e triggers](https://developer.salesforce.com/docs/platform/webconsole/guide/work-with-code.html)).

Testes não devem ser raízes de produção. Em vez disso, a ferramenta deve manter duas alcançabilidades: `production` e `tests`. Isso permite distinguir “sem uso” de “usado só por teste”, sem contabilizar economia inexistente de uma classe `@isTest`.

## Casos em que análise estática não prova ausência de uso

Dynamic Apex permite remover deliberadamente dependências de compile-time: `System.Type`, `Type.forName()` e instanciação a partir de nomes guardados em Custom Metadata são padrões oficiais ([exemplo de injeção de dependência por runtime](https://developer.salesforce.com/blogs/2019/07/breaking-runtime-dependencies-with-dependency-injection)). Outros sinais relevantes:

- nomes de classes/métodos vindos de dados, Custom Settings, Custom Metadata, labels ou payloads;
- `System.Callable`/dispatch por action string;
- `JSON.deserialize` e casts para tipos construídos dinamicamente;
- consumidores externos de Apex REST, SOAP, `global` e APIs de pacote;
- jobs já agendados/na fila na org;
- componentes existentes na org, mas ausentes do checkout analisado.

Por isso, o analisador deve registrar `dynamic_resolution_risk` e a evidência (arquivo, linha, expressão e possível alvo), reduzindo a confiança. Uma classe sem incoming edge estático só vira `candidate_unreachable`, nunca “segura para apagar”.

## Saída determinística recomendada

Para cada classe/trigger:

- status e score de confiança;
- tamanho bruto offline e, se disponível, `LengthWithoutComments` da org;
- inclusão/exclusão do teto de 6 MB e motivo (`@isTest`, namespace/managed package etc.);
- roots alcançáveis e caminho mínimo de evidência;
- incoming/outgoing edges estáticas;
- referências apenas de teste;
- sinais dinâmicos e metadata não analisada;
- métodos sem incoming edge e intervalo aproximado de caracteres;
- ganho recuperável estimado se a classe inteira for removida;
- ação: `keep`, `review`, `candidate_for_deletion`, `candidate_for_refactor`.

O JSON deve ser o produto principal; CSV/HTML/Markdown podem ser gerados depois. Isso permite que uma camada LLM escreva o relatório sem inventar fatos, pois cada conclusão aponta para evidências verificáveis.

## Repositórios públicos para validação

As contagens abaixo foram calculadas sobre a árvore GitHub pública em 3 de agosto de 2026. “Bytes Apex” é a soma do tamanho dos blobs `.cls` e `.trigger`, **não** consumo de org: inclui comentários, testes e código possivelmente empacotado.

| Repositório | Estado/uso | Arquivos Apex | Bytes Apex brutos | Por que usar |
|---|---:|---:|---:|---|
| [SalesforceFoundation/NPSP](https://github.com/SalesforceFoundation/NPSP) | ativo, SFDX | 1.070 | 14.443.753 | principal teste de escala e variedade: 1.044 classes, 26 triggers, 80 páginas VF, 19 components VF, 35 Aura e 193 Custom Metadata records; a árvore contém `sfdx-project.json` e `force-app` ([API da árvore](https://api.github.com/repos/SalesforceFoundation/NPSP/git/trees/main?recursive=1)). |
| [SalesforceFoundation/EDA](https://github.com/SalesforceFoundation/EDA) | arquivado em 2025, SFDX | 662 | 7.619.873 | segundo corpus enterprise para regressão e construções legadas; possui `sfdx-project.json` e `force-app` ([API da árvore](https://api.github.com/repos/SalesforceFoundation/EDA/git/trees/main?recursive=1)). |
| [trailheadapps/apex-recipes](https://github.com/trailheadapps/apex-recipes) | ativo, SFDX | 142 | 610.931 | corpus menor e intencional, mantido pela Salesforce, ideal para fixtures de annotations, REST, async, dynamic Apex e casos esperados ([API da árvore](https://api.github.com/repos/trailheadapps/apex-recipes/git/trees/main?recursive=1)). |

Estratégia de validação:

1. **fixtures unitárias sintéticas:** cada tipo de aresta/root e cada falso positivo dinâmico;
2. **Apex Recipes:** correção semântica e snapshots do grafo;
3. **NPSP:** performance, memória, referências cross-metadata e estabilidade em corpus grande;
4. **EDA:** compatibilidade com padrões antigos;
5. **mutants controlados:** adicionar/remover classes e referências conhecidas nos forks locais de teste para medir precisão e recall, pois repositórios reais não fornecem ground truth de código morto.

## Recorte de MVP

O primeiro corte com valor real deve:

1. descobrir todos os `packageDirectories` de `sfdx-project.json`;
2. inventariar e classificar Apex de produção, teste e package/namespace;
3. gerar AST e tabela de símbolos;
4. construir arestas Apex, LWC, Aura, Visualforce e Flow;
5. calcular alcançabilidade de produção e de teste separadamente;
6. emitir JSON com evidências, confiança e tamanho recuperável estimado;
7. aceitar enriquecimento opcional da org via Tooling API, sem exigir acesso para funcionar.

Só depois vale adicionar heurísticas mais amplas, telemetria/runtime e narrativa por LLM. O núcleo deve permanecer reproduzível, offline e auditável.
