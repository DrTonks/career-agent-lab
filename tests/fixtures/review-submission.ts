/** Fixture adapter: choose a sent span containing the old short test quotation. */
export function submissionFixture(value: any, payload: any) {
  if (!value.audit) return value;
  const { audit, ...rest } = value;
  return {
    ...rest,
    calculationClaims: [],
    changes: audit.changes,
    hardConditionCounts: audit.hardConditionCounts,
    units: audit.units.map(({ citations, ...unit }: any) => ({
      ...unit,
      evidenceIds: citations.map((citation: any) => {
        const source = payload.sources.find(
          (s: any) => s.id === citation.sourceId,
        );
        const fragment = source?.fragments.find((f: any) =>
          f.text.includes(citation.quote),
        );
        if (!fragment) throw Error("Fixture quote not in a sent fragment");
        return fragment.id;
      }),
    })),
  };
}
