import type { Evidence } from "./contracts.js";

/** Preserve pages actually read without making quotes across gaps valid. */
export function rememberEvidence(
  seen: Map<string, Evidence>,
  incoming: Evidence,
) {
  const old = seen.get(incoming.id);
  if (
    old &&
    (old.version !== incoming.version ||
      old.sourceId !== incoming.sourceId ||
      old.kind !== incoming.kind)
  )
    throw new Error("Evidence identity/version changed inside an execution");
  const readTexts = [
    ...new Set([
      ...(old?.readTexts ?? (old ? [old.text] : [])),
      ...(incoming.readTexts ?? [incoming.text]),
    ]),
  ];
  seen.set(incoming.id, { ...incoming, readTexts });
}
export function supportsQuote(evidence: Evidence, quote: string): boolean {
  return (
    !!quote &&
    (evidence.readTexts ?? [evidence.text]).some((text) => text.includes(quote))
  );
}
