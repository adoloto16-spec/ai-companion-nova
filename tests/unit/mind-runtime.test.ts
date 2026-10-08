import {DeterministicCognitiveStep,MindRuntime,type CognitiveStep,type CognitiveStepContext} from "../../core/src";

function equal(actual:unknown,expected:unknown,label:string){
  if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));
}
function ok(value:unknown,label:string){
  if(!value)throw new Error(label);
}
async function waitFor(predicate:()=>boolean,timeoutMs=500):Promise<void>{
  const deadline=Date.now()+timeoutMs;
  while(!predicate()){
    if(Date.now()>=deadline)throw new Error("Timed out waiting for condition.");
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}

async function startRuntimeTest(){
  const runtime=new MindRuntime({
    cognitiveStep:new DeterministicCognitiveStep(),
    stepIntervalMs:2
  });
  await runtime.start();
  await waitFor(()=>runtime.getState().recentThoughts.length>=3);
  const state=runtime.getState();
  equal(state.lifecycleState,"thinking","runtime stays thinking between cognitive steps");
  ok(state.lastThought!==null,"start produces a thought");
  await runtime.stop();
  equal(runtime.getState().lifecycleState,"off","stop transitions runtime to off");
  console.log("PASS Mind Runtime start");
}

async function sequentialStepsTest(){
  const seen:string[]=[];
  class Step implements CognitiveStep{
    running=0;
    maxRunning=0;
    async run(context:CognitiveStepContext){
      this.running+=1;
      this.maxRunning=Math.max(this.maxRunning,this.running);
      try{
        await new Promise(resolve=>setTimeout(resolve,4));
        const sequence=seen.length+1;
        seen.push(context.state.lastThought?.id??"none");
        return {
          id:"thought:"+sequence,
          timestamp:new Date().toISOString(),
          content:"step "+sequence,
          expression:"internal" as const
        };
      }finally{
        this.running-=1;
      }
    }
  }
  const step=new Step();
  const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:1,recentThoughtLimit:3});
  await runtime.start();
  await waitFor(()=>runtime.getState().recentThoughts.length>=4);
  await runtime.stop();

  const state=runtime.getState();
  equal(step.maxRunning,1,"only one cognitive step runs at a time");
  equal(state.recentThoughts.length,3,"recent thought history is bounded");
  equal(state.recentThoughts[0]?.id,"thought:2","oldest thought is evicted when the limit is reached");
  equal(state.lastThought?.id,"thought:4","latest thought is the final completed step");
  equal(seen[0],"none","first cognitive step sees initial state");
  equal(seen[1],"thought:1","second cognitive step sees first thought");
  equal(seen[2],"thought:2","third cognitive step sees second thought");
  console.log("PASS Mind Runtime sequential steps");
}

async function statePreservationTest(){
  const timestamps=[
    "2026-10-08T10:00:00.000Z",
    "2026-10-08T10:00:00.025Z",
    "2026-10-08T10:00:00.050Z"
  ];
  let index=0;
  const runtime=new MindRuntime({
    cognitiveStep:new DeterministicCognitiveStep(()=>timestamps[index++]??timestamps[timestamps.length-1]!),
    stepIntervalMs:1,
    initialFocus:"conversation"
  });
  await runtime.start();
  await waitFor(()=>runtime.getState().recentThoughts.length>=3);
  await runtime.stop();

  const state=runtime.getState();
  equal(state.focus,"conversation","focus survives multiple cognitive steps");
  equal(state.lastThoughtAt,timestamps[2],"last thought time survives into MindState");
  equal(state.recentThoughts.length,3,"MindState retains recent thoughts");
  equal(state.recentThoughts[1]?.content,"Internal continuation after thought:deterministic:1","later thought reads the previous state");
  console.log("PASS Mind Runtime state preservation");
}

async function stopDuringActiveStepTest(){
  let started=0;
  let resolveStep:()=>void=()=>{};
  const step:CognitiveStep={
    run:({signal})=>{
      started+=1;
      return new Promise((resolve,reject)=>{
        resolveStep=()=>{
          resolve({
            id:"thought:late",
            timestamp:new Date().toISOString(),
            content:"late result",
            expression:"internal"
          });
        };
        signal.addEventListener("abort",()=>{
          reject(MindRuntime.createAbortError());
        },{once:true});
      });
    }
  };
  const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:1});
  await runtime.start();
  await waitFor(()=>started===1);
  const stopPromise=runtime.stop();
  equal(runtime.getState().lifecycleState,"stopping","stop marks an active step as stopping");
  await stopPromise;
  resolveStep();

  equal(runtime.getState().lifecycleState,"off","runtime stops after an active cognitive step");
  equal(runtime.getState().lastThought,null,"aborted active step cannot publish a thought");
  await new Promise(resolve=>setTimeout(resolve,20));
  equal(runtime.getState().recentThoughts.length,0,"no thought appears after stop");
  console.log("PASS Mind Runtime stop during active step");
}

async function restartAfterStopTest(){
  const step=new DeterministicCognitiveStep();
  const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:1});
  await runtime.start();
  await waitFor(()=>runtime.getState().recentThoughts.length>=2);
  await runtime.stop();
  const firstStopCount=runtime.getState().recentThoughts.length;
  await runtime.start();
  await waitFor(()=>runtime.getState().lastThought?.id==="thought:deterministic:3");
  await runtime.stop();

  equal(firstStopCount,2,"first stop completes after multiple thoughts");
  equal(runtime.getState().lastThought?.id,"thought:deterministic:3","restart continues the cognitive sequence");
  equal(runtime.getState().lifecycleState,"off","runtime can stop after restart");
  console.log("PASS Mind Runtime restart");
}

async function stopPreventsNewThoughtsTest(){
  let count=0;
  const step:CognitiveStep={
    async run(){
      count+=1;
      return {
        id:"thought:"+count,
        timestamp:new Date().toISOString(),
        content:"internal",
        expression:"internal" as const
      };
    }
  };
  const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:5});
  await runtime.start();
  await waitFor(()=>count>=3);
  await runtime.stop();
  const stoppedCount=count;
  await new Promise(resolve=>setTimeout(resolve,30));
  equal(count,stoppedCount,"no new cognitive steps run after stop");
  console.log("PASS Mind Runtime no thoughts after stop");
}

async function cognitiveErrorTest(){
  let count=0;
  const step:CognitiveStep={
    async run(){
      count+=1;
      throw new Error("cognitive failure");
    }
  };
  const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:1});
  await runtime.start();
  await waitFor(()=>runtime.getState().lifecycleState==="error");
  equal(count,1,"cognitive error stops the sequence");
  await new Promise(resolve=>setTimeout(resolve,20));
  equal(count,1,"error state does not restart cognition");
  equal(runtime.getState().lastThought,null,"failed cognitive step is not stored as a thought");
  await runtime.stop();
  equal(runtime.getState().lifecycleState,"off","stop clears the error lifecycle state");
  console.log("PASS Mind Runtime cognitive error");
}

async function main(){
  await startRuntimeTest();
  await sequentialStepsTest();
  await statePreservationTest();
  await stopDuringActiveStepTest();
  await restartAfterStopTest();
  await stopPreventsNewThoughtsTest();
  await cognitiveErrorTest();
  console.log("PASS Mind Runtime v1 unit tests");
}

void main().catch(error=>{
  console.error(error);
  process.exitCode=1;
});
