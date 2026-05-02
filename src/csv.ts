import { writeFile } from "node:fs/promises";
import type { SerpResult } from "./types.ts";

const HEADERS = ["position", "name", "url", "email", "phone", "snippet"] as const;

function escape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function writeCsv(path: string, rows: SerpResult[]): Promise<void> {
  const lines = [HEADERS.join(",")];
  for (const r of rows) {
    lines.push([r.position, r.name, r.url, r.email, r.phone, r.snippet].map((v) => escape(String(v))).join(","));
  }
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}
