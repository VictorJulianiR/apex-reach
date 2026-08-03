#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import { analyzeProject } from "./analyze.js";
import { renderMarkdown } from "./report.js";

interface CliOptions {
  format: "json" | "markdown" | "both";
  output: string;
  exclude: string[];
  pretty: boolean;
  fullGraph: boolean;
}

const program = new Command()
  .name("apex-reach")
  .description("Evidence-first recovery analysis for Salesforce DX Apex code")
  .version("0.1.0")
  .argument("[project]", "SFDX project directory", ".")
  .addOption(new Option("-f, --format <format>", "report format").choices(["json", "markdown", "both"]).default("both"))
  .option("-o, --output <base>", "output file base (extensions are added)", "apex-reach-report")
  .option("--exclude <glob...>", "additional glob patterns to exclude", [])
  .option("--full-graph", "include every resolved edge in JSON (can be very large)", false)
  .option("--no-pretty", "write compact JSON")
  .action(async (project: string, options: CliOptions) => {
    const started = performance.now();
    process.stderr.write(`Analyzing ${path.resolve(project)}...\n`);
    const report = await analyzeProject(project, { exclude: options.exclude, fullGraph: options.fullGraph });
    const outputBase = path.resolve(options.output.replace(/\.(json|md)$/i, ""));
    await mkdir(path.dirname(outputBase), { recursive: true });
    const written: string[] = [];
    if (options.format === "json" || options.format === "both") {
      const jsonPath = `${outputBase}.json`;
      await writeFile(jsonPath, `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`, "utf8");
      written.push(jsonPath);
    }
    if (options.format === "markdown" || options.format === "both") {
      const markdownPath = `${outputBase}.md`;
      await writeFile(markdownPath, renderMarkdown(report), "utf8");
      written.push(markdownPath);
    }
    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    process.stderr.write(`Done in ${elapsed}s. ${report.summary.candidateClasses} top-level and ${report.summary.candidateMethods} member candidates.\n`);
    for (const file of written) process.stdout.write(`${file}\n`);
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`apex-reach: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
