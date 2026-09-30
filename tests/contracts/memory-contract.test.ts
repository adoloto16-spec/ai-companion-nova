import {StandardContractValidator,STANDARD_SCHEMAS,type MemoryCandidate,type MemoryExtractionRequest,type MemoryExtractionResult,type MemoryItem,type MemorySearchQuery} from "../../contracts/src";

function ok(value:unknown,label:string){if(!value)throw new Error(label)}
function notOk(value:unknown,label:string){if(value)throw new Error(label)}

const validator=new StandardContractValidator();
const memory:MemoryItem={
  id:"memory-contract-1",characterId:"character.nova",conversationId:"conversation.nova.a",
  type:"preference",content:"The user prefers aviation examples.",tags:["aviation"],
  importance:80,confidence:95,createdAt:"2026-09-30T00:00:00.000Z",updatedAt:"2026-09-30T00:00:00.000Z",
  validFrom:null,validUntil:null,source:"conversation",sourceReference:"conversation.nova.a",
  mutationPolicy:"auto",status:"active",metadata:{}
};
const candidate:MemoryCandidate={
  type:"preference",content:memory.content,tags:["aviation"],importance:80,confidence:95,
  source:"conversation",sourceReference:"conversation.nova.a",mutationPolicy:"auto",metadata:{memoryKey:"example-style"}
};
const extractionRequest:MemoryExtractionRequest={
  requestId:"turn-contract-1",model:"fake-memory-model",apiVersion:"1",schemaVersion:"1",
  characterId:"character.nova",conversationId:"conversation.nova.a",
  userMessage:{id:"u",role:"user",content:"I prefer aviation examples."},
  assistantMessage:{id:"a",role:"assistant",content:"Understood."},
  contextMessages:[]
};
const extractionResult:MemoryExtractionResult={
  requestId:"turn-contract-1",apiVersion:"1",schemaVersion:"1",
  characterId:"character.nova",conversationId:"conversation.nova.a",memories:[candidate]
};
const query:MemorySearchQuery={
  characterId:"character.nova",conversationId:"conversation.nova.a",query:"aviation",status:"active",limit:20
};

ok(validator.validate(memory,STANDARD_SCHEMAS["memory-item"]!).valid,"MemoryItem v2 accepts required conversation scope");
ok(validator.validate(candidate,STANDARD_SCHEMAS["memory-candidate"]!).valid,"MemoryCandidate contract validates");
ok(validator.validate(extractionRequest,STANDARD_SCHEMAS["memory-extraction-request"]!).valid,"MemoryExtractionRequest validates");
ok(validator.validate(extractionResult,STANDARD_SCHEMAS["memory-extraction-result"]!).valid,"MemoryExtractionResult validates");
ok(validator.validate(query,STANDARD_SCHEMAS["memory-search-query"]!).valid,"MemorySearchQuery requires conversation scope");

const invalidMemory={...memory,conversationId:""} as MemoryItem;
notOk(validator.validate(invalidMemory,(await import("../../contracts/src")).STANDARD_SCHEMAS["memory-item"]!).valid,"empty conversationId is rejected");
const invalidQuery={...query,conversationId:""} as MemorySearchQuery;
notOk(validator.validate(invalidQuery,(await import("../../contracts/src")).STANDARD_SCHEMAS["memory-search-query"]!).valid,"empty conversation scope is rejected");

console.log("PASS Memory v2 and extraction contract validation");
