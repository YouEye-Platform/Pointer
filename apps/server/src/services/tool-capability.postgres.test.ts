import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { db, schema } from "../db";
import { signJwt } from "../middleware/auth";
import accounts from "../routes/provider-accounts";
import { buildInstanceModelIndex, invalidateModelResolutionCache } from "./model-resolution";
import { assertCatalogPostgresTestDatabase } from "./catalog-postgres-test-safety";

const prefix="tools-evidence-test";
let ownerToken="", strangerToken="";
describe.skipIf(process.env.CATALOG_POSTGRES_TEST !== "1")("endpoint tool evidence integration", () => {
  beforeAll(async()=>{
    assertCatalogPostgresTestDatabase();
    for(const id of [prefix+"-owner",prefix+"-stranger"]) {
      await db.insert(schema.users).values({id,email:id+"@example.test",name:id,passwordHash:"unused",role:"user"});
    }
    ownerToken=await signJwt({id:prefix+"-owner",email:prefix+"-owner@example.test",name:"Owner",role:"user"});
    strangerToken=await signJwt({id:prefix+"-stranger",email:prefix+"-stranger@example.test",name:"Stranger",role:"user"});
    await db.insert(schema.providers).values({id:prefix,name:"Fixture",type:"openai-compatible",baseUrl:"https://example.test/v1"});
    await db.insert(schema.providerModels).values([
      {id:prefix+"-shared",providerId:prefix,modelId:prefix,providerModelId:prefix,supportsTools:false,rawMetadata:{id:prefix}},
      {id:prefix+"-negative",providerId:prefix,modelId:prefix+"-negative",providerModelId:prefix+"-negative",supportsTools:false,rawMetadata:{supports_tools:false}},
      {id:prefix+"-positive",providerId:prefix,modelId:prefix+"-positive",providerModelId:prefix+"-positive",supportsTools:true,rawMetadata:{id:prefix+"-positive"}},
    ]);
    for(const account of ["a","b"]) {
      await db.insert(schema.providerAccounts).values({id:prefix+"-"+account,userId:prefix+"-owner",providerId:prefix});
      await db.insert(schema.providerAccountModels).values({id:prefix+"-pam-"+account,providerAccountId:prefix+"-"+account,providerModelId:prefix+"-shared",rawMetadata:account==="a"?{id:prefix}:{id:prefix,supportsTools:false},discoveredAt:new Date("2026-01-01T00:00:00Z")});
      await db.insert(schema.instances).values({id:prefix+"-instance-"+account,userId:prefix+"-owner",name:"Owned fixture"});
      await db.insert(schema.instanceModels).values({id:prefix+"-im-"+account,instanceId:prefix+"-instance-"+account,providerId:prefix,providerAccountId:prefix+"-"+account,modelId:prefix,enabled:true});
    }
    invalidateModelResolutionCache();
  });
  afterAll(async()=>{
    for(const user of ["owner","stranger"]) await db.delete(schema.users).where(eq(schema.users.id,prefix+"-"+user));
    await db.delete(schema.providers).where(eq(schema.providers.id,prefix));
    invalidateModelResolutionCache();
  });
  test("same raw model ID retains different endpoint evidence", async()=>{
    const a=(await buildInstanceModelIndex(prefix+"-instance-a")).advertisedModels[0];
    const b=(await buildInstanceModelIndex(prefix+"-instance-b")).advertisedModels[0];
    expect(a.capabilities.tools).toBeNull();
    expect(a.capabilityEvidence?.tools).toMatchObject({status:"unknown",observedAt:"2026-01-01T00:00:00.000Z"});
    expect(b.capabilities.tools).toBe(false);
  });
  test("owned semantic override is immediate, independent of wire extensions and isolated", async()=>{
    const put=async(token:string,body:unknown)=>accounts.request("/"+prefix+"-a",{method:"PUT",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body)});
    expect((await put(strangerToken,{capabilityOverrides:{tools:true}})).status).toBe(404);
    expect((await put(ownerToken,{capabilityOverrides:{customTools:true}})).status).toBe(400);
    expect((await put(ownerToken,{capabilityOverrides:{tools:true}})).status).toBe(200);
    expect((await buildInstanceModelIndex(prefix+"-instance-a")).advertisedModels[0].capabilities.tools).toBe(true);
    expect((await buildInstanceModelIndex(prefix+"-instance-b")).advertisedModels[0].capabilities.tools).toBe(false);
    expect((await put(ownerToken,{capabilityOverrides:{tools:false}})).status).toBe(200);
    expect((await buildInstanceModelIndex(prefix+"-instance-a")).advertisedModels[0].capabilities.tools).toBe(false);
    expect((await put(ownerToken,{capabilityOverrides:{}})).status).toBe(200);
    expect((await buildInstanceModelIndex(prefix+"-instance-a")).advertisedModels[0].capabilities.tools).toBeNull();
  });
  test("migration reconciles inferred negatives and preserves explicit denial and positive evidence", async()=>{
    const migration=await readFile(new URL("../../drizzle/0023_tool_capability_evidence.sql",import.meta.url),"utf8");
    await db.execute(sql.raw(migration.slice(migration.indexOf("UPDATE provider_models"))));
    const rows=await db.select().from(schema.providerModels).where(eq(schema.providerModels.providerId,prefix));
    expect(rows.find(row=>row.id===prefix+"-shared")?.supportsTools).toBeNull();
    expect(rows.find(row=>row.id===prefix+"-negative")?.supportsTools).toBe(false);
    expect(rows.find(row=>row.id===prefix+"-positive")?.supportsTools).toBe(true);
  });
});
