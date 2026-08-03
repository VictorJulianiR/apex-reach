# apex-reach

`apex-reach` is a local, deterministic static analyzer for Salesforce DX repositories. It finds Apex classes and methods that are not reachable from known production entry points and emits the evidence needed for a code-capacity recovery review.

It does **not** send source code to an LLM or require access to a Salesforce org. An LLM can summarize its JSON later, but it does not decide what is reachable.

## What it produces

- inventory of raw Apex source size, separating production and `@isTest` files;
- a repository-wide class, trigger, method, and constructor symbol table;
- resolved and conservative dependency edges with source locations;
- production, test-only, and unreachable classifications;
- shortest evidence paths from entry points to reachable symbols;
- top-level recovery candidates with raw size, confidence, and uncertainty;
- method candidates inside live classes for refactoring;
- machine-readable JSON plus a review-oriented Markdown report.

The primary result is a **recovery candidate**, not a “safe to delete” verdict. Offline analysis cannot observe org-only metadata, queued or scheduled jobs, configuration data that was not retrieved, managed-package consumers, or external REST/SOAP callers.

## Run it

Requirements: Node.js 20 or newer.

```sh
npm install
npm run build
node dist/cli.js /path/to/sfdx-project --output reports/apex-reach
```

This writes:

```text
reports/apex-reach.json
reports/apex-reach.md
```

Useful options:

```text
--format json|markdown|both
--exclude <glob...>
--no-pretty
--full-graph
```

The default JSON retains the edges needed for reachability evidence, candidate review, metadata, ambiguity, and unresolved observations. `--full-graph` includes every resolved edge and can create a very large file on enterprise repositories.

The analyzer can also be embedded:

```ts
import { analyzeProject, renderMarkdown } from "apex-reach";

const report = await analyzeProject("/path/to/project");
const markdown = renderMarkdown(report);
```

## Entry points and references covered

The current analyzer treats these as production entry evidence:

- triggers;
- Apex REST, SOAP, Aura, invocable, remote, namespace-accessible, and async annotations;
- `Queueable`, `Schedulable`, `Batchable`, `Callable`, inbound email, install, and uninstall callbacks;
- `global` methods;
- LWC `@salesforce/apex/Class.method` imports;
- Aura server-side controllers;
- Visualforce controllers, extensions, actions, and their public methods;
- Flow Apex actions;
- Custom Metadata string values that resolve exactly to a local Apex type.

Within Apex it extracts method calls, constructors, declared types, inheritance, typed receiver dispatch, static member access, and literal/computed `Type.forName` signals. Overloads are resolved by owner, name, and arity; ambiguous dispatch is deliberately conservative.

## Size semantics

Raw characters and UTF-8 bytes are useful offline estimates, not the exact deployed-org Apex allocation. `@isTest` source is separated because Salesforce excludes it from the org Apex code limit. For exact deployed attribution, enrich a later version with Tooling API `ApexClass` / `ApexTrigger` `LengthWithoutComments`, `NamespacePrefix`, and `ManageableState`.

## Validation

The test suite covers production/test-only reachability, trigger dispatch, LWC imports, Custom Metadata, computed dynamic types, confidence grading, and report generation.

```sh
npm run check
npm test
```

The analyzer was also exercised against Salesforce-maintained public SFDX repositories. See [validation results](docs/validation.md), the [static-analysis research](docs/research/apex-reclaim-static-analysis.md), and the [academic/standards-backed quality-gate roadmap](docs/research/offline-quality-gates.md).

## Design

The stable module interface is a single read-only operation: `analyzeProject(path, options) -> versioned report`. Discovery, Apex parsing, metadata extraction, graph resolution, confidence, and presentation remain behind that seam. See [domain language](CONTEXT.md) and [ADR 0001](docs/adr/0001-evidence-first-static-analysis.md).

The next highest-value extension is optional org enrichment, followed by more configuration metadata and runtime telemetry. The deterministic offline report remains the source of facts.
