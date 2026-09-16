import { createHash } from "node:crypto";

export const CATALOG_IDENTITY_RESOLVER_VERSION = "catalog-identity-2" as const;
export const AUTO_LINK_THRESHOLD = 60;
export const AUTO_LINK_MARGIN = 15;

const VARIANT_TOKENS = new Set([
  "base", "chat", "instruct", "thinking", "no-thinking", "reasoning", "non-reasoning",
  "turbo", "preview", "experimental", "exp", "fast", "instant",
]);
const MODALITY_TOKENS = new Set(["vision", "vl", "audio", "image", "omni"]);
const QUANTIZATION_TOKENS = new Set(["bf16", "fp16", "fp8", "int8", "int4", "awq", "gptq", "gguf"]);
// Reviewed exact leaderboard labels that describe a benchmark configuration,
// not a separately routable model. Keep this list source-specific and small;
// an unmatched or ambiguous label must continue through conservative scoring.
const REVIEWED_BENCHMARK_ALIASES: Record<string, string> = {
  "lmarena:kimi-k3-max": "kimi-k3",
  "lmarena-webdev:kimi-k3-max": "kimi-k3",
};
export type IdentityObservationInput = {
  id: string;
  sourceId: string;
  kind: "reference_model" | "provider_model" | "benchmark_model";
  nativeId: string;
  observedName: string | null;
  organizationHint?: string | null;
};

export type ParsedIdentityClaims = {
  rawNativeId: string;
  rawName: string | null;
  namespace: string | null;
  creator: string | null;
  family: string | null;
  version: string | null;
  date: string | null;
  variants: string[];
  size: string | null;
  modalities: string[];
  quantization: string | null;
  routeTier: string | null;
  normalized: string;
  identityKey: string;
};

export type IdentityEntity = {
  id: string;
  stableSlug: string;
  preferredName: string;
  organizationId: string | null;
  claims: ParsedIdentityClaims;
};

export type IdentityDecision = {
  observationId: string;
  entityId: string | null;
  state: "linked" | "ambiguous" | "unresolved" | "rejected";
  method: "native_id" | "crosswalk" | "approved_alias" | "structured_match" | "reviewed_override" | "none";
  confidence: number;
  candidateEntityIds: string[];
  evidence: string[];
  blockers: string[];
  score: number;
  margin: number;
  resolverVersion: typeof CATALOG_IDENTITY_RESOLVER_VERSION;
};

export type IdentityResolverInput = {
  observations: IdentityObservationInput[];
  existingEntities?: IdentityEntity[];
  reviewedOverrides?: Record<string, string>;
  rejectedEntityIds?: Record<string, string[]>;
  authoritativeCrosswalk?: Record<string, string>;
  approvedAliases?: Record<string, string>;
  creatorAliases?: Record<string, string>;
  priorLinks?: Record<string, string>;
};

export type IdentityResolverOutput = {
  entities: IdentityEntity[];
  decisions: IdentityDecision[];
};

const normalizeCreatorText = (value: string) => value.toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

const normalizeCreator = (value: string | null | undefined, aliases?: Record<string, string>) => {
  if (!value) return null;
  const normalized = normalizeCreatorText(value);
  const alias = aliases?.[normalized];
  return alias ? normalizeCreatorText(alias) : normalized;
};

const normalizeCreatorAliases = (aliases?: Record<string, string>) => Object.fromEntries(
  Object.entries(aliases ?? {}).map(([alias, target]) => [normalizeCreatorText(alias), normalizeCreator(target)!])
);

const normalizeIdentityText = (value: string) => value
  .toLowerCase()
  .trim()
  .replace(/\s*\([^)]*\)\s*/g, "-")
  .replace(/[_\s]+/g, "-")
  .replace(/[^a-z0-9.:/-]+/g, "-")
  .replace(/-+/g, "-")
  .replace(/^-|-$/g, "");

const findDate = (value: string) => {
  const full = value.match(/(?:^|-)((?:19|20)\d{2})[-.]?(0[1-9]|1[0-2])[-.]?([0-2]\d|3[01])(?:-|$)/);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;
  const preview = value.match(/(?:preview|exp)[-.]?(0[1-9]|1[0-2])[-.]?([0-2]\d|3[01])(?:-|$)/);
  return preview ? `${preview[1]}-${preview[2]}` : null;
};

const findSize = (value: string) => {
  const size = value.match(/(?:^|-)(\d+(?:\.\d+)?(?:b|m))(?:-|$)/i);
  const moe = value.match(/(?:^|-)(a\d+(?:\.\d+)?b)(?:-|$)/i);
  if (!size && !moe) return null;
  return [size?.[1], moe?.[1]].filter(Boolean).join("-").toLowerCase();
};

const findVersion = (value: string, date: string | null, size: string | null) => {
  const withoutDate = date ? value.replace(date, "-").replace(date.replace(/-/g, ""), "-") : value;
  const withoutSize = size ? withoutDate.replace(size, "-") : withoutDate;
  const version = withoutSize.match(/(?:^|-)(v?\d+(?:[.-]\d+){0,2})(?:-|$)/i)
    ?? withoutSize.match(/[a-z](v?\d+(?:[.-]\d+){1,2})(?=-|$)/i);
  return version ? version[1].replace(/^v/i, "").replace(/-/g, ".") : null;
};

const leastDestructiveName = (raw: string) => {
  const local = raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw;
  return local.replace(/:(?:free|paid)$/i, "").trim();
};

function parseIdentityClaimsWithAliases(
  input: Pick<IdentityObservationInput, "nativeId" | "observedName" | "organizationHint">,
  creatorAliases: Record<string, string>
): ParsedIdentityClaims {
  const raw = normalizeIdentityText(input.nativeId || input.observedName || "");
  const slash = raw.indexOf("/");
  const namespace = slash > 0 ? raw.slice(0, slash) : null;
  let local = slash > 0 ? raw.slice(slash + 1) : raw;
  const routeTierMatch = local.match(/:(free|paid)$/);
  const routeTier = routeTierMatch?.[1] ?? null;
  local = local.replace(/:(?:free|paid)$/, "");
  local = local.replace(/[/:]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const tokens = local.replace(/\./g, "-").split("-").filter(Boolean);
  const variants = [...new Set(tokens.flatMap((token, index) => {
    if (token === "no" && tokens[index + 1] === "thinking") return ["no-thinking"];
    if (token === "non" && tokens[index + 1] === "reasoning") return ["non-reasoning"];
    if ((token === "thinking" && tokens[index - 1] === "no") || (token === "reasoning" && tokens[index - 1] === "non")) return [];
    return VARIANT_TOKENS.has(token) ? [token] : [];
  }))].sort();
  const modalities = [...new Set(tokens.filter((token) => MODALITY_TOKENS.has(token)))].sort();
  const quantization = tokens.find((token) => QUANTIZATION_TOKENS.has(token)) ?? null;
  const date = findDate(local);
  const size = findSize(local);
  const version = findVersion(local, date, size);
  const excluded = new Set([
    ...variants.flatMap((variant) => variant.split("-")),
    ...modalities,
    ...(quantization ? [quantization] : []),
    ...((date ?? "").split("-")),
    ...((size ?? "").split("-")),
    ...((version ?? "").split(".")),
  ]);
  const attachedVersionHead = version?.split(".")[0] ?? null;
  const familyTokens = tokens.map((token) => {
    if (!attachedVersionHead) return token;
    const attached = token.match(new RegExp(`^(.+?[a-z])v?${attachedVersionHead}$`, "i"));
    return attached?.[1] ?? token;
  }).filter((token) => !excluded.has(token) && !/^\d+$/.test(token));
  const family = familyTokens.length > 0 ? familyTokens.join("-") : null;
  const creator = normalizeCreator(input.organizationHint ?? namespace, creatorAliases);
  const identityKey = [family, version, date, variants.join("+"), size, modalities.join("+"), quantization]
    .map((value) => value || "_")
    .join("|");
  return {
    rawNativeId: input.nativeId,
    rawName: input.observedName,
    namespace,
    creator,
    family,
    version,
    date,
    variants,
    size,
    modalities,
    quantization,
    routeTier,
    normalized: local,
    identityKey,
  };
}

export function parseIdentityClaims(
  input: Pick<IdentityObservationInput, "nativeId" | "observedName" | "organizationHint">,
  creatorAliases?: Record<string, string>
): ParsedIdentityClaims {
  return parseIdentityClaimsWithAliases(input, normalizeCreatorAliases(creatorAliases));
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
const stableEntityId = (claims: ParsedIdentityClaims, disambiguator?: string) => {
  const readable = slug([claims.creator, claims.family, claims.version, claims.date, ...claims.variants, claims.size, ...claims.modalities, claims.quantization]
    .filter(Boolean).join("-"));
  const identity = {
    creator: claims.creator,
    identityKey: claims.identityKey,
    ...(disambiguator ? { disambiguator } : {}),
  };
  const identityHash = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
  return `model/${readable || "unattributed"}--${identityHash}`;
};

const hardConflicts = (observed: ParsedIdentityClaims, candidate: ParsedIdentityClaims) => {
  const blockers: string[] = [];
  for (const field of ["version", "date", "size", "quantization"] as const) {
    if ((observed[field] || candidate[field]) && observed[field] !== candidate[field]) blockers.push(`${field}:${observed[field] ?? "missing"}!=${candidate[field] ?? "missing"}`);
  }
  if (observed.family && candidate.family && observed.family !== candidate.family) blockers.push(`family:${observed.family}!=${candidate.family}`);
  for (const field of ["variants", "modalities"] as const) {
    if ((observed[field].length > 0 || candidate[field].length > 0) && observed[field].join("+") !== candidate[field].join("+")) {
      blockers.push(`${field}:${observed[field].join("+") || "missing"}!=${candidate[field].join("+") || "missing"}`);
    }
  }
  return blockers;
};

const scoreCandidate = (observed: ParsedIdentityClaims, candidate: ParsedIdentityClaims) => {
  const blockers = hardConflicts(observed, candidate);
  if (blockers.length > 0) return { score: Number.NEGATIVE_INFINITY, blockers, evidence: [] as string[] };
  const evidence: string[] = [];
  let score = 0;
  if (observed.identityKey === candidate.identityKey) { score += 100; evidence.push("identity-key-exact"); }
  if (observed.normalized === candidate.normalized) { score += 40; evidence.push("native-label-exact"); }
  if (observed.family && observed.family === candidate.family) { score += 30; evidence.push(`family:${observed.family}`); }
  if (observed.version && observed.version === candidate.version) { score += 20; evidence.push(`version:${observed.version}`); }
  if (observed.creator && observed.creator === candidate.creator) { score += 10; evidence.push(`creator:${observed.creator}`); }
  else if (observed.creator && candidate.creator) { score -= 10; evidence.push(`creator-alias-candidate:${observed.creator}:${candidate.creator}`); }
  if (observed.date && observed.date === candidate.date) { score += 15; evidence.push(`date:${observed.date}`); }
  if (observed.size && observed.size === candidate.size) { score += 15; evidence.push(`size:${observed.size}`); }
  if (observed.variants.length > 0 && observed.variants.join("+") === candidate.variants.join("+")) {
    score += 15;
    evidence.push(`variants:${observed.variants.join("+")}`);
  }
  return { score, blockers, evidence };
};

const decision = (input: Omit<IdentityDecision, "resolverVersion">): IdentityDecision => ({
  ...input,
  candidateEntityIds: [...input.candidateEntityIds].sort(),
  evidence: [...input.evidence].sort(),
  blockers: [...input.blockers].sort(),
  resolverVersion: CATALOG_IDENTITY_RESOLVER_VERSION,
});

const directTarget = (mapping: Record<string, string> | undefined, keys: string[], entities: Map<string, IdentityEntity>) => {
  for (const key of keys) {
    const entityId = mapping?.[key];
    if (entityId && entities.has(entityId)) return entityId;
  }
  return null;
};

const reviewedBenchmarkAliasTarget = (
  observation: IdentityObservationInput,
  claims: ParsedIdentityClaims,
  entities: Map<string, IdentityEntity>,
) => {
  if (observation.kind !== "benchmark_model") return null;
  const normalizedTarget = REVIEWED_BENCHMARK_ALIASES[`${observation.sourceId}:${claims.normalized}`];
  if (!normalizedTarget) return null;
  const matches = [...entities.values()].filter((entity) => entity.claims.normalized === normalizedTarget);
  return matches.length === 1 ? matches[0]!.id : null;
};

export function resolveCatalogIdentities(input: IdentityResolverInput): IdentityResolverOutput {
  const creatorAliases = normalizeCreatorAliases(input.creatorAliases);
  const parsed = new Map(input.observations.map((observation) => [observation.id, parseIdentityClaimsWithAliases(observation, creatorAliases)]));
  const kindOrder: Record<IdentityObservationInput["kind"], number> = { reference_model: 0, provider_model: 1, benchmark_model: 2 };
  const observations = [...input.observations].sort((left, right) => {
    const kind = kindOrder[left.kind] - kindOrder[right.kind];
    if (kind !== 0) return kind;
    const creator = Number(Boolean(parsed.get(right.id)?.creator)) - Number(Boolean(parsed.get(left.id)?.creator));
    if (creator !== 0) return creator;
    return left.sourceId.localeCompare(right.sourceId)
      || left.nativeId.localeCompare(right.nativeId)
      || (left.observedName ?? "").localeCompare(right.observedName ?? "")
      || left.id.localeCompare(right.id);
  });
  const entities = new Map((input.existingEntities ?? []).map((entity) => [entity.id, entity]));
  const currentEntityIds = new Set<string>();
  const decisions = new Map<string, IdentityDecision>();

  for (const observation of observations.filter((item) => item.kind === "reference_model")) {
    const claims = parsed.get(observation.id)!;
    const reviewedOverride = directTarget(input.reviewedOverrides, [observation.id], entities);
    const crosswalk = directTarget(input.authoritativeCrosswalk, [observation.id, `${observation.sourceId}:${observation.nativeId}`], entities);
    const approvedAlias = directTarget(input.approvedAliases, [claims.normalized, observation.nativeId], entities);
    const prior = directTarget(input.priorLinks, [observation.id], entities);
    const compatiblePrior = prior && hardConflicts(claims, entities.get(prior)!.claims).length === 0 ? prior : null;
    const explicitTarget = reviewedOverride ?? crosswalk ?? approvedAlias ?? compatiblePrior;
    let entityId = explicitTarget ?? stableEntityId(claims);
    const rejectedTargets = new Set(input.rejectedEntityIds?.[observation.id] ?? []);
    if (!explicitTarget && rejectedTargets.has(entityId)) {
      decisions.set(observation.id, decision({
        observationId: observation.id,
        entityId: null,
        state: "rejected",
        method: "none",
        confidence: 0,
        candidateEntityIds: [entityId],
        evidence: [],
        blockers: [`reviewed-rejection:${entityId}`],
        score: 0,
        margin: 0,
      }));
      continue;
    }
    const existing = entities.get(entityId);
    if (existing && currentEntityIds.has(entityId) && hardConflicts(claims, existing.claims).length > 0) {
      entityId = stableEntityId(claims, `${observation.sourceId}:${observation.nativeId}`);
    }
    const disambiguatedExisting = entities.get(entityId);
    if (disambiguatedExisting && currentEntityIds.has(entityId) && hardConflicts(claims, disambiguatedExisting.claims).length > 0) {
      throw new Error(`Catalog identity hash collision for ${entityId}`);
    }
    entities.set(entityId, {
      ...disambiguatedExisting,
      id: entityId,
      stableSlug: disambiguatedExisting?.stableSlug ?? slug(entityId.replace(/\//g, "--")),
      preferredName: observation.observedName || leastDestructiveName(observation.nativeId),
      organizationId: claims.creator ? `org/${claims.creator}` : null,
      claims,
    });
    currentEntityIds.add(entityId);
    const method = reviewedOverride ? "reviewed_override" : crosswalk ? "crosswalk" : approvedAlias ? "approved_alias" : "native_id";
    decisions.set(observation.id, decision({
      observationId: observation.id,
      entityId,
      state: "linked",
      method,
      confidence: 1,
      candidateEntityIds: [entityId],
      evidence: [reviewedOverride
        ? "reviewed-override"
        : crosswalk
          ? `crosswalk:${observation.sourceId}:${observation.nativeId}`
        : approvedAlias
          ? `approved_alias:${observation.sourceId}:${observation.nativeId}`
          : compatiblePrior
            ? `prior-source-identity:${observation.sourceId}:${observation.nativeId}`
            : `new-reference-identity:${claims.identityKey}`],
      blockers: [],
      score: 100,
      margin: 100,
    }));
  }

  for (const observation of observations.filter((item) => item.kind !== "reference_model")) {
    const claims = parsed.get(observation.id)!;
    const reviewedOverride = directTarget(input.reviewedOverrides, [observation.id], entities);
    const crosswalk = directTarget(input.authoritativeCrosswalk, [observation.id, `${observation.sourceId}:${observation.nativeId}`], entities);
    const approvedAlias = directTarget(input.approvedAliases, [claims.normalized, observation.nativeId], entities);
    const reviewedBenchmarkAlias = reviewedBenchmarkAliasTarget(observation, claims, entities);
    const direct = reviewedOverride
      ?? crosswalk
      ?? approvedAlias
      ?? reviewedBenchmarkAlias;
    if (direct) {
      const method = reviewedOverride
        ? "reviewed_override"
        : crosswalk
        ? "crosswalk"
        : approvedAlias
          ? "approved_alias"
          : "reviewed_override";
      currentEntityIds.add(direct);
      decisions.set(observation.id, decision({
        observationId: observation.id,
        entityId: direct,
        state: "linked",
        method,
        confidence: 1,
        candidateEntityIds: [direct],
        evidence: [`${method}:${observation.sourceId}:${observation.nativeId}`],
        blockers: [],
        score: 100,
        margin: 100,
      }));
      continue;
    }

    const rejectedTargets = new Set(input.rejectedEntityIds?.[observation.id] ?? []);
    const evaluated = [...entities.values()]
      .filter((entity) => currentEntityIds.has(entity.id) && !rejectedTargets.has(entity.id))
      .map((entity) => ({ entity, ...scoreCandidate(claims, entity.claims) }));
    const conflicting = evaluated.filter((candidate) => !Number.isFinite(candidate.score)
      && (candidate.entity.claims.family === claims.family || candidate.entity.claims.normalized === claims.normalized))
      .sort((left, right) => left.entity.id.localeCompare(right.entity.id));
    const conflictBlockers = conflicting.slice(0, 5)
      .flatMap((candidate) => candidate.blockers.map((blocker) => `${candidate.entity.id}:${blocker}`));
    if (conflicting.length > 5) conflictBlockers.push(`additional-conflicting-candidates:${conflicting.length - 5}`);
    const ranked = evaluated
      .filter((candidate) => Number.isFinite(candidate.score))
      .sort((left, right) => right.score - left.score || left.entity.id.localeCompare(right.entity.id));
    const top = ranked[0];
    const second = ranked[1];
    const margin = top ? top.score - (second?.score ?? 0) : 0;
    const sameFamily = ranked.filter((candidate) => claims.family && candidate.entity.claims.family === claims.family);
    const underspecifiedAmbiguity = sameFamily.length > 1 && (!claims.version || claims.variants.length === 0)
      && new Set(sameFamily.map((candidate) => `${candidate.entity.claims.version}|${candidate.entity.claims.variants.join("+")}`)).size > 1;
    const conflictingSameFamily = conflicting.filter((candidate) => claims.family && candidate.entity.claims.family === claims.family);
    const missingClaimFields = new Set([
      ...(!claims.version ? ["version"] : []),
      ...(!claims.date ? ["date"] : []),
      ...(!claims.size ? ["size"] : []),
      ...(!claims.quantization ? ["quantization"] : []),
      ...(claims.variants.length === 0 ? ["variants"] : []),
      ...(claims.modalities.length === 0 ? ["modalities"] : []),
    ]);
    const underspecifiedConflicts = conflictingSameFamily.filter((candidate) => candidate.blockers.every((blocker) =>
      missingClaimFields.has(blocker.slice(0, blocker.indexOf(":")))));
    const underspecifiedConflictAmbiguity = underspecifiedConflicts.length > 1
      && ((!claims.version && new Set(underspecifiedConflicts.map((candidate) => candidate.entity.claims.version)).size > 1)
        || (!claims.date && new Set(underspecifiedConflicts.map((candidate) => candidate.entity.claims.date)).size > 1)
        || (claims.variants.length === 0 && new Set(underspecifiedConflicts.map((candidate) => candidate.entity.claims.variants.join("+"))).size > 1)
        || (!claims.size && new Set(underspecifiedConflicts.map((candidate) => candidate.entity.claims.size)).size > 1)
        || (!claims.quantization && new Set(underspecifiedConflicts.map((candidate) => candidate.entity.claims.quantization)).size > 1));

    if (top && top.score >= AUTO_LINK_THRESHOLD && margin >= AUTO_LINK_MARGIN && !underspecifiedAmbiguity) {
      const confidence = Math.min(0.99, 0.6 + (top.score / 200) + Math.min(margin, 40) / 200);
      decisions.set(observation.id, decision({
        observationId: observation.id,
        entityId: top.entity.id,
        state: "linked",
        method: "structured_match",
        confidence,
        candidateEntityIds: ranked.slice(0, 5).map((candidate) => candidate.entity.id),
        evidence: top.evidence,
        blockers: top.blockers,
        score: top.score,
        margin,
      }));
      continue;
    }

    if (underspecifiedAmbiguity || underspecifiedConflictAmbiguity || (top && top.score >= AUTO_LINK_THRESHOLD && margin < AUTO_LINK_MARGIN)) {
      decisions.set(observation.id, decision({
        observationId: observation.id,
        entityId: null,
        state: "ambiguous",
        method: "none",
        confidence: 0,
        candidateEntityIds: (underspecifiedConflictAmbiguity ? underspecifiedConflicts : underspecifiedAmbiguity ? sameFamily : ranked).slice(0, 5).map((candidate) => candidate.entity.id),
        evidence: top?.evidence ?? [],
        blockers: ["insufficient-score-margin", ...conflictBlockers],
        score: top?.score ?? 0,
        margin,
      }));
      continue;
    }

    const providerNativeIdentity = observation.kind === "provider_model"
      && Boolean(claims.family && (claims.namespace || observation.organizationHint));
    const sufficientlySpecific = providerNativeIdentity
      || Boolean(claims.family && (claims.version || claims.date || claims.size || claims.variants.length > 0));
    if (sufficientlySpecific) {
      const entityId = stableEntityId(claims);
      if (rejectedTargets.has(entityId)) {
        decisions.set(observation.id, decision({
          observationId: observation.id,
          entityId: null,
          state: "rejected",
          method: "none",
          confidence: 0,
          candidateEntityIds: [entityId],
          evidence: [],
          blockers: [`reviewed-rejection:${entityId}`],
          score: 0,
          margin: 0,
        }));
        continue;
      }
      const existing = entities.get(entityId);
      if (existing && currentEntityIds.has(entityId) && hardConflicts(claims, existing.claims).length > 0) {
        const disambiguated = stableEntityId(claims, `${observation.sourceId}:${observation.nativeId}`);
        if (entities.has(disambiguated) && hardConflicts(claims, entities.get(disambiguated)!.claims).length > 0) {
          throw new Error(`Catalog identity hash collision for ${disambiguated}`);
        }
        decisions.set(observation.id, decision({
          observationId: observation.id,
          entityId: null,
          state: "ambiguous",
          method: "none",
          confidence: 0,
          candidateEntityIds: [entityId, disambiguated],
          evidence: [],
          blockers: ["historical-identity-collision"],
          score: 0,
          margin: 0,
        }));
        continue;
      }
      if (!existing || !currentEntityIds.has(entityId)) {
        entities.set(entityId, {
          ...existing,
          id: entityId,
          stableSlug: existing?.stableSlug ?? slug(entityId.replace(/\//g, "--")),
          preferredName: observation.observedName || leastDestructiveName(observation.nativeId),
          organizationId: claims.creator ? `org/${claims.creator}` : null,
          claims,
        });
      }
      currentEntityIds.add(entityId);
      decisions.set(observation.id, decision({
        observationId: observation.id,
        entityId,
        state: "linked",
        method: "native_id",
        confidence: observation.kind === "provider_model" ? 0.85 : 0.75,
        candidateEntityIds: [entityId],
        evidence: [`new-${observation.kind}-identity:${claims.identityKey}`],
        blockers: conflictBlockers,
        score: AUTO_LINK_THRESHOLD,
        margin: AUTO_LINK_MARGIN,
      }));
      continue;
    }

    decisions.set(observation.id, decision({
      observationId: observation.id,
      entityId: null,
      state: "unresolved",
      method: "none",
      confidence: 0,
      candidateEntityIds: ranked.slice(0, 5).map((candidate) => candidate.entity.id),
      evidence: [],
      blockers: ["insufficient-identity-evidence", ...conflictBlockers],
      score: top?.score ?? 0,
      margin,
    }));
  }

  const supported = new Set([...decisions.values()].filter((item) => item.state === "linked" && item.entityId).map((item) => item.entityId as string));
  return {
    entities: [...entities.values()].filter((entity) => supported.has(entity.id)).sort((left, right) => left.id.localeCompare(right.id)),
    decisions: [...decisions.values()].sort((left, right) => left.observationId.localeCompare(right.observationId)),
  };
}

export function planIdentityRemap(previous: IdentityDecision[], next: IdentityDecision[]) {
  const previousByObservation = new Map(previous.map((item) => [item.observationId, item.entityId]));
  const nextByObservation = new Map(next.map((item) => [item.observationId, item.entityId]));
  const remaps = [...nextByObservation.entries()].filter(([observationId, entityId]) => previousByObservation.get(observationId) !== entityId)
    .map(([observationId, entityId]) => ({ observationId, fromEntityId: previousByObservation.get(observationId) ?? null, toEntityId: entityId }))
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  const targetToSources = new Map<string, Set<string>>();
  const sourceToTargets = new Map<string, Set<string>>();
  for (const remap of remaps) {
    if (!remap.fromEntityId || !remap.toEntityId) continue;
    const sources = targetToSources.get(remap.toEntityId) ?? new Set<string>();
    sources.add(remap.fromEntityId);
    targetToSources.set(remap.toEntityId, sources);
    const targets = sourceToTargets.get(remap.fromEntityId) ?? new Set<string>();
    targets.add(remap.toEntityId);
    sourceToTargets.set(remap.fromEntityId, targets);
  }
  return {
    remaps,
    merges: [...targetToSources].filter(([, sources]) => sources.size > 1).map(([toEntityId, sources]) => ({ fromEntityIds: [...sources].sort(), toEntityId })),
    splits: [...sourceToTargets].filter(([, targets]) => targets.size > 1).map(([fromEntityId, targets]) => ({ fromEntityId, toEntityIds: [...targets].sort() })),
  };
}
