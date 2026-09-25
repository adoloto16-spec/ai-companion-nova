import {StandardContractValidator,STANDARD_SCHEMAS,CHAT_API_VERSION,CHAT_SCHEMA_VERSION} from "../../contracts/src";

function ok(value:unknown,label:string){if(!value)throw new Error(label);}
const validator=new StandardContractValidator();
const validRequest={
  apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:"req-1",model:"fake-chat",
  context:{conversationId:"conv-1",messages:[
    {id:"m1",role:"system",content:"You are helpful."},
    {id:"m2",role:"user",content:"Hello"}
  ]}
};
ok(validator.validateChatRequest(validRequest).valid,"valid ChatRequest");
ok(!validator.validateChatRequest({...validRequest,model:""}).valid,"invalid ChatRequest model");
ok(validator.validateChatMessage({role:"tool",content:"tool output",toolCallId:"call-1"}).valid,"tool message schema");
ok(validator.validateChatGenerationOptions({temperature:0.5,maxTokens:64,topP:1}).valid,"generation options");
ok(validator.validateChatResponse({
  apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:"req-1",conversationId:"conv-1",
  providerId:"fake.chat",model:"fake-chat",message:{role:"assistant",content:"hello"},finishReason:"stop"
}).valid,"valid ChatResponse");
ok(!validator.validateChatResponse({
  apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:"req-1",conversationId:"conv-1",
  providerId:"fake.chat",model:"fake-chat",message:{role:"assistant",content:"hello"},finishReason:"bad"
}).valid,"invalid finish reason");
ok(validator.validateChatError({apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,code:"PROVIDER_ERROR",message:"provider failed"}).valid,"valid ChatError");
ok(!validator.validateChatError({apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,code:"vendor-secret-code",message:"bad"}).valid,"vendor error code rejected");
ok(STANDARD_SCHEMAS["chat-request"],"chat request schema generated");
console.log("PASS Chat contract validation");
