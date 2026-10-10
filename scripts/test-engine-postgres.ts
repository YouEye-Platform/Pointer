import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Owned isolated cluster and loopback providers; never connects to a configured
// product database. Run through the operator's budgeted heavy-job executor.
const root=mkdtempSync(join(tmpdir(),'pointer-engine-pg-'));
const socket=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')});
const port=socket.port!;socket.stop(true);
const bin='/usr/lib/postgresql/17/bin/';let started=false;
const command=(name:string,args:string[])=>{const result=Bun.spawnSync([bin+name,...args]);if(result.exitCode)throw Error(result.stderr.toString());};
const env={...process.env,DATABASE_URL:`postgres://fixture@127.0.0.1:${port}/pointer_engine_test`,
 JWT_SECRET:'owned-fixture-only',ENCRYPTION_SECRET:'owned-fixture-only',CORS_ORIGIN:'http://127.0.0.1',
 POINTER_DEPLOYMENT_MODE:'standalone',POINTER_ENGINE_POSTGRES_TEST:'1',POINTER_ENGINE_STATE_DIR:root+'/engine',
 POINTER_DIAGNOSTIC_SPOOL:root+'/spool',POINTER_BACKGROUND_JOBS_ENABLED:'false'};
async function run(args:string[]){const p=Bun.spawn([process.execPath,...args],{env,stdout:'inherit',stderr:'inherit'});if(await p.exited)throw Error('Owned fixture check failed');}
try {
 command('initdb',['-D',root+'/pg','--auth=trust','--no-locale','-U','fixture']);
 command('pg_ctl',['-D',root+'/pg','-l',root+'/pg.log','-o',`-h 127.0.0.1 -p ${port} -k ${root}`,'-w','start']);started=true;
 command('createdb',['-h','127.0.0.1','-p',String(port),'-U','fixture','pointer_engine_test']);
 await run(['apps/server/scripts/migrate.ts','--expect-database','pointer_engine_test']);
 await run(['apps/server/scripts/migrate.ts','--expect-database','pointer_engine_test','--check']);
 // Engine fixture finalizers permanently stop their process-local pool. Keep
 // each runtime lifecycle isolated rather than reviving a stopped pool.
 for(const file of ['apps/server/src/routes/stats.postgres.test.ts','apps/server/src/routes/engine.postgres.test.ts','apps/server/src/routes/engine-failure.postgres.test.ts','apps/server/src/services/engine-receipt.postgres.test.ts'])
   await run(['test','--max-concurrency=1',file]);
}finally{if(started)command('pg_ctl',['-D',root+'/pg','-m','fast','-w','stop']);rmSync(root,{recursive:true});}
