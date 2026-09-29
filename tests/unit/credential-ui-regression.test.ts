import {readFileSync} from "node:fs";
import {join} from "node:path";
import {IpcCredentialStore,CREDENTIAL_COMMANDS} from "../../host/credentials/src/index";
import type {CredentialReference} from "../../contracts/src/index";

function ok(condition:boolean,message:string){
  if(!condition)throw new Error(message);
}
function equal(actual:unknown,expected:unknown,message:string){
  if(actual!==expected)throw new Error(message+" expected "+String(expected)+" got "+String(actual));
}

const source=readFileSync(join(process.cwd(),"apps/desktop-ui/src/main.tsx"),"utf8");
const helperMatch=source.match(/function slugId\(value:string\):string\{([\s\S]*?)\n\}/);
ok(Boolean(helperMatch),"main.tsx must define the local slugId helper.");
const helperSource=(helperMatch?.[0]??"").replace(
  "function slugId(value:string):string{",
  "function slugId(value){"
);
const slugId=Function(`return (${helperSource});`)() as (value:string)=>string;

equal(slugId("  Mistral Main  "),"mistral-main","slugId normalizes and lowercases labels");
equal(slugId("Groq / Backup"),"groq-backup","slugId replaces non-alphanumeric runs");
equal(slugId(" !!! "),"credential","slugId uses deterministic fallback for empty labels");
ok(slugId("A".repeat(200)).length<=64,"slugId must cap credential reference segment length");

const setSecretIndex=source.indexOf("await credentialStore.setSecret(reference,secret);");
const existsIndex=source.indexOf("const saved=await credentialStore.exists(reference);");
const guardIndex=source.indexOf('throw new Error("Credential could not be verified after saving.");');
const metadataIndex=source.indexOf("const profile:CredentialProfile=");
ok(setSecretIndex>=0,"createCredentialProfile must call credentialStore.setSecret.");
ok(existsIndex>setSecretIndex,"credential existence verification must happen after setSecret.");
ok(guardIndex>existsIndex,"credential verification failure must throw before metadata creation.");
ok(metadataIndex>guardIndex,"CredentialProfile metadata must be created only after verification.");

const reference:CredentialReference={id:"credential.test.1",kind:"api-key",provider:"openai-compatible",version:"1"};
let secretSaved=false;
const commands:string[]=[];
const invoke=async(command:string,args?:Record<string,unknown>)=>{
  commands.push(command);
  if(command===CREDENTIAL_COMMANDS.save){secretSaved=args?.secret==="test-secret";return null;}
  if(command===CREDENTIAL_COMMANDS.exists)return secretSaved;
  return null;
};
const ipcCredentialStore=new IpcCredentialStore(invoke);
await ipcCredentialStore.setSecret(reference,"test-secret");
ok(commands.includes(CREDENTIAL_COMMANDS.save),"IpcCredentialStore must invoke save_credential.");
equal(await ipcCredentialStore.exists(reference),true,"IpcCredentialStore.exists must confirm a saved credential");
ok(commands.includes(CREDENTIAL_COMMANDS.exists),"IpcCredentialStore must invoke credential_exists.");

console.log("PASS credential UI persistence regression test");
