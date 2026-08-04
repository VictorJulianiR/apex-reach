# Validation results

Validation was rerun on 4 August 2026 with `apex-reach` 0.2.0. Repository clones and generated reports live under the ignored `validation/` directory so they do not become product dependencies.

## Automated fixtures

Eleven tests exercise:

- trigger-to-handler and internal method reachability;
- production, test-only, and unreachable classifications;
- exact LWC imports and Aura bundle `c.method` calls;
- class references stored in Custom Metadata;
- annotation-only methods remaining unreachable without a concrete call;
- class names embedded in human-readable metadata prose not becoming calls;
- interface/runtime dispatch and constructed platform callbacks;
- computed `Type.forName` blocking only when its containing symbol is production-reachable;
- probability-free candidates and exact blocker locations;
- exclusion of `@isTest` source from the production footprint;
- Markdown report and Windows installer behavior.

Result: 11/11 passed, with TypeScript checking and production build also passing.

## trailheadapps/apex-recipes

- 142 Apex files and 273 text metadata files;
- 628,433 raw Apex characters, 312,090 in non-test source;
- 905 symbols and 2,183 retained reference edges;
- 0 unresolved local references and 0 parse diagnostics;
- completed in approximately 2.1 seconds;
- 1 top-level repository-unreachable type and 21 member candidates;
- 8,125 repository-unreachable raw production characters (2.60%);
- 1 blocking, production-reachable computed `Type.forName` site.

The sole top-level candidate remains `SchemaRecipes`. Visibility is reported as exposure, but no production code or metadata path to the type exists in the repository.

## SalesforceFoundation/NPSP

- 1,061 Apex files and 10,312 text metadata files;
- 14,669,238 raw Apex characters, 7,014,573 in non-test source;
- 14,098 symbols and 155,222 retained reference edges;
- 0 unresolved local references and 0 parse diagnostics;
- completed in approximately 40.2 seconds;
- 5 top-level repository-unreachable types and 332 member candidates;
- 106,994 repository-unreachable raw production characters (1.53%);
- 19 blocking, production-reachable computed `Type.forName` sites.

The top-level set is `fflib_RecordTypeId`, `HH_ManageHousehold_EXT`, `RP_HTTPClient`, `ADDR_Validator_REST`, and `fflib_IAppBindingRouter`. Callable annotations and visibility are retained as exposure facts, not converted into probability or automatic production reachability.

## What this validates

- The parser accepts large, varied Apex without syntax loss in the selected corpora.
- Full text-metadata scanning is practical on a repository with more than ten thousand metadata files.
- Annotation and visibility exposure can be separated from actual repository calls.
- Interface dispatch and platform callback propagation materially prevent false deletion candidates.
- Remaining incompleteness is reduced to a short, deterministic list of reachable computed-dispatch locations rather than candidate-wide confidence scores.

## What it does not validate

- Precision or recall against a fully labeled enterprise dead-code dataset.
- Exact Salesforce org code allocation; raw repository characters are used offline.
- Callers outside the declared repository universe, such as an external REST/SOAP client.
- Arbitrary computed class-name expressions. Those deliberately block a complete conclusion until each production-reachable expression can be resolved to a finite target set.
- Eight million lines at once. NPSP is a useful scale signal, not a substitute for a benchmark on the client's hardware and repository shape.

The next precision step is interprocedural string/value propagation for the reported dynamic-type sites. Deterministic SOQL-family analysis for selector-layer refactoring remains a separate metric and will not alter the deletion percentage.
