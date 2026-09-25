import {startFoundationRuntime} from "../../runtime/bootstrap/src";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION,ChatRequest} from "../../contracts/src";

function ok(value:unknown,label:string){if(!value)throw new Error(label);}
function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
async function main(){
  const runtime=await startFoundationRuntime();
  try{
    const request:ChatRequest={
      apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:"integration-1",model:"fake-chat",
      context:{conversationId:"integration-conversation",messages:[{role:"user",content:"hello"}]}
    };
    const response=await runtime.chat(request);
    equal(response.providerId,"fake.chat","composition root provider binding");
    equal(response.message.content,"fake response","offline deterministic response");
    equal((await runtime.aiRuntimeHealth()).status,"healthy","AI runtime health");
    const snapshot=await runtime.diagnostics();
    ok(snapshot.providers.some(provider=>provider.id==="fake.chat"&&provider.health?.status==="healthy"),"mock chat provider diagnostics");
  }finally{await runtime.stop();}
  console.log("PASS AI Runtime integration test");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
