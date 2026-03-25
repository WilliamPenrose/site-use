// src/display/resolve.ts

export interface FieldDef {
  path: string;
  format?: (value: unknown) => string | undefined;
}

export type DisplaySchema = Record<string, FieldDef>;

function resolve(doc: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((o, k) => (o as Record<string, unknown>)?.[k], doc);
}

export function resolveItem(
  doc: Record<string, unknown>,
  schema: DisplaySchema,
  fields: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const def = schema[field];
    if (!def) continue;
    const raw = resolve(doc, def.path);
    result[field] = def.format ? def.format(raw) : raw;
  }
  return result;
}
