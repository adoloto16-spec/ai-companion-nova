export type ApiVersion = "1";
export const FOUNDATION_API_VERSION:ApiVersion="1";
export const FOUNDATION_SCHEMA_VERSION="1";
export const CHAT_API_VERSION:ApiVersion="1";
export const CHAT_SCHEMA_VERSION="1";

export type ModuleType="service"|"adapter"|"worker"|"ui";
export type ModuleRuntime="typescript"|"rust";
export type ModuleState="installed"|"loading"|"ready"|"running"|"degraded"|"error"|"disabled";
export type ActionRisk="low"|"medium"|"high"|"critical";
export type ProviderKind="chat"|"stt"|"tts"|"embeddings"|"reranking"|"vision";

export interface HealthStatus{status:"healthy"|"degraded"|"unavailable"|"error";message?:string;capabilities?:readonly string[];lastSuccessfulOperation?:string;diagnostics?:Record<string,unknown>}
export interface ModuleManifest{id:string;name:string;version:string;apiVersion:ApiVersion;schemaVersion:string;type:ModuleType;runtime:ModuleRuntime;optional:boolean;capabilities:readonly string[]}
export interface Logger{debug(message:string,metadata?:Record<string,unknown>):void;info(message:string,metadata?:Record<string,unknown>):void;warn(message:string,metadata?:Record<string,unknown>):void;error(message:string,metadata?:Record<string,unknown>):void}
export interface Clock{now():string}
export interface ConfigStore{get<T>(key:string):T|undefined;set<T>(key:string,value:T):Promise<void>}
export interface CredentialReference{id:string;kind:string;provider?:string;version?:string}
export interface CredentialStore{getSecret(reference:CredentialReference):Promise<string|undefined>;setSecret(reference:CredentialReference,value:string):Promise<void>;deleteSecret(reference:CredentialReference):Promise<void>}
export const PROVIDER_CONFIGURATION_API_VERSION:ApiVersion="1";
export const PROVIDER_CONFIGURATION_SCHEMA_VERSION="1";
export type ProviderConnectionTestStatus="connected"|"authentication_failed"|"configuration_error"|"network_error"|"timeout"|"provider_error";
export interface ProviderConfiguration{apiVersion:ApiVersion;schemaVersion:string;providerId:string;enabled:boolean;baseUrl:string;model:string;credentialReference:CredentialReference|null;timeoutMs?:number}
export interface ProviderConnectionTestResult{apiVersion:ApiVersion;schemaVersion:string;status:ProviderConnectionTestStatus;providerId:string;message?:string}
export type CharacterId=string;
export const CHARACTER_API_VERSION:ApiVersion="1";
export const CHARACTER_SCHEMA_VERSION="1";
export interface Character{id:CharacterId;name:string;description:string;createdAt:string;updatedAt:string;enabled:boolean}
export interface CharacterStoreState{apiVersion:ApiVersion;schemaVersion:string;characters:readonly Character[];activeCharacterId:CharacterId}
export interface CharacterStore{load():Promise<CharacterStoreState|undefined>;save(state:CharacterStoreState):Promise<void>}
export type CoreBookEntryId=string;
export const CORE_BOOK_API_VERSION:ApiVersion="1";
export const CORE_BOOK_SCHEMA_VERSION="1";
export type CoreBookMutationPolicy="locked"|"suggest"|"auto";
export type CoreBookEntrySource="user"|"import"|"system"|"other";
export type CoreBookActivation=
  | {kind:"always"}
  | {kind:"keyword";keywords:readonly string[];matchMode:"any"|"all";caseSensitive:boolean}
  | {kind:"regex";pattern:string;flags:string}
  | {kind:"semantic"}
  | {kind:"model_search"};
export interface CoreBookEntry{
  id:CoreBookEntryId;
  characterId:CharacterId;
  title:string;
  content:string;
  tags:readonly string[];
  activation:CoreBookActivation;
  retentionPriority:number;
  placementWeight:number;
  mutationPolicy:CoreBookMutationPolicy;
  enabled:boolean;
  source:CoreBookEntrySource;
  metadata:Record<string,unknown>;
  createdAt:string;
  updatedAt:string;
}
export interface CoreBookStoreState{
  apiVersion:ApiVersion;
  schemaVersion:string;
  characterId:CharacterId;
  entries:readonly CoreBookEntry[];
}
export interface CoreBookStore{
  load(characterId:CharacterId):Promise<CoreBookStoreState|undefined>;
  save(state:CoreBookStoreState):Promise<void>;
}
export type MemoryItemId=string;
export const MEMORY_API_VERSION:ApiVersion="1";
export const MEMORY_SCHEMA_VERSION="1";
export type MemoryType="fact"|"preference"|"relationship"|"event"|"experience"|"goal"|"instruction"|"observation";
export type MemoryStatus="active"|"superseded"|"archived";
export type MemorySource="user"|"conversation"|"file"|"tool"|"model"|"system";
export type MemoryMutationPolicy="locked"|"suggest"|"auto";
export interface MemoryItem{
  id:MemoryItemId;
  characterId:CharacterId;
  type:MemoryType;
  content:string;
  tags:readonly string[];
  importance:number;
  confidence:number;
  createdAt:string;
  updatedAt:string;
  validFrom:string|null;
  validUntil:string|null;
  source:MemorySource;
  sourceReference:string|null;
  mutationPolicy:MemoryMutationPolicy;
  status:MemoryStatus;
  metadata:Record<string,unknown>;
}
export interface MemoryCreateInput{
  id?:MemoryItemId;
  type:MemoryType;
  content:string;
  tags?:readonly string[];
  importance?:number;
  confidence?:number;
  validFrom?:string|null;
  validUntil?:string|null;
  source:MemorySource;
  sourceReference?:string|null;
  mutationPolicy?:MemoryMutationPolicy;
  metadata?:Record<string,unknown>;
}
export interface MemorySearchQuery{
  characterId:CharacterId;
  query:string;
  types?:readonly MemoryType[];
  tags?:readonly string[];
  status?:MemoryStatus;
  limit?:number;
}
export interface MemoryMutationAuthority{
  actorId:string;
  actorType:"user"|"system"|"model";
  trusted:boolean;
  capabilities:readonly string[];
  moduleId?:string;
}
export interface MemoryStoreState{
  apiVersion:ApiVersion;
  schemaVersion:string;
  characterId:CharacterId;
  items:readonly MemoryItem[];
}
export interface MemoryStore{
  load(characterId:CharacterId):Promise<MemoryStoreState|undefined>;
  save(state:MemoryStoreState):Promise<void>;
  supersede(characterId:CharacterId,previousMemoryId:MemoryItemId,replacement:MemoryItem):Promise<MemoryItem>;
}
export interface MemoryBroker{
  get(characterId:CharacterId,memoryId:MemoryItemId):Promise<MemoryItem|undefined>;
  search(query:MemorySearchQuery):Promise<readonly MemoryItem[]>;
  create(characterId:CharacterId,input:MemoryCreateInput,authority:MemoryMutationAuthority):Promise<MemoryItem>;
  update(characterId:CharacterId,memoryId:MemoryItemId,input:Record<string,unknown>,authority:MemoryMutationAuthority):Promise<MemoryItem>;
  supersede(characterId:CharacterId,memoryId:MemoryItemId,input:MemoryCreateInput,authority:MemoryMutationAuthority):Promise<MemoryItem>;
  archive(characterId:CharacterId,memoryId:MemoryItemId,authority:MemoryMutationAuthority):Promise<MemoryItem>;
}
export const CONTEXT_API_VERSION:ApiVersion="1";
export const CONTEXT_SCHEMA_VERSION="1";

export type ContextSource="conversation"|"core_book";
export type ContextZone="system"|"character_core"|"retrieved_core_book"|"conversation"|"recent_conversation";

export interface ContextBudget{
  availableContextTokens:number;
  reservedOutputTokens:number;
  systemOverheadTokens:number;
  safetyMarginTokens:number;
}
export interface ContextBuildRequest{
  apiVersion:ApiVersion;
  schemaVersion:string;
  characterId:CharacterId;
  conversationId:string;
  messages:readonly ChatMessage[];
  budget:ContextBudget;
}
export interface ContextCandidate{
  id:string;
  source:ContextSource;
  referenceId:string;
  characterId:CharacterId;
  content:string;
  role:ChatMessage["role"];
  toolCallId?:string;
  metadata?:Record<string,unknown>;
  eligible:boolean;
  reason:string;
  estimatedTokens:number;
  zone:ContextZone;
  relevance:number;
  activationStrength:number;
  retentionPriority:number;
  placementWeight:number;
  recency:number;
  selectionScore:number;
}
export interface AssembledContext{
  apiVersion:ApiVersion;
  schemaVersion:string;
  characterId:CharacterId;
  conversationId:string;
  messages:readonly ChatMessage[];
  includedCandidates:readonly ContextCandidate[];
  omittedCandidates:readonly ContextCandidate[];
  budget:ContextBudget;
  estimatedTokens:number;
}
export interface ContextEngine{
  build(request:ContextBuildRequest):Promise<AssembledContext>;
}

export interface CapabilityContext{has(capability:string):boolean;require(capability:string):void}
export interface ModuleContext{moduleId:string;events:EventBus;logger:Logger;config:ConfigStore;clock:Clock;capabilities:CapabilityContext}
export interface CompanionModule{manifest:ModuleManifest;initialize(context:ModuleContext):Promise<void>;start():Promise<void>;stop():Promise<void>;health():Promise<HealthStatus>}

export interface Event<T=unknown>{id:string;type:string;timestamp:string;source:string;schemaVersion:string;payload:T}
export type EventHandler<T>=(event:Event<T>)=>void|Promise<void>;
export type Unsubscribe=()=>void;
export interface EventBus{publish<T>(event:Event<T>):Promise<void>;subscribe<T>(eventType:string,handler:EventHandler<T>):Unsubscribe}
export interface EventPayloadMap{
  UserArrived:{userId:string};UserLeft:{userId:string};SpeechStarted:{text:string};SpeechFinished:{text:string};
  MessageReceived:{channel:string;text:string};EmotionChanged:{primary:string;secondary?:string|null;intensity:number;reason?:string};
  GoalCreated:{goalId:string};GoalCompleted:{goalId:string};GoalFailed:{goalId:string;reason:string};
  AppChanged:{applicationId:string};WindowChanged:{title:string};TTSStarted:{requestId:string};TTSFinished:{requestId:string};
  CharacterMotionStarted:{motionId:string};CharacterMotionFinished:{motionId:string};
  ChatRequestStarted:{requestId:string;conversationId:string;providerId:string;model:string};
  CharacterCreated:{characterId:string};
  CharacterUpdated:{characterId:string};
  CharacterDeleted:{characterId:string};
  ActiveCharacterChanged:{characterId:string;previousCharacterId?:string};
  CoreBookEntryCreated:{characterId:string;entryId:string};
  CoreBookEntryUpdated:{characterId:string;entryId:string};
  CoreBookEntryDeleted:{characterId:string;entryId:string};
  CoreBookEntryEnabledChanged:{characterId:string;entryId:string;enabled:boolean};
  MemoryCreated:{characterId:string;memoryId:string;status:MemoryStatus;updatedAt:string};
  MemoryUpdated:{characterId:string;memoryId:string;status:MemoryStatus;updatedAt:string};
  MemorySuperseded:{characterId:string;memoryId:string;previousMemoryId:string;status:MemoryStatus;updatedAt:string};
  MemoryArchived:{characterId:string;memoryId:string;status:MemoryStatus;updatedAt:string};
  ChatResponseReceived:{requestId:string;conversationId:string;providerId:string;model:string;finishReason:ChatFinishReason};
  ChatRequestFailed:{requestId:string;conversationId?:string;providerId?:string;code:ChatError["code"]};
}
export interface ErrorDiagnostic{timestamp:string;source:string;code:string;message:string;metadata?:Record<string,unknown>}
export interface DiagnosticsStore{recordError(source:string,code:string,message:string,metadata?:Record<string,unknown>):void;recentErrors(limit?:number):readonly ErrorDiagnostic[]}
export function createEvent<K extends keyof EventPayloadMap>(type:K,payload:EventPayloadMap[K],source:string,clock:()=>string,id=source+":"+type+":"+Date.now()):Event<EventPayloadMap[K]>{return{id,type,timestamp:clock(),source,schemaVersion:FOUNDATION_SCHEMA_VERSION,payload}}

export interface ProviderCapabilities{streaming?:boolean;vision?:boolean;toolCalling?:boolean;structuredOutput?:boolean;reasoning?:boolean;audioInput?:boolean;audioOutput?:boolean;embeddings?:boolean;[key:string]:boolean|undefined}
export interface ModelInfo{id:string;displayName?:string;capabilities?:ProviderCapabilities}
export interface JsonSchema{$schema?:string;type?:string|string[];properties?:Record<string,JsonSchema>;required?:readonly string[];additionalProperties?:boolean|JsonSchema;items?:JsonSchema;enum?:readonly unknown[];oneOf?:readonly JsonSchema[];const?:unknown;minimum?:number;maximum?:number;minLength?:number;maxLength?:number;minItems?:number;maxItems?:number}
export interface ToolDefinition{id:string;version:string;schemaVersion:string;name:string;description:string;risk:ActionRisk;requiredCapabilities:readonly string[];resourceType:"domain"|"filesystem"|"application"|"resource";action:string;targetResolverId:string;confirmation:"never"|"policy";parameters:JsonSchema}
export interface ChatMessage{id?:string;role:"system"|"user"|"assistant"|"tool";content:string;toolCallId?:string;metadata?:Record<string,unknown>}
export interface ChatContext{conversationId:string;messages:readonly ChatMessage[];metadata?:Record<string,unknown>}
export type ResponseFormat={type:"text"}|{type:"json";schema:Record<string,unknown>}
export interface ChatGenerationOptions{temperature?:number;maxTokens?:number;topP?:number;responseFormat?:ResponseFormat}
export interface ChatUsage{promptTokens?:number;completionTokens?:number;totalTokens?:number}
export type ChatFinishReason="stop"|"length"|"content_filter"|"error"|"unknown"
export type ChatErrorCode="INVALID_REQUEST"|"PROVIDER_NOT_FOUND"|"PROVIDER_UNAVAILABLE"|"PROVIDER_ERROR"|"INVALID_RESPONSE"|"UNSUPPORTED"
export interface ChatError{apiVersion:ApiVersion;schemaVersion:string;code:ChatErrorCode;message:string;requestId?:string;providerId?:string;retryable?:boolean;details?:Record<string,unknown>}
export interface ChatRequest{apiVersion:ApiVersion;schemaVersion:string;requestId:string;providerId?:string;model:string;context:ChatContext;generation?:ChatGenerationOptions;metadata?:Record<string,unknown>}
export interface ChatResponse{apiVersion:ApiVersion;schemaVersion:string;requestId:string;conversationId:string;providerId:string;model:string;message:ChatMessage;finishReason:ChatFinishReason;usage?:ChatUsage;metadata?:Record<string,unknown>}
export interface ChatProviderMetadata{id:string;kind:"chat";displayName:string;version:string;description?:string}
export interface ChatProvider{id:string;metadata():ChatProviderMetadata;capabilities():ProviderCapabilities;listModels():Promise<ModelInfo[]>;chat(request:ChatRequest):Promise<ChatResponse>;health():Promise<HealthStatus>}
export type Message=ChatMessage;
export type Usage=ChatUsage;
export interface STTRequest{audio:Uint8Array;language?:string}
export interface Transcript{text:string;language?:string;confidence?:number}
export interface STTProvider{id:string;capabilities():ProviderCapabilities;transcribe(request:STTRequest):Promise<Transcript>;health():Promise<HealthStatus>}
export interface TTSRequest{text:string;voice?:string;speed?:number}
export interface AudioChunk{data:Uint8Array;sequence:number;final:boolean}
export interface TTSProvider{id:string;capabilities():ProviderCapabilities;listVoices():Promise<string[]>;synthesize(request:TTSRequest):AsyncIterable<AudioChunk>;health():Promise<HealthStatus>}
export interface EmbeddingProvider{id:string;capabilities():ProviderCapabilities;dimensions():number;embed(texts:string[]):Promise<number[][]>;health():Promise<HealthStatus>}
export interface RankedDocument{id:string;text:string;score:number;metadata?:Record<string,unknown>}
export interface RerankerProvider{id:string;capabilities():ProviderCapabilities;rerank(query:string,documents:RankedDocument[]):Promise<RankedDocument[]>;health():Promise<HealthStatus>}
export interface VisionRequest{image:Uint8Array;prompt?:string}
export interface VisionResult{text:string;metadata?:Record<string,unknown>}
export interface VisionProvider{id:string;capabilities():ProviderCapabilities;analyze(request:VisionRequest):Promise<VisionResult>;health():Promise<HealthStatus>}

export interface ActorCredential{token:string}
export interface ActorIdentity{actorId:string;actorType:string;moduleId?:string;trusted:boolean;capabilities:readonly string[]}
export interface ActorIdentityResolver{resolve(credential:ActorCredential):Promise<ActorIdentity|undefined>}
export interface ActionRequest{id:string;schemaVersion:string;tool:string;arguments:Record<string,unknown>;metadata?:Record<string,unknown>}
export interface ActionInvocation{request:ActionRequest;credential:ActorCredential}
export type ActionTarget=
  | {kind:"domain";url:string;domain:string}
  | {kind:"filesystem";path:string;canonicalPath?:string;canonicalized:boolean}
  | {kind:"application";applicationId:string;windowId?:string}
  | {kind:"resource";resource:string}
export interface ActionTargetResolver{readonly id:string;resolve(request:ActionRequest,tool:ToolDefinition):Promise<ActionTarget>}
export interface PermissionDecision{allowed:boolean;reason:string;scopeMatched?:boolean}
export interface PermissionService{check(actor:ActorIdentity,tool:ToolDefinition,target:ActionTarget):Promise<PermissionDecision>}
export interface ForegroundCheck{verify(actor:ActorIdentity,tool:ToolDefinition,target:ActionTarget):Promise<PermissionDecision>}
export interface ConfirmationService{confirm(invocation:ActionInvocation,actor:ActorIdentity,tool:ToolDefinition,target:ActionTarget):Promise<boolean>}
export interface RiskPolicy{canonicalRisk(tool:ToolDefinition):ActionRisk;requiresConfirmation(tool:ToolDefinition,target:ActionTarget):boolean}
export interface ActionDriver{id:string;execute(request:ActionRequest,target:ActionTarget):Promise<unknown>}
export interface PostconditionChecker{verify(request:ActionRequest,target:ActionTarget,output:unknown):Promise<boolean>}
export interface AuditEntry{timestamp:string;actorId:string;actorType:string;module?:string;action:string;resourceType:string;targetSummary?:string;argumentKeys:string[];status:"success"|"denied"|"error";durationMs:number;allowed:boolean;reason?:string}
export interface AuditService{record(entry:AuditEntry):Promise<void>}
export interface ActionBroker{execute(invocation:ActionInvocation):Promise<ActionResult>}
export interface Permission{id:string;schemaVersion:string;subject:string;resourceType:"domain"|"filesystem"|"application"|"resource";action:string;effect:"allow"|"deny";scope?:{domains?:readonly string[];roots?:readonly string[];applications?:readonly string[];windows?:readonly string[]}}
export interface ActionError{code:"INVALID_REQUEST"|"SCHEMA_VALIDATION_FAILED"|"TOOL_NOT_FOUND"|"CAPABILITY_DENIED"|"PERMISSION_DENIED"|"FOREGROUND_DENIED"|"SCOPE_DENIED"|"RISK_DENIED"|"CONFIRMATION_REQUIRED"|"TARGET_RESOLUTION_FAILED"|"DRIVER_ERROR"|"POSTCONDITION_FAILED";message:string;details?:Record<string,unknown>}
export type ActionResult={id:string;schemaVersion:string;status:"success";output:unknown;durationMs:number}|{id:string;schemaVersion:string;status:"denied"|"error";error:ActionError;durationMs:number}

export interface StateStore{get<T>(key:string):T|undefined;set<T>(key:string,value:T):Promise<void>;delete(key:string):Promise<void>;subscribe<T>(key:string,handler:(value:T)=>void):Unsubscribe}
export interface JsonRpcRequest{jsonrpc:"2.0";id:string|number;method:string;params?:Record<string,unknown>}
export interface JsonRpcResponse{jsonrpc:"2.0";id:string|number;result?:unknown;error?:{code:number;message:string;data?:unknown}}
export interface JsonRpcNotification{jsonrpc:"2.0";method:string;params?:Record<string,unknown>}
export type JsonRpcMessage=JsonRpcRequest|JsonRpcResponse|JsonRpcNotification
export interface JsonRpcTransport{send(message:JsonRpcMessage):Promise<void>;close():Promise<void>;onMessage(handler:(message:JsonRpcMessage)=>void|Promise<void>):Unsubscribe;onDisconnect(handler:(reason:string)=>void):Unsubscribe}

export interface ModuleDiagnostic{id:string;state:ModuleState;health?:HealthStatus;error?:string}
export interface ProviderDiagnostic{id:string;roles:readonly ProviderKind[];capabilities:ProviderCapabilities;health?:HealthStatus}
export interface RuntimeDiagnostics{schemaVersion:string;timestamp:string;runtimeStatus:"starting"|"running"|"degraded"|"error"|"stopped";coreStatus:"starting"|"running"|"degraded"|"error"|"stopped";modules:readonly ModuleDiagnostic[];providers:readonly ProviderDiagnostic[];recentErrors:readonly ErrorDiagnostic[];capabilities:readonly string[]}
export interface DiagnosticsService{snapshot():Promise<RuntimeDiagnostics>}
export interface CharacterService{loadCharacter(characterId:string):Promise<void>;setExpression(expression:{primary:string;secondary?:string|null;intensity:number}):Promise<void>;playGesture(gesture:{gestureId:string;durationMs?:number}):Promise<void>;setGaze(gaze:{target:"user"|"camera"|"custom";x?:number;y?:number}):Promise<void>;speak(state:{active:boolean;intensity?:number}):Promise<void>}
export interface MemoryService{search(query:{query:string;limit?:number}):Promise<Array<{id:string;text:string;score:number}>>;remember(memory:{text:string;category?:string;importance?:number}):Promise<string>;update(memory:{id:string;text?:string;category?:string;importance?:number}):Promise<void>;forget(memoryId:string):Promise<void>;consolidate(date:string):Promise<{processed:number;changed:number}>}
export interface BrowserService{open(url:string):Promise<void>;search(query:string):Promise<void>;readPage():Promise<{title:string;text:string}>;click(selector:string):Promise<{status:"success"|"denied"|"error";output?:unknown}>}
export interface SchemaValidator{validate(value:unknown,schema:JsonSchema):{valid:boolean;errors:readonly string[]}}
export const CONTRACT_VERSIONS={
  moduleManifest:{apiVersion:FOUNDATION_API_VERSION,schemaVersion:FOUNDATION_SCHEMA_VERSION},
  eventEnvelope:{apiVersion:FOUNDATION_API_VERSION,schemaVersion:FOUNDATION_SCHEMA_VERSION},
  actionRequest:{apiVersion:FOUNDATION_API_VERSION,schemaVersion:FOUNDATION_SCHEMA_VERSION},
  actionResult:{apiVersion:FOUNDATION_API_VERSION,schemaVersion:FOUNDATION_SCHEMA_VERSION},
  permission:{apiVersion:FOUNDATION_API_VERSION,schemaVersion:FOUNDATION_SCHEMA_VERSION},
  diagnostics:{apiVersion:FOUNDATION_API_VERSION,schemaVersion:FOUNDATION_SCHEMA_VERSION},
  chatMessage:{apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION},
  chatContext:{apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION},
  chatGenerationOptions:{apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION},
  chatRequest:{apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION},
  chatResponse:{apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION},
  chatError:{apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION},
  providerConfiguration:{apiVersion:PROVIDER_CONFIGURATION_API_VERSION,schemaVersion:PROVIDER_CONFIGURATION_SCHEMA_VERSION},
  providerConnectionTestResult:{apiVersion:PROVIDER_CONFIGURATION_API_VERSION,schemaVersion:PROVIDER_CONFIGURATION_SCHEMA_VERSION},
  character:{apiVersion:CHARACTER_API_VERSION,schemaVersion:CHARACTER_SCHEMA_VERSION},
  coreBookEntry:{apiVersion:CORE_BOOK_API_VERSION,schemaVersion:CORE_BOOK_SCHEMA_VERSION},
  memoryItem:{apiVersion:MEMORY_API_VERSION,schemaVersion:MEMORY_SCHEMA_VERSION},
  memorySearchQuery:{apiVersion:MEMORY_API_VERSION,schemaVersion:MEMORY_SCHEMA_VERSION},
  memoryStoreState:{apiVersion:MEMORY_API_VERSION,schemaVersion:MEMORY_SCHEMA_VERSION},
  contextSource:{apiVersion:CONTEXT_API_VERSION,schemaVersion:CONTEXT_SCHEMA_VERSION},
  contextZone:{apiVersion:CONTEXT_API_VERSION,schemaVersion:CONTEXT_SCHEMA_VERSION},
  contextBudget:{apiVersion:CONTEXT_API_VERSION,schemaVersion:CONTEXT_SCHEMA_VERSION},
  contextBuildRequest:{apiVersion:CONTEXT_API_VERSION,schemaVersion:CONTEXT_SCHEMA_VERSION},
  contextCandidate:{apiVersion:CONTEXT_API_VERSION,schemaVersion:CONTEXT_SCHEMA_VERSION},
  assembledContext:{apiVersion:CONTEXT_API_VERSION,schemaVersion:CONTEXT_SCHEMA_VERSION}
} as const;
export {STANDARD_SCHEMAS} from "./generated-schemas";

export {MinimalJsonSchemaValidator,StandardContractValidator} from "./schema-validator";
