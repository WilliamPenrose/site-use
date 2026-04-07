/**
 * Canonicalize a Twitter tab name for storage and cache lookups.
 *
 * Resolves the case-sensitivity / spacing variants that the CLI accepts
 * (e.g. "Following" vs "following", "for you" vs "for_you", "Vibe Coding"
 * vs "vibe coding") to a single canonical key. Without this, the same tab
 * splits across multiple rows in `item_source_tabs` and `fetch-timestamps.json`.
 *
 * Rules: NFC normalize, lowercase, collapse internal whitespace, trim,
 * convert spaces to underscores. Empty input is preserved as empty so
 * upstream zod validators can reject it explicitly.
 */
export function canonicalizeTab(raw: string): string {
  return raw
    .normalize('NFC')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '_');
}
