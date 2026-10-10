import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {config} from "../config";
import {EngineReceiptSpool} from "./engine-receipt-spool";
import { db, schema } from "../db";
import type {EngineFailureReceipt} from "./engine-failure-receipt";
import {
  calculateThroughput,
  calculateUsageCost,
  finitePrice,
  sanitizeErrorMessage,
  type ExtendedMetrics,
  type PriceSnapshot,
} from "./usage-metrics";

export { classifyUsageError } from "./usage-metrics";
export type { ExtendedMetrics, UsageOutcome } from "./usage-metrics";

export interface UsageContext {
  requestId?: string;
  apiKeyId?: string;
  userId: string;
  instanceId: string;
  modelId: string;
  catalogEntityId?: string | null;
  providerId: string;
  providerAccountId?: string | null;
  source?: "proxy" | "test";
}

export function buildUsageValues(
  ctx: UsageContext,
  pricing: PriceSnapshot,
  providerType: string,
  inputTokens: number,
  outputTokens: number,
  statusCode: number,
  latencyMs: number,
  ttfbMs?: number | null,
  source?: "proxy" | "test",
  metrics?: ExtendedMetrics,
) {
  const cost = calculateUsageCost(pricing, inputTokens, outputTokens, providerType, metrics);
  const throughput = calculateThroughput(outputTokens, metrics);
  const usageSource = source ?? ctx.source ?? "proxy";
  return {
    apiKeyId: usageSource === "test" ? null : ctx.apiKeyId || null,
    userId: ctx.userId, instanceId: ctx.instanceId, modelId: ctx.modelId,
    failureReceipt: metrics?.failureReceipt ?? null,
    requestId: ctx.requestId ?? null, upstreamErrorCode: metrics?.upstreamErrorCode ?? null,
    catalogEntityId: ctx.catalogEntityId ?? null, providerId: ctx.providerId,
    providerAccountId: ctx.providerAccountId ?? null,
    inputTokens, outputTokens,
    cachedTokens: metrics?.cachedTokens ?? null, reasoningTokens: metrics?.reasoningTokens ?? null,
    cacheCreationTokens: metrics?.cacheCreationTokens ?? null, cacheReadTokens: metrics?.cacheReadTokens ?? null,
    costUsd: cost.costUsd === null ? null : String(cost.costUsd), costStatus: cost.status,
    inputPriceSnapshot: pricing.inputPrice === null ? null : String(pricing.inputPrice),
    outputPriceSnapshot: pricing.outputPrice === null ? null : String(pricing.outputPrice), priceSource: pricing.source,
    latencyMs, ttfbMs: ttfbMs ?? null, generationMs: throughput.generationMs,
    tokensPerSecond: throughput.tokensPerSecond === null ? null : String(throughput.tokensPerSecond),
    queueTimeMs: metrics?.queueTimeMs ?? null, promptTimeMs: metrics?.promptTimeMs ?? null,
    completionTimeMs: metrics?.completionTimeMs ?? null, processingMs: metrics?.processingMs ?? null,
    statusCode, errorType: metrics?.errorType ?? null, errorMessage: sanitizeErrorMessage(metrics?.errorMessage),
    outcome: metrics?.outcome ?? (statusCode >= 400 ? "upstream_error" : "success"), source: usageSource,
  };
}

const receiptSpool=new EngineReceiptSpool(process.env.POINTER_DIAGNOSTIC_SPOOL || (config.mode === 'managed' ? '/var/lib/pointer/diagnostic-spool' : './data/diagnostic-spool'));
const inFlightIds=new Set<string>();
export const usageDiagnosticCoverage=(owner:string)=>receiptSpool.coverage(owner);
let replaying=false;
let replayTimer: ReturnType<typeof setInterval> | undefined;
export function startUsageReceiptReplay() {
 if(replayTimer)return;
 const tick=async()=>{if(replaying)return;replaying=true;try{await receiptSpool.replay(async(id,value)=>{
  if(inFlightIds.has(id))return false;
  await db.insert(schema.usageLogs).values({id,...value,createdAt:new Date(value.createdAt as string)} as any).onConflictDoNothing();
 });}catch{console.error('[usage] Diagnostic receipt replay deferred');}finally{replaying=false;}};
 replayTimer=setInterval(()=>void tick(),5000);replayTimer.unref();void tick();
}
const pendingWrites = new Set<Promise<void>>();

function trackWrite(write: Promise<unknown>): void {
  const tracked = write
    .then(() => undefined)
    .catch(() => console.error("[usage] Database write failed"))
    .finally(() => pendingWrites.delete(tracked));
  pendingWrites.add(tracked);
}

export function recordUsage(
  ctx: UsageContext,
  inputTokens: number,
  outputTokens: number,
  statusCode: number,
  latencyMs: number,
  ttfbMs?: number | null,
  source?: "proxy" | "test",
  metrics?: ExtendedMetrics & {failureReceiptPending?: Promise<EngineFailureReceipt>}
): void {
  const id=nanoid(), createdAt=new Date();inFlightIds.add(id);
  const write = (async()=>{
    const failureReceipt=await (metrics?.failureReceiptPending ?? Promise.resolve(metrics?.failureReceipt));
    const measured={...metrics,failureReceipt};
    const fallback=buildUsageValues(ctx,{inputPrice:null,outputPrice:null,source:null},'unknown',inputTokens,outputTokens,statusCode,latencyMs,ttfbMs,source,measured);
    // Persist safe measured facts before any price or database query. A later
    // replay retains unknown price rather than inventing historical pricing.
    if(failureReceipt)receiptSpool.retain(id,{...fallback,createdAt});
    const [[providerModel],[provider]]=await Promise.all([
      db.select({inputPrice:schema.providerModels.inputPrice,outputPrice:schema.providerModels.outputPrice}).from(schema.providerModels)
        .where(and(eq(schema.providerModels.providerId,ctx.providerId),eq(schema.providerModels.modelId,ctx.modelId))).limit(1),
      db.select({type:schema.providers.type}).from(schema.providers).where(eq(schema.providers.id,ctx.providerId)).limit(1),
    ]);
    const pricing:PriceSnapshot={inputPrice:finitePrice(providerModel?.inputPrice),outputPrice:finitePrice(providerModel?.outputPrice),source:providerModel?'provider_models':null};
    const values=buildUsageValues(ctx,pricing,provider?.type || 'openai-compatible',inputTokens,outputTokens,statusCode,latencyMs,ttfbMs,source,measured);
    if(failureReceipt)receiptSpool.retain(id,{...values,createdAt});
    await db.insert(schema.usageLogs).values({id,...values,createdAt}).onConflictDoNothing();
    receiptSpool.acknowledge(id);
  })().finally(()=>inFlightIds.delete(id));

  trackWrite(write);
}

export async function drainUsageWrites(timeoutMs = 5000): Promise<boolean> {
  if (pendingWrites.size === 0) return true;
  const drained = Promise.allSettled([...pendingWrites]).then(() => true);
  const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  return Promise.race([drained, timedOut]);
}

export function pendingUsageWriteCount(): number {
  return pendingWrites.size;
}
