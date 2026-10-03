import {
  ChatSessionController,
  ConversationSession
} from "../../core/src";
import {defaultAppSettings} from "../../contracts/src";
import type {
  ChatRequest,
  RetrievalIndexDocument,
  RetrievalQuery,
  RetrievalResult,
  RetrievalCandidate,
  MemoryItem
} from "../../contracts/src";
import {
  IpcFullTextRetriever,
  RETRIEVAL_COMMANDS,
  type RetrievalStoreInvoke
} from "../../host/retrieval/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {InMemoryMemoryStore} from "../../host/memory/src";
import {startFoundationRuntime} from "../../runtime/bootstrap/src";

function equal(actual:unknown,expected:unknown,label:string){
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual));
}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

function memoryCandidate(document:RetrievalIndexDocument,query:RetrievalQuery):RetrievalCandidate{
  return {
    source:"memory",
    sourceId:document.sourceId,
    characterId:document.characterId,
    conversationId:document.conversationId,
    score:1,
    matchedText:"Нова",
    matches:[{field:"content",text:"[[MATCH]]Нова[[/MATCH]] имеет фиолетовые волосы"}],
    metadata:{
      title:null,
      status:document.status??null,
      type:document.type??null,
      updatedAt:document.updatedAt
    }
  };
}

async function main(){
  const characterStore=new InMemoryCharacterStore();
  const memoryStore=new InMemoryMemoryStore();
  const documents=new Map<string,RetrievalIndexDocument>();
  const retrievalQueries:RetrievalQuery[]=[];
  const retrievalResults:RetrievalResult[]=[];
  const commands:string[]=[];

  const invoke:RetrievalStoreInvoke=async(command,args)=>{
    commands.push(command);
    if(command===RETRIEVAL_COMMANDS.rebuildAll)return undefined;
    if(command===RETRIEVAL_COMMANDS.rebuild||command===RETRIEVAL_COMMANDS.removeCharacter)return undefined;
    if(command===RETRIEVAL_COMMANDS.remove){
      const characterId=String(args?.characterId??"");
      const sourceId=String(args?.sourceId??"");
      documents.delete(characterId+":"+sourceId);
      return undefined;
    }
    if(command===RETRIEVAL_COMMANDS.upsert){
      const document=args?.document as RetrievalIndexDocument|undefined;
      if(!document)throw new Error("test IPC missing retrieval document");
      documents.set(document.characterId+":"+document.sourceId,JSON.parse(JSON.stringify(document)) as RetrievalIndexDocument);
      return undefined;
    }
    if(command===RETRIEVAL_COMMANDS.search){
      const query=args?.query as RetrievalQuery|undefined;
      if(!query)throw new Error("test IPC missing retrieval query");
      retrievalQueries.push(JSON.parse(JSON.stringify(query)) as RetrievalQuery);
      const candidates=[...documents.values()]
        .filter(document=>document.source==="memory")
        .filter(document=>document.characterId===query.characterId)
        .filter(document=>document.conversationId===query.conversationId)
        .filter(document=>document.status==="active")
        .filter(document=>document.content.includes("Нова"))
        .map(document=>memoryCandidate(document,query));
      const result:RetrievalResult={
        apiVersion:"1",
        schemaVersion:"1",
        characterId:query.characterId,
        query:query.query,
        candidates,
        degraded:false
      };
      retrievalResults.push(result);
      return result;
    }
    throw new Error("Unexpected retrieval IPC command: "+command);
  };

  const retriever=new IpcFullTextRetriever(invoke);
  const runtime=await startFoundationRuntime({
    characterStore,
    memoryStore,
    retriever,
    retrievalIndexWriter:retriever
  });
  await runtime.start();
  try{
    const character=await runtime.getActiveCharacter();
    const conversation=await runtime.getActiveConversation(character.id);
    const memory=await runtime.createMemory(character.id,{
      id:"memory.production.nova-hair",
      conversationId:conversation.id,
      type:"observation",
      content:"Нова имеет фиолетовые волосы",
      tags:["Нова","волосы"],
      importance:95,
      confidence:90,
      source:"user",
      mutationPolicy:"locked"
    });

    ok(commands.includes(RETRIEVAL_COMMANDS.upsert),"MemoryCreated reaches production retrieval index writer through IPC");
    ok(documents.has(character.id+":"+memory.id),"active Dynamic Memory is present in retrieval index");

    const query="Нова, какого цвета твои волосы?";
    const assembled=await runtime.buildContext({
      apiVersion:"1",
      schemaVersion:"1",
      characterId:character.id,
      conversationId:conversation.id,
      messages:[{role:"user",content:query}],
      budget:{
        availableContextTokens:defaultAppSettings().context.availableContextTokens,
        reservedOutputTokens:defaultAppSettings().context.reservedOutputTokens,
        systemOverheadTokens:0,
        safetyMarginTokens:defaultAppSettings().context.safetyMarginTokens
      }
    });

    equal(commands.includes(RETRIEVAL_COMMANDS.search),true,"MemoryCandidateSource calls IpcFullTextRetriever.search through the IPC boundary");
    const realQuery=retrievalQueries.at(-1);
    equal(realQuery?.characterId,character.id,"production RetrievalQuery preserves character scope");
    equal(realQuery?.conversationId,conversation.id,"production RetrievalQuery preserves conversation scope");
    equal(realQuery?.query,query,"production RetrievalQuery uses the latest user message");
    equal(realQuery?.sources,["memory"],"production RetrievalQuery requests Memory source only");
    equal(realQuery?.filters?.status,"active","production RetrievalQuery requests active Dynamic Memory");
    const result=retrievalResults.at(-1);
    ok(Boolean(result),"production retrieval returns a RetrievalResult");
    ok(result?.candidates.some(candidate=>candidate.source==="memory"&&candidate.sourceId===memory.id),"RetrievalResult contains source=memory");
    const selected=assembled.includedCandidates.find(candidate=>candidate.referenceId===memory.id);
    ok(Boolean(selected),"MemoryCandidateSource creates a selected ContextCandidate");
    equal(selected?.eligible,true,"Dynamic Memory candidate is eligible");
    equal(selected?.content,memory.content,"selected candidate preserves Dynamic Memory content");
    ok(assembled.includedCandidates.some(candidate=>candidate.referenceId===memory.id),"includedCandidates contains the production Dynamic Memory");
    ok(assembled.messages.some(message=>message.content===memory.content),"selected Context Engine messages contain Dynamic Memory");

    let capturedRequest:ChatRequest|undefined;
    const controller=new ChatSessionController(
      new ConversationSession(conversation.id,character.id),
      {
        chat:async(request:ChatRequest)=>{
          capturedRequest=request;
          return runtime.chat(request);
        }
      },
      {
        requestIdFactory:()=> "production-memory-chat-1",
        contextBuilder:{buildContext:request=>runtime.buildContext(request)},
        contextBudget:{
          availableContextTokens:defaultAppSettings().context.availableContextTokens,
          reservedOutputTokens:defaultAppSettings().context.reservedOutputTokens,
          systemOverheadTokens:0,
          safetyMarginTokens:defaultAppSettings().context.safetyMarginTokens
        },
        traceStore:runtime.getChatTraceStore()
      }
    );

    const sent=await controller.submit(query,"fake-chat");
    equal(sent.status,"sent","ChatSessionController completes with production Context Engine");
    ok(Boolean(capturedRequest),"ChatSessionController produces a final ChatRequest");
    ok(capturedRequest?.context.messages.some(message=>message.content===memory.content),"final ChatRequest.context.messages contains Dynamic Memory");
    equal(capturedRequest?.context.messages.find(message=>message.content===memory.content)?.metadata?.contextSource,"memory","final ChatRequest keeps memory provenance");
    equal(capturedRequest?.context.messages.find(message=>message.content===memory.content)?.metadata?.contextReferenceId,memory.id,"final ChatRequest keeps memory reference");

    const trace=runtime.listChatTraces()[0];
    ok(Boolean(trace?.contextBuild?.includedCandidates.some(candidate=>candidate.referenceId===memory.id)),"chat trace records selected Dynamic Memory");
    ok(Boolean(trace?.finalRequest?.context.messages.some(message=>message.content===memory.content)),"chat trace records final ChatRequest with Dynamic Memory");
  }finally{
    await runtime.stop();
  }

  const failingInvoke:RetrievalStoreInvoke=async(command)=>{
    if(command===RETRIEVAL_COMMANDS.rebuildAll)return undefined;
    if(command===RETRIEVAL_COMMANDS.upsert)return undefined;
    if(command===RETRIEVAL_COMMANDS.search)throw new Error("retrieval backend failure for diagnostics");
    return undefined;
  };
  const failingRuntime=await startFoundationRuntime({
    characterStore:new InMemoryCharacterStore(),
    memoryStore:new InMemoryMemoryStore(),
    retriever:new IpcFullTextRetriever(failingInvoke)
  });
  await failingRuntime.start();
  try{
    const character=await failingRuntime.getActiveCharacter();
    const conversation=await failingRuntime.getActiveConversation(character.id);
    const failingMemory:MemoryItem=await failingRuntime.createMemory(character.id,{
      id:"memory.production.failure",
      conversationId:conversation.id,
      type:"observation",
      content:"Нова имеет фиолетовые волосы",
      source:"user",
      mutationPolicy:"locked"
    });
    ok(Boolean(failingMemory),"failing production composition still creates memory");
    let surfaced=false;
    try{
      await failingRuntime.buildContext({
        apiVersion:"1",
        schemaVersion:"1",
        characterId:character.id,
        conversationId:conversation.id,
        messages:[{role:"user",content:"Нова, какого цвета твои волосы?"}],
        budget:{availableContextTokens:1024,reservedOutputTokens:128,systemOverheadTokens:0,safetyMarginTokens:0}
      });
    }catch{surfaced=true}
    ok(surfaced,"retrieval failure is not converted into an empty memory result");
    const diagnostic=failingRuntime.diagnostics().then(snapshot=>snapshot.recentErrors.find(error=>error.code==="RETRIEVAL_FAILED"));
    ok(Boolean((await diagnostic)),"retrieval failure is visible through existing diagnostics");
  }finally{
    await failingRuntime.stop();
  }

  console.log("PASS production Dynamic Memory retrieval -> Context Engine -> ChatRequest integration");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
