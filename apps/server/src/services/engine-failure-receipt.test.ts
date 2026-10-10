import {test,expect} from "bun:test";
import {projectEngineAttempts} from "./engine-failure-receipt";
test("supported request log is matched exactly and projected without payload or other request data",()=>{
 const log={logs:[{requestId:"ABCDEF0",private:"secret",attempts:[{ordinal:1,sendCount:2,status:200,durationMs:6000,streamAborted:true,errorCode:"upstream_reset",message:"secret",url:"private"}]},{requestId:"OTHER00",attempts:[]}]};
 expect(projectEngineAttempts(log,"ABCDEF0")).toEqual([{ordinal:1,sendCount:2,status:200,durationMs:6000,streamAborted:true,errorCode:"upstream_reset"}]);
 expect(JSON.stringify(projectEngineAttempts(log,"ABCDEF0"))).not.toContain("secret");
 expect(projectEngineAttempts(log,"MISSING")).toBeNull();
 expect(projectEngineAttempts({logs:[log.logs[0],log.logs[0]]},"ABCDEF0")).toBeNull();
});
test("malformed, duplicated, excessive and unknown attempts cannot become false complete evidence",()=>{
 for(const attempts of [[{ordinal:1,sendCount:-1,status:200,durationMs:1}],Array(33).fill({ordinal:1}),[{ordinal:1,sendCount:1,status:200,durationMs:1},{ordinal:1,sendCount:1,status:200,durationMs:1}]])
  expect(projectEngineAttempts({logs:[{requestId:"ABCDEF0",attempts}]},"ABCDEF0")).toBeNull();
 expect(projectEngineAttempts({logs:[{requestId:"ABCDEF0",attempts:[{ordinal:1,sendCount:1,status:200,durationMs:1,errorCode:"secret"}]}]},"ABCDEF0")?.[0].errorCode).toBeNull();
});
