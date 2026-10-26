import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
// Build the repository first. Optional --before --code-root points to a saved
// server/ and builtin/ build. --queue-only profiles the unchanged Host backlog.
const option = name => process.argv[process.argv.indexOf(name) + 1];
const before=process.argv.includes('--before');
const repository = fileURLToPath(new URL('../../', import.meta.url));
const outputFile = process.argv.includes('--output') ? option('--output') : join(tmpdir(), `tx5dr-auto-upload-${before ? 'before' : 'after'}-${Date.now()}.json`);
if (before && !process.argv.includes('--code-root')) throw new Error('--before requires --code-root');
const queueOnly=process.argv.includes('--queue-only');
const rootCode=before?option('--code-root'):join(repository,'packages');
const location=(pkg,file)=>before?`${rootCode}/${pkg==='builtin-plugins'?'builtin':pkg}/${file}`:`${rootCode}/${pkg}/dist/${file}`;
const load=(pkg,file)=>import(pathToFileURL(location(pkg,file)).href);
const { ADIFLogProvider }=await load('server','log/ADIFLogProvider.js');
const { encodeAdifRecord }=await load('server','log/persistence/AdifCodec.js');
const { snapshotPluginData,markDetachedPluginData }=await load('server','plugin/plugin-data-boundary.js');
const { PluginStorageProvider }=await load('server','plugin/PluginStorageProvider.js');
const { PluginFileStoreProvider }=await load('server','plugin/PluginFileStoreProvider.js');
const { QRZSyncProvider }=await load('builtin-plugins','qrz-sync/provider.js');
const { LoTWSyncProvider }=await load('builtin-plugins','lotw-sync/provider.js');
const { ClubLogSyncProvider }=await load('builtin-plugins','clublog-sync/provider.js');
const { WaveLogSyncProvider }=await load('builtin-plugins','wavelog-sync/provider.js');
const { qsoIdentity }=await load('builtin-plugins','wavelog-sync/qso-identity.js');
let fullSnapshots=0,checkpointBytes=0,checkpointWrites=0;
const results=[]; const root=await mkdtemp(join(tmpdir(),'tx5dr-auto-benchmark-'));
const qso=i=>({id:`bench-${i}`,callsign:i%4===0?'K1ABC':`K${i%10}TEST${i}`,myCallsign:'BG5DRB',myGrid:'PM01AA',mode:'FT8',frequency:14074000,startTime:Date.UTC(2026,0,1)+i*60000,endTime:Date.UTC(2026,0,1)+i*60000+45000,messageHistory:['CQ K1ABC FN31','BG5DRB K1ABC -10'],notes:'x'.repeat(150)});
async function measure(size,name,run,action){
 await delay(20);let last=performance.now(),max=0;const timer=setInterval(()=>{const now=performance.now();max=Math.max(max,now-last);last=now;},1);
 const start=performance.now();const heap=process.memoryUsage();fullSnapshots=0;checkpointBytes=0;checkpointWrites=0;let result;
 try{result=await action();}catch(error){result={error:String(error)};}
 const elapsed=performance.now()-start;await delay(15);clearInterval(timer);
 const row={size,name,run,elapsedMs:+elapsed.toFixed(2),maxTimerGapMs:+max.toFixed(2),fullSnapshots,checkpointBytes,checkpointWrites,rssMiB:+(process.memoryUsage().rss/1048576).toFixed(1),heapDeltaMiB:+((process.memoryUsage().heapUsed-heap.heapUsed)/1048576).toFixed(1),result};
 results.push(row);await writeFile(outputFile,JSON.stringify({environment:{node:process.version,platform:process.platform,arch:process.arch,before},results},null,2));process.stdout.write(JSON.stringify(row)+'\n');return result;
}
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
// Synthetic stored certificate envelope; the RSA signing key and compression are real.
const cert={id:'bench',callsign:'BG5DRB',dxccId:291,serial:'1234',validFrom:Date.UTC(2025,0,1),validTo:Date.UTC(2028,0,1),qsoStartDate:Date.UTC(2025,0,1),qsoEndDate:Date.UTC(2028,0,1),fingerprint:'FIXTURE',certPem:'-----BEGIN CERTIFICATE-----\nRklYVFVSRQ==\n-----END CERTIFICATE-----',privateKeyPem:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
const stores=[];let book;
try{
if(queueOnly) {
  const { LogbookSyncHost } = await load('server','plugin/LogbookSyncHost.js');
  for (const size of [10000,50000]) {
    const host = new LogbookSyncHost();
    process.env.TX5DR_PLUGIN_DATA_DIR = join(root, String(size), 'queue');
    await host.initialize(join(root, String(size)));
    const provider = { id: 'queue-fixture', displayName: 'Fixture', settingsPageId: 'settings',
      isConfigured: () => true, isAutoUploadEnabled: () => true,
      upload: async (_callsign, options) => ({ uploaded: 0, skipped: 0, failed: options.records.length }),
      download: async () => ({ downloaded: 0, matched: 0, updated: 0 }), testConnection: async () => ({ success: true }) };
    const owner = { generation: 1, isCurrent: () => true, invoke: async (_operation, callback) => callback(), invokeSync: (_operation, callback) => callback() };
    host.register('queue-fixture', provider, owner);
    await host.onQSOsComplete('BG5DRB', Array.from({ length: size }, (_,i) => qso(i)));
    await delay(100);
    await measure(size,'host-one-qso-with-backlog',1,async () => { await host.onQSOComplete('BG5DRB', qso(size)); await delay(100); return {}; });
    await host.shutdown();
  }
} else for(const size of [10000,50000]){
 const dir=join(root,String(size));const files=new PluginFileStoreProvider(dir);const records=Array.from({length:size+6},(_,i)=>qso(i));await files.write('log.adi',Buffer.concat([Buffer.from('<ADIF_VER:5>3.1.4<EOH>\n'),...records.flatMap(record=>[encodeAdifRecord(record),Buffer.from('\n')])]));
 book=new ADIFLogProvider({logFilePath:join(dir,'log.adi'),logFileName:'log.adi',autoCreateFile:false});await measure(size,'cold-logbook-open',0,()=>book.initialize());
 // This adapter reproduces the old/new public snapshot isolation behavior.
 // Factory/Guard tests separately verify the detached marker and copy count.
 const access={getLogBookId:async()=> 'bench',queryQSOs:async f=>snapshotPluginData(await book.queryQSOs(f),'structured'),readQsoSnapshot:async f=>{if(!f?.ids&&!f?.timeRange)fullSnapshots++;const once=snapshotPluginData(await book.readQsoSnapshot(f),'structured');return before?snapshotPluginData(once,'structured'):markDetachedPluginData(once);},applyQsoBatch:async(m,o)=>snapshotPluginData(await book.applyQsoBatch(snapshotPluginData(m,'structured'),o),'structured'),notifyUpdated:async()=>{}};
 async function ctx(name){const store=new PluginStorageProvider(join(dir,name+'.json'));await store.init();stores.push(store);return{store:{global:store},files,logbook:{forCallsign:()=>access},log:{info(){},warn(){},debug(){},error(){}},fetch:async(url,init)=>{
 if(url.includes('qrz'))return new Response('RESULT=OK');if(url.includes('clublog'))return new Response('QSO OK');if(url.includes('lotw'))return new Response('<!-- .UPL. accepted -->');
 if(url.endsWith('/token'))return new Response(JSON.stringify({data:{scopes:['station:read','qso:read','qso:write','confirmation:read']}}));
 if(url.endsWith('/station'))return new Response(JSON.stringify({data:[{id:1,callsign:'BG5DRB',name:'Fixture'}]}));
 const n=(JSON.parse(init.body).adif.match(/<eor>/ig)??[]).length;return new Response(JSON.stringify({data:{parsed:n,imported:n,skipped:0,messages:[]}}),{status:201});}};}
 const qrzCtx=await ctx('qrz');const qrz=new QRZSyncProvider(qrzCtx);qrz.setConfig('BG5DRB',{apiKey:'fixture',autoUploadQSO:true});
 const lotwCtx=await ctx('lotw');const lotw=new LoTWSyncProvider(lotwCtx);lotw.setConfig('BG5DRB',{username:'fixture',password:'fixture',autoUploadQSO:true,uploadLocation:{callsign:'BG5DRB',dxccId:291,gridSquare:'PM01AA',cqZone:'24',ituZone:'44',state:'CA',county:'Santa Clara'}});await files.write('callsigns/BG5DRB/certificates/bench.json',Buffer.from(JSON.stringify(cert)));
 process.env.TX5DR_CLUBLOG_API_KEY='fixture';const clubCtx=await ctx('club');const club=new ClubLogSyncProvider(clubCtx);club.setConfig('BG5DRB',{email:'fixture@example.test',password:'fixture',autoUploadQSO:true});const ledger={};for(let i=0;i<size;i++)club.markUploaded('BG5DRB',ledger,records[i],'realtime_ok','realtime');await club.setLedger('BG5DRB',ledger);await clubCtx.store.global.flush();
 const waveCtx=await ctx('wave');const waveFiles=waveCtx.files;waveCtx.files={...files,read:p=>waveFiles.read(p),write:async(p,bytes)=>{checkpointBytes+=bytes.length;checkpointWrites++;await waveFiles.write(p,bytes);}};const wave=new WaveLogSyncProvider(waveCtx);wave.setConfig('BG5DRB',{url:'https://fixture.invalid',apiKey:'wl2_fixture',stationId:'1',apiVersion:'v2',autoUploadQSO:true});const runtime=await wave.sync.runtime('BG5DRB',wave.getConfig('BG5DRB'));runtime.known=new Set(records.slice(0,size).map(record=>qsoIdentity(record,'BG5DRB')));runtime.checkpoint.receipts=Object.fromEntries(records.slice(0,size).map(record=>[record.id,qsoIdentity(record,'BG5DRB')]));runtime.checkpoint.stationCheckedAt=Date.now();await wave.sync.save(runtime);
 for(let run=1;run<=5;run++){
  const record=records[size+run-1];
  await measure(size,'qrz-auto',run,()=>qrz.upload('BG5DRB',{trigger:'auto',records:[record]}));
  await measure(size,'lotw-auto-real-signing',run,()=>lotw.upload('BG5DRB',{trigger:'auto',records:[record]}));
  await measure(size,'wavelog-auto',run,()=>wave.upload('BG5DRB',{trigger:'auto',records:[record]}));
  await measure(size,'clublog-auto-including-flush',run,async()=>{const result=await club.upload('BG5DRB',{trigger:'auto',records:[record]});await clubCtx.store.global.flush();return result;});
 }
 const record=records[size+5];await measure(size,'four-providers-concurrent',1,async()=>await Promise.all([qrz,lotw,wave,club].map(provider=>provider.upload('BG5DRB',{trigger:'auto',records:[record]}))));
 await book.close();book=undefined;
 for(const store of stores.splice(0)){await store.flush();store.dispose();}
}
}finally{await book?.close();for(const store of stores){await store.flush();store.dispose();}await rm(root,{recursive:true,force:true});}
process.stdout.write(`Results: ${outputFile}\n`);

