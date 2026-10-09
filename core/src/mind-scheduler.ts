import type {MindWakeReason} from "../../contracts/src";

/** Owns the single scheduled wake timer for MindRuntime. */
export class MindScheduler{
  private timer:ReturnType<typeof setTimeout>|undefined;
  private deadline:number|undefined;
  private reason:MindWakeReason|undefined;
  constructor(private readonly onWake:(reason:MindWakeReason)=>void,private readonly now:()=>number=()=>Date.now()){}
  get nextWakeAt():string|null{return this.deadline===undefined?null:new Date(this.deadline).toISOString();}
  get scheduledReason():MindWakeReason|undefined{return this.reason;}
  schedule(delayMs:number,reason:MindWakeReason):number{
    if(!Number.isFinite(delayMs)||!Number.isInteger(delayMs)||delayMs<1)throw new Error("Mind Scheduler delay must be a positive integer.");
    this.cancel();
    const deadline=this.now()+delayMs;
    this.deadline=deadline;this.reason=reason;
    this.timer=setTimeout(()=>{
      this.timer=undefined;this.deadline=undefined;this.reason=undefined;
      this.onWake(reason);
    },delayMs);
    return deadline;
  }
  wake(reason:MindWakeReason):void{this.cancel();this.onWake(reason);}
  cancel():void{
    if(this.timer!==undefined)clearTimeout(this.timer);
    this.timer=undefined;this.deadline=undefined;this.reason=undefined;
  }
}
