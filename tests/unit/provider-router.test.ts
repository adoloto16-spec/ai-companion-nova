import assert from "node:assert/strict";
import {ProviderCredentialRouter} from "../../core/src/provider-router";
import type {ChatProvider} from "../../contracts/src/index";

function failure(status:number,retryAfterMs?:number){
  const error:any=new Error("provider failure");
  error.chatError={details:{httpStatus:status,...(retryAfterMs===undefined?{}:{retryAfterMs})}};
  return error;
}
function provider(id:string,handler:(count:number)=>Promise<any>){
  let calls=0;
  const value:ChatProvider={
    id,
    metadata:()=>({id,kind:"chat",displayName:id,version:"test"}),
    capabilities:()=>({streaming:false}),
    listModels:async()=>[],
    chat:async request=>{const result=await handler(calls++);return result},
    health:async()=>({status:"healthy",capabilities:["chat"]})
  };
  return value;
}
const reference=(id:string)=>({id:"ref-"+id,kind:"api-key" as const});
const credentials=[
  {id:"A",label:"A",credentialReference:reference("A"),health:"healthy" as const,failureCount:0},
  {id:"B",label:"B",credentialReference:reference("B"),health:"healthy" as const,failureCount:0}
];
async function main(){
  let aCalls=0,bCalls=0;
  const router=new ProviderCredentialRouter({
    presetId:"preset",
    credentials,
    createProvider:credential=>provider(credential.id,async()=>{
      if(credential.id==="A"){aCalls++;if(aCalls===1)throw failure(500);}
      if(credential.id==="B")bCalls++;
      return{ok:true,id:credential.id};
    })
  });
  const success=await router.chat({apiVersion:"1",schemaVersion:"1",requestId:"req",model:"test-model",context:{conversationId:"c",messages:[]},messages:[]});
  assert.equal((success as any).id,"B","credential B is selected after credential A provider failure");
  assert.equal(aCalls,1);assert.equal(bCalls,1);

  const router429=new ProviderCredentialRouter({
    presetId:"preset",
    credentials:[
      {id:"A",label:"A",credentialReference:reference("A"),health:"healthy",failureCount:0},
      {id:"B",label:"B",credentialReference:reference("B"),health:"healthy",failureCount:0}
    ],
    clock:()=>1000,
    createProvider:credential=>provider(credential.id,async()=>credential.id==="A"?Promise.reject(failure(429,5000)):Promise.resolve({ok:true,id:"B"}))
  });
  const rateLimited=await router429.chat({apiVersion:"1",schemaVersion:"1",requestId:"req2",model:"test-model",context:{conversationId:"c",messages:[]},messages:[]});
  assert.equal((rateLimited as any).id,"B","429 credential is cooled down and the next healthy credential is selected");
  assert.equal(router429.getCredentialState()[0]?.health,"degraded");
  assert.equal(router429.getCredentialState()[0]?.cooldownUntil,"1970-01-01T00:00:06.000Z");

  const unavailable=new ProviderCredentialRouter({
    presetId:"preset",
    credentials:[{id:"A",label:"A",credentialReference:reference("A"),health:"degraded",failureCount:1,cooldownUntil:"2999-01-01T00:00:00.000Z"}],
    createProvider:credential=>provider(credential.id,async()=>Promise.resolve({ok:true}))
  });
  let rejected=0;
  try{await unavailable.chat({apiVersion:"1",schemaVersion:"1",requestId:"req3",model:"test-model",context:{conversationId:"c",messages:[]},messages:[]})}catch(error){rejected++;assert.equal((error as any).chatError?.retryable,true)}
  assert.equal(rejected,1,"all unavailable credentials fail as recoverable instead of rotating indefinitely");
  console.log("PASS Provider credential router tests");
}
main().catch(error=>{console.error(error);process.exitCode=1});
