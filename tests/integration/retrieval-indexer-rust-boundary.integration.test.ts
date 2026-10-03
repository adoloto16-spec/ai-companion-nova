import {mkdir,writeFile} from "node:fs/promises";
import {dirname,resolve} from "node:path";
import {defaultAppSettings,type RetrievalIndexDocument, type RetrievalQuery} from "../../contracts/src";
import {IpcFullTextRetriever,RETRIEVAL_COMMANDS,type RetrievalStoreInvoke} from "../../host/retrieval/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {InMemoryMemoryStore} from "../../host/memory/src";
import {startFoundationRuntime} from "../../runtime/bootstrap/src";

function equal(actual:unknown,expected:unknown,label:string){
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual));
}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const fixturePath=process.env.NOVA_RETRIEVAL_FIXTURE
    ?resolve(process.env.NOVA_RETRIEVAL_FIXTURE)
    :resolve(".tmp/retrieval-indexer-rust-boundary.json");
  await mkdir(dirname(fixturePath),{recursive:true});

  const calls:string[]=[];
  const upserted:RetrievalIndexDocument[]=[];
  let fixtureQuery:RetrievalQuery|undefined;

  const invoke:RetrievalStoreInvoke=async(command,args)=>{
    calls.push(command);
    if(command===RETRIEVAL_COMMANDS.rebuildAll||command===RETRIEVAL_COMMANDS.rebuild||command===RETRIEVAL_COMMANDS.removeCharacter){
      return undefined;
    }
    if(command===RETRIEVAL_COMMANDS.remove){
      return undefined;
    }
    if(command===RETRIEVAL_COMMANDS.upsert){
      const document=args?.document as RetrievalIndexDocument|undefined;
      if(!document)throw new Error("retrieval IPC upsert missing document");
      upserted.push(JSON.parse(JSON.stringify(document)) as RetrievalIndexDocument);
      fixtureQuery={
        apiVersion:"1",
        schemaVersion:"1",
        characterId:document.characterId,
        conversationId:document.conversationId,
        query:"Нова, какого цвета твои волосы?",
        sources:["memory"],
        limit:10,
        filters:{status:"active"}
      };
      await writeFile(
        fixturePath,
        JSON.stringify({document,query:fixtureQuery},null,2),
        "utf8"
      );
      return undefined;
    }
    throw new Error("Unexpected retrieval IPC command: "+command);
  };

  const retriever=new IpcFullTextRetriever(invoke);
  const runtime=await startFoundationRuntime({
    characterStore:new InMemoryCharacterStore(),
    memoryStore:new InMemoryMemoryStore(),
    retriever,
    retrievalIndexWriter:retriever
  });
  await runtime.start();

  try{
    const character=await runtime.getActiveCharacter();
    const conversation=await runtime.getActiveConversation(character.id);
    const memory=await runtime.createMemory(character.id,{
      id:"memory.rust-boundary.nova-hair",
      conversationId:conversation.id,
      type:"observation",
      content:"Нова имеет фиолетовые волосы",
      source:"user",
      mutationPolicy:"locked"
    });

    equal(memory.tags,[],"MemoryBroker default tags remain empty");
    equal(memory.status,"active","MemoryBroker creates active Dynamic Memory");
    ok(calls.includes(RETRIEVAL_COMMANDS.upsert),"MemoryCreated reaches RetrievalEventIndexer and IpcFullTextRetriever.upsert");
    equal(upserted.length,1,"exactly one active-memory upsert is emitted");
    const document=upserted[0];
    ok(Boolean(document),"indexer emits a retrieval document");
    equal(document?.source,"memory","index document source is memory");
    equal(document?.characterId,character.id,"index document preserves characterId");
    equal(document?.conversationId,conversation.id,"index document preserves conversationId");
    equal(document?.content,memory.content,"index document preserves Memory content");
    equal(document?.tags,[],"index document does not require tags for retrieval");
    equal(document?.status,"active","index document marks active memory");
    equal(fixtureQuery?.query,"Нова, какого цвета твои волосы?","fixture carries the exact retrieval query");

    await runtime.buildContext({
      apiVersion:"1",
      schemaVersion:"1",
      characterId:character.id,
      conversationId:conversation.id,
      messages:[{role:"user",content:"Нова, какого цвета твои волосы?"}],
      budget:{
        availableContextTokens:defaultAppSettings().context.availableContextTokens,
        reservedOutputTokens:defaultAppSettings().context.reservedOutputTokens,
        systemOverheadTokens:0,
        safetyMarginTokens:defaultAppSettings().context.safetyMarginTokens
      }
    });

    ok(await import("node:fs/promises").then(fs=>fs.readFile(fixturePath,"utf8")),"Rust boundary fixture is written after the real indexer event path");
  }finally{
    await runtime.stop();
  }

  console.log("PASS MemoryBroker.create -> MemoryCreated -> RetrievalEventIndexer -> IpcFullTextRetriever.upsert fixture");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
