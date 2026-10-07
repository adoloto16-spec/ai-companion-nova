import assert from "node:assert/strict";
import {ModelRequestGovernor} from "../../core/src/model-request-governor";

let slept:number[]=[];
const sleep=async(ms:number)=>{slept.push(ms)};
const make=(options:any={})=>new ModelRequestGovernor({maxConcurrentRequests:2,retryDelayMs:100,maxRetryDelayMs:1000,maxRetries:2,sleep,...options});

async function main(){
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve});
  const order:string[]=[];
  const governor=make({maxConcurrentRequests:1});
  const a=governor.run({id:"a",priority:"maintenance",execute:async()=>{order.push("a");await gate;return"a"}});
  const b=governor.run({id:"b",priority:"maintenance",execute:async()=>{order.push("b");return"b"}});
  const c=governor.run({id:"c",priority:"interactive",execute:async()=>{order.push("c");return"c"}});
  release();await Promise.all([a,b,c]);
  assert.deepEqual(order,["a","c","b"],"queue preserves priority without RPM polling");

  slept=[];
  let calls=0;
  const result=await make().run({id:"429",priority:"interactive",execute:async()=>{
    calls++;
    if(calls===1){const error:any=new Error("provider rate limit");error.chatError={retryable:true,details:{category:"rate_limit",httpStatus:429,retryAfterMs:500}};throw error}
    return"ok";
  }});
  assert.equal(result,"ok");assert.equal(calls,2);assert.deepEqual(slept,[500],"provider Retry-After controls an explicitly enabled retry");

  calls=0;
  const unrestricted= new ModelRequestGovernor({maxConcurrentRequests:1,maxRetries:0});
  for(let i=0;i<31;i++)await unrestricted.run({id:"req-"+i,priority:"interactive",execute:async()=>{calls++;return i}});
  assert.equal(calls,31,"31 requests are not rejected by a local RPM counter");
  console.log("PASS Model Request Governor tests");
}
main().catch(error=>{console.error(error);process.exitCode=1});
