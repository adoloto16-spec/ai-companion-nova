import {InMemoryChatTraceStore,InMemoryDiagnosticsStore,redactDiagnosticText} from "../../core/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  equal(redactDiagnosticText("Authorization: Bearer abcdefghijklmnop"),"Authorization: Bearer [REDACTED]","bearer redaction");
  equal(redactDiagnosticText("apiKey: super-secret"),"apiKey: [REDACTED]","api key redaction");
  equal(redactDiagnosticText("password: p@ssword"),"password: [REDACTED]","password redaction");

  const diagnostics=new InMemoryDiagnosticsStore(2);
  diagnostics.recordError("test","ONE","first");
  diagnostics.recordError("test","TWO","second");
  diagnostics.recordError("test","THREE","third");
  equal(diagnostics.recentErrors().map(error=>error.code),["THREE","TWO"],"diagnostic retention is bounded");

  const traces=new InMemoryChatTraceStore();
  traces.configure("normal",3);
  traces.start({turnId:"a",requestId:"a",characterId:"character.a",conversationId:"conversation.a",timestamp:"2026-10-01T00:00:00.000Z"});
  traces.update("a",{status:"completed",finalRequest:{
    apiVersion:"1",schemaVersion:"1",requestId:"a",model:"fake",
    context:{conversationId:"conversation.a",messages:[{role:"user",content:"apiKey: top-secret"}]},
    metadata:{authorization:"Bearer abcdefghijklmnop"}
  }});
  const storedA=traces.recent(10).find(trace=>trace.turnId==="a");
  ok(Boolean(storedA),"first trace exists before retention rolls over");
  ok(!JSON.stringify(storedA).includes("top-secret"),"trace strips API keys");
  equal(storedA?.finalRequest?.metadata?.authorization,"[REDACTED]","trace strips authorization metadata");

  traces.start({turnId:"b",requestId:"b",characterId:"character.a",conversationId:"conversation.a",timestamp:"2026-10-01T00:00:01.000Z"});
  traces.update("b",{status:"interrupted"});
  traces.start({turnId:"c",requestId:"c",characterId:"character.a",conversationId:"conversation.a",timestamp:"2026-10-01T00:00:02.000Z"});
  traces.update("c",{status:"completed"});

  equal(traces.recent().length,2,"trace retention is bounded");
  const latest=traces.recent()[0];
  ok(Boolean(latest),"latest trace exists");

  traces.configure("errors",10);
  const errors=traces.recent(10);
  equal(errors.length,1,"errors log level filters completed traces");
  equal(errors[0]?.status,"interrupted","errors log level keeps interruption trace");

  traces.configure("off",10);
  equal(traces.recent().length,0,"off log level hides traces");
  console.log("PASS diagnostics trace and redaction tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
