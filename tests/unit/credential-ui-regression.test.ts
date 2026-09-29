import {readFileSync} from "node:fs";
import {join} from "node:path";

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

console.log("PASS credential UI persistence regression test");
