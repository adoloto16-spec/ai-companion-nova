import {AgentOutputRunner,assertAgentCandidateId} from "../../core/src";
import {InMemoryDiagnosticsStore} from "../../core/src";
import {StandardContractValidator} from "../../contracts/src";
import type {ChatRequest,ChatResponse} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}
function response(request:ChatRequest,content:string):ChatResponse{
  return {apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.provider",model:request.model,message:{id:request.requestId,role:"assistant",content},finishReason:"stop"};
}
const baseRequest:ChatRequest={apiVersion:"1",schemaVersion:"1",requestId:"agent-output-test",model:"test-model",context:{conversationId:"conversation.a",messages:[{role:"user",content:"Remember this."}]}};
const schema={type:"object",additionalProperties:false,properties:{decision:{enum:["remember","no_memory"]},content:{type:"string"}},required:["decision","content"]};

async function main(){
  const validator=new StandardContractValidator();
  let calls:Array<ChatRequest>=[];
  let mode:"structured"|"plain"="structured";
  const runtime={async chat(request:ChatRequest){
    calls.push(request);
    if(mode==="structured")return response(request,'{"decision":"remember","content":"Stable fact."}');
    return response(request,"Stable fact.");
  }};
  const runner=new AgentOutputRunner(runtime,validator);
  const structured=await runner.run({
    outputMode:"structured",request:baseRequest,schemaName:"memory_agent_decision",schema,validator,
    parseStructured:value=>value as {decision:"remember";content:string},
    parsePlain:content=>({decision:"remember" as const,content})
  });
  equal(structured.metadata.effectiveOutputMode,"structured","explicit structured mode");
  equal(calls.length,1,"structured makes one request");
  equal(calls[0]?.generation?.responseFormat?.type,"json-schema","structured request carries provider-neutral schema");

  mode="plain";
  calls=[];
  const plain=await runner.run({
    outputMode:"plain",request:baseRequest,schemaName:"memory_agent_decision",schema,validator,
    parseStructured:value=>value as any,parsePlain:content=>({decision:"remember" as const,content})
  });
  equal(plain.metadata.effectiveOutputMode,"plain","plain mode");
  equal(calls[0]?.generation?.responseFormat,undefined,"plain request has no responseFormat");

  let structuredUnsupported=true;
  calls=[];
  const autoRuntime={async chat(request:ChatRequest){
    calls.push(request);
    if(structuredUnsupported){
      structuredUnsupported=false;
      const error=Object.assign(new Error("unsupported response_format"),{chatError:{code:"UNSUPPORTED",details:{category:"capability"}}});
      throw error;
    }
    return response(request,"Auto plain memory");
  }};
  const auto=new AgentOutputRunner(autoRuntime,validator);
  const autoResult=await auto.run({
    outputMode:"auto",request:baseRequest,schemaName:"memory_agent_decision",schema,validator,
    parseStructured:value=>value as any,parsePlain:content=>({decision:"remember" as const,content})
  });
  equal(autoResult.metadata.fallback,true,"auto fallback only after capability failure");
  equal(calls.length,2,"auto makes structured then plain");
  equal(calls[0]?.generation?.responseFormat?.type,"json-schema","auto first request structured");
  equal(calls[1]?.generation?.responseFormat,undefined,"auto fallback plain request");

  for(const error of [
    Object.assign(new Error("401"),{chatError:{code:"PROVIDER_ERROR",details:{category:"authentication",httpStatus:401}}}),
    Object.assign(new Error("429"),{chatError:{code:"PROVIDER_ERROR",details:{category:"rate_limit",httpStatus:429}}}),
    Object.assign(new Error("timeout"),{chatError:{code:"PROVIDER_ERROR",details:{category:"timeout"}}}),
    Object.assign(new Error("network"),{chatError:{code:"PROVIDER_UNAVAILABLE",details:{category:"network"}}}),
    Object.assign(new Error("invalid response"),{chatError:{code:"INVALID_RESPONSE",details:{category:"malformed_response"}}}),
    Object.assign(new Error("schema"),{code:"SCHEMA_INVALID"})
  ]){
    let count=0;
    const failing={async chat(_request:ChatRequest){count++;throw error;}};
    const autoFail=new AgentOutputRunner(failing,validator);
    await autoFail.run({
      outputMode:"auto",request:baseRequest,schemaName:"memory_agent_decision",schema,validator,
      parseStructured:value=>value as any,parsePlain:content=>({decision:"remember" as const,content}),
      diagnostics:new InMemoryDiagnosticsStore()
    }).then(()=>{throw new Error("non-capability failure unexpectedly succeeded")}).catch(()=>{});
    equal(count,1,"auto never retries non-capability failure");
  }

  assertAgentCandidateId("memory-2",["memory-1","memory-2"]);
  let unknownRejected=false;
  try{assertAgentCandidateId("memory-999",["memory-1","memory-2"])}catch{unknownRejected=true}
  equal(unknownRejected,true,"unknown agent ID is rejected before mutation");
  console.log("PASS Agent Output runner tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
