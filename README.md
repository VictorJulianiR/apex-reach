# apex-reach

`apex-reach` is a local, deterministic static analyzer for Salesforce DX repositories. It finds repository-unreachable Apex, duplicate/refactoring families, selector/domain consolidation opportunities, and simple trigger paths that can be moved to record-triggered Flow.

It does **not** send source code to an LLM or require access to a Salesforce org. An LLM can summarize its JSON later, but it does not decide what is reachable.

## What it produces

- inventory of raw Apex source size, separating production and `@isTest` files;
- a repository-wide class, trigger, method, and constructor symbol table;
- resolved and conservative dependency edges with source locations;
- production, test-only, and unreachable classifications;
- shortest evidence paths from entry points to reachable symbols;
- top-level recovery candidates with raw size, binary repository classification, and exposure flags;
- method candidates inside live classes for refactoring;
- machine-readable JSON plus a review-oriented Markdown report;
- exact, parameterized, and verified near-miss clone families with non-overlapping source coverage;
- static and constant-folded dynamic SOQL families, with runtime-dependent query sites explicitly excluded from family totals;
- compatible DML/domain-operation families that preserve transaction and access-mode differences;
- binary trigger-to-Flow eligibility with explicit order, bulk, transaction, recursion, security, callout, async, and coverage blockers;
- analyzed Git branch, commit, and dirty state in every report.

The executive report keeps three lanes separate: **certified repository-unreachable Apex**, **duplicate/refactor coverage**, and **Apex proven removable by Flow conversion**. They are not added together because source intervals can overlap, and duplicate coverage is not guaranteed savings after abstraction overhead.

The primary result is a deterministic **closed-world repository classification**. It assumes every deployable Apex file and every metadata/configuration file that defines production calls is present in the SFDX package directories. Within that declared universe a symbol is either production-reachable, test-only, or unreachable; the tool does not assign probability. Callers outside the repository, such as an external REST client, are outside the result by definition and are listed as exposure signals instead of changing reachability.

If parsing, dynamic type construction, duplicate symbols, or unresolved calls prevent a complete reachability conclusion, the report labels deprecation candidates **not certified**, groups every blocker by concrete cause, and lists its exact file and line. Nothing is called safe while certification is blocked. Dynamic SOQL exclusions do not invalidate resolved query-family findings: the Markdown reports resolved families and excluded call sites separately. A blocker is never converted into a confidence score. Clone similarity is a reproducible threshold measurement, not probability.

The Markdown report is intentionally operational: it shows at most 25 findings per large analysis table and keeps the complete evidence set in JSON.

## Install on Windows (no admin required)

Requirements: Node.js 20 or newer. Git is only required when cloning instead of downloading the ZIP.

```bat
git clone https://github.com/VictorJulianiR/apex-reach.git
cd apex-reach
install.bat
```

Alternatively, download and extract the repository ZIP, then double-click `install.bat`. It installs under `%LOCALAPPDATA%\apex-reach` and creates the `apex-reach` command in `%APPDATA%\npm`, the standard per-user npm command folder. It does not require administrator access or change your PATH. If the command is not recognized, use `%APPDATA%\npm\apex-reach.cmd` directly.

Run the analyzer:

```bat
apex-reach C:\path\to\sfdx-project --output reports\apex-reach
```

This writes `reports\apex-reach.json` and `reports\apex-reach.md`.

## Development

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

The default JSON retains the edges needed for reachability evidence, candidate review, metadata, conservative dispatch, and analysis blockers. `--full-graph` includes every resolved edge and can create a very large file on enterprise repositories.

The analyzer can also be embedded:

```ts
import { analyzeProject, renderMarkdown } from "apex-reach";

const report = await analyzeProject("/path/to/project");
const markdown = renderMarkdown(report);
```

## Entry points and references covered

The current analyzer treats only concrete execution evidence as a production entry:

- triggers;
- LWC `@salesforce/apex/Class.method` imports;
- Aura controller bindings and the exact server methods requested through `c.method`;
- Visualforce controllers, extensions, actions, and their public methods;
- Flow Apex actions;
- Custom Metadata string values that resolve exactly to a local Apex type;
- conservative exact configuration values found in every text metadata file under each SFDX package directory (class names embedded in prose do not count as calls).

Callable annotations, `global`/`public` visibility, webservice methods, and platform callback interfaces are reported as **exposure**, not proof of a call. They become reachable only through an actual Apex or metadata reference in the repository. Test methods are separate test-only entry points.

Within Apex it extracts method calls, constructors, declared types, inheritance, typed receiver dispatch, static member access, and literal/computed `Type.forName` signals. Overloads are resolved by owner, name, and arity; ambiguous dispatch is deliberately conservative.

## Size semantics

Raw characters and UTF-8 bytes are useful offline estimates, not the exact deployed-org Apex allocation. `@isTest` source is separated because Salesforce excludes it from the org Apex code limit. Flow is separate metadata and does not consume the 6 MB Apex code allowance, although synchronous Flow shares transaction governors. A later online enrichment can use Tooling API `LengthWithoutComments` without changing the offline classifications.

## Validation

The test suite covers reachability and metadata entry points plus clone profiles, selector families, dynamic SOQL blockers, keyword and `Database.*` DML, Flow eligibility/blockers, revision capture, report generation, and the Windows installer.

```sh
npm run check
npm test
```

The analyzer was also exercised against Salesforce-maintained public SFDX repositories. See [validation results](docs/validation.md), the [static-analysis research](docs/research/apex-reclaim-static-analysis.md), and the [academic/standards-backed quality-gate roadmap](docs/research/offline-quality-gates.md).

## Design

The stable module interface is a single read-only operation: `analyzeProject(path, options) -> versioned report`. Discovery, Apex parsing, complete text-metadata scanning, graph resolution, blocker detection, and presentation remain behind that seam. See [domain language](CONTEXT.md) and [ADR 0001](docs/adr/0001-evidence-first-static-analysis.md).

The offline JSON remains the source of facts; Markdown only organizes those facts for review. See [duplicate/Flow research](docs/research/duplicate-apex-and-flow-conversion.md) and [ADR 0002](docs/adr/0002-duplicate-and-flow-analysis.md).
