import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RecordAutomationObservation } from "../model.js";
import { relativePath } from "../paths.js";

export async function inspectRecordAutomation(root: string, metadataPaths: string[]): Promise<RecordAutomationObservation[]> {
  const result: RecordAutomationObservation[] = [];
  for (const absolutePath of metadataPaths) {
    const normalized = absolutePath.replace(/\\/g, "/");
    if (!/(?:\.flow-meta\.xml|\.workflow-meta\.xml)$/i.test(normalized)) continue;
    const source = await readFile(absolutePath, "utf8");
    const reportPath = relativePath(root, absolutePath);
    if (/\.flow-meta\.xml$/i.test(normalized)) {
      const object = firstTag(source, "object");
      const triggerType = firstTag(source, "triggerType");
      const status = firstTag(source, "status");
      if (object && triggerType && /record/i.test(triggerType) && /^active$/i.test(status ?? "")) {
        result.push({ kind: "flow", object, timing: triggerType, path: reportPath });
      }
      continue;
    }
    const base = path.basename(absolutePath).replace(/\.workflow-meta\.xml$/i, "");
    if (base && /<active>\s*true\s*<\/active>/i.test(source)) result.push({ kind: "workflow", object: base, timing: "workflow-rule", path: reportPath });
  }
  return result.sort((left, right) => left.object.localeCompare(right.object) || left.path.localeCompare(right.path));
}

function firstTag(source: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([^<]+)</${tag}>`, "i").exec(source)?.[1]?.trim();
}
