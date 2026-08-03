import path from "node:path";

export function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function relativePath(root: string, value: string): string {
  return portablePath(path.relative(root, value));
}

export function normalizeName(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function simpleTypeName(value: string): string {
  const withoutGenerics = value.replace(/<.*>/g, "").replace(/\[\]/g, "");
  const parts = withoutGenerics.split(".");
  return parts.at(-1) ?? withoutGenerics;
}
