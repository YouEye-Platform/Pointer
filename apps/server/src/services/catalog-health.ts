import { catalogCorpusSchema, type CatalogCorpus } from "./catalog-contracts";

export interface CatalogHealthReport {
  corpusVersion: string;
  generatedAt: string;
  counts: {
    observations: number;
    activeObservations: number;
    entities: number;
    activeEntities: number;
    providerRoutes: number;
    benchmarkLinks: number;
    aliases: number;
    organizations: number;
    assets: number;
    unresolvedDecisions: number;
    ambiguousDecisions: number;
    orphanEntities: number;
    unresolvedRoutes: number;
    missingOrganizations: number;
    missingAssets: number;
    iconFallbacks: number;
    suspiciousNames: number;
    duplicateNames: number;
  };
  findings: {
    ambiguousObservations: Array<{ observationId: string; candidates: string[] }>;
    unresolvedObservations: string[];
    orphanEntities: string[];
    unresolvedRoutes: string[];
    missingOrganizations: string[];
    missingAssets: string[];
    iconFallbacks: string[];
    suspiciousNames: Array<{ entityId: string; name: string; reasons: string[] }>;
    duplicateNames: Array<{ normalizedName: string; entityIds: string[] }>;
    unhealthySources: Array<{ sourceId: string; health: string; errorCode: string | null }>;
  };
}

const compare = (left: string, right: string) => left.localeCompare(right);
const normalizedName = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");

export function suspiciousNameReasons(name: string): string[] {
  const reasons: string[] = [];
  if (/\b(?:Glm|Gpt|Llm|Ai|Api|Vl)\b/.test(name)) reasons.push("acronym_casing");
  if (/\b\d+\s+\d+(?:\s+\d+)?\b/.test(name)) reasons.push("version_punctuation_lost");
  if (/\b\d{4}\s+\d{2}\s+\d{2}\b/.test(name)) reasons.push("date_punctuation_lost");
  if (/\s{2,}/.test(name) || name !== name.trim()) reasons.push("whitespace");
  return reasons;
}

export function analyzeCatalogCorpus(input: unknown): CatalogHealthReport {
  const corpus = catalogCorpusSchema.parse(input);
  const activeObservationIds = new Set(corpus.observations.filter((row) => row.active).map((row) => row.id));
  const linkedEntityIds = new Set(corpus.decisions
    .filter((row) => row.state === "linked" && row.entityId && activeObservationIds.has(row.observationId))
    .map((row) => row.entityId as string));
  const activeEntities = corpus.entities.filter((row) => row.active);
  const activeEntityIds = new Set(activeEntities.map((row) => row.id));
  const organizationIds = new Set(corpus.organizations.map((row) => row.id));
  const organizationsWithAssets = new Set(corpus.assets.filter((row) => row.active).map((row) => row.organizationId));

  const orphanEntities = activeEntities.filter((row) => !linkedEntityIds.has(row.id)).map((row) => row.id).sort(compare);
  const unresolvedRoutes = corpus.providerRoutes.filter((row) => row.active && !row.entityId).map((row) => row.id).sort(compare);
  const missingOrganizations = activeEntities
    .filter((row) => !row.organizationId || !organizationIds.has(row.organizationId))
    .map((row) => row.id).sort(compare);
  const missingAssets = activeEntities
    .filter((row) => !row.organizationId || !organizationsWithAssets.has(row.organizationId))
    .map((row) => row.id).sort(compare);
  const iconFallbacks = corpus.legacyPresentation.filter((row) => row.iconOutcome === "fallback" && activeEntityIds.has(row.entityId))
    .map((row) => row.entityId).sort(compare);
  const suspiciousNames = activeEntities.map((row) => ({ entityId: row.id, name: row.preferredName, reasons: suspiciousNameReasons(row.preferredName) }))
    .filter((row) => row.reasons.length > 0).sort((a, b) => compare(a.entityId, b.entityId));

  const names = new Map<string, string[]>();
  for (const entity of activeEntities) {
    const key = normalizedName(entity.preferredName);
    names.set(key, [...(names.get(key) ?? []), entity.id]);
  }
  const duplicateNames = [...names.entries()].filter(([, ids]) => ids.length > 1)
    .map(([name, ids]) => ({ normalizedName: name, entityIds: ids.sort(compare) }))
    .sort((a, b) => compare(a.normalizedName, b.normalizedName));

  const ambiguousObservations = corpus.decisions.filter((row) => row.state === "ambiguous")
    .map((row) => ({ observationId: row.observationId, candidates: [...row.candidateEntityIds].sort(compare) }))
    .sort((a, b) => compare(a.observationId, b.observationId));
  const unresolvedObservations = corpus.decisions.filter((row) => row.state === "unresolved")
    .map((row) => row.observationId).sort(compare);
  const unhealthySources = corpus.sources.filter((row) => row.health !== "healthy")
    .map((row) => ({ sourceId: row.sourceId, health: row.health, errorCode: row.errorCode }))
    .sort((a, b) => compare(a.sourceId, b.sourceId));

  return {
    corpusVersion: corpus.corpusVersion,
    generatedAt: corpus.generatedAt,
    counts: {
      observations: corpus.observations.length,
      activeObservations: activeObservationIds.size,
      entities: corpus.entities.length,
      activeEntities: activeEntities.length,
      providerRoutes: corpus.providerRoutes.filter((row) => row.active).length,
      benchmarkLinks: corpus.benchmarkLinks.length,
      aliases: corpus.aliases.length,
      organizations: corpus.organizations.length,
      assets: corpus.assets.filter((row) => row.active).length,
      unresolvedDecisions: unresolvedObservations.length,
      ambiguousDecisions: ambiguousObservations.length,
      orphanEntities: orphanEntities.length,
      unresolvedRoutes: unresolvedRoutes.length,
      missingOrganizations: missingOrganizations.length,
      missingAssets: missingAssets.length,
      iconFallbacks: iconFallbacks.length,
      suspiciousNames: suspiciousNames.length,
      duplicateNames: duplicateNames.length,
    },
    findings: {
      ambiguousObservations,
      unresolvedObservations,
      orphanEntities,
      unresolvedRoutes,
      missingOrganizations,
      missingAssets,
      iconFallbacks,
      suspiciousNames,
      duplicateNames,
      unhealthySources,
    },
  };
}

export function stableCatalogReport(report: CatalogHealthReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function assertCatalogInvariants(corpus: CatalogCorpus): string[] {
  const report = analyzeCatalogCorpus(corpus);
  const violations: string[] = [];
  if (report.counts.orphanEntities) violations.push(`${report.counts.orphanEntities} active entities lack active observation support`);
  if (report.counts.unresolvedRoutes) violations.push(`${report.counts.unresolvedRoutes} active provider routes are unresolved`);
  const entityIds = new Set(corpus.entities.filter((row) => row.active).map((row) => row.id));
  for (const route of corpus.providerRoutes.filter((row) => row.active && row.entityId)) {
    if (!entityIds.has(route.entityId as string)) violations.push(`route ${route.id} points to inactive or missing entity ${route.entityId}`);
  }
  return violations.sort(compare);
}
