import type {DiagnosticsStore,Event,EventBus,EventHandler,Logger,Unsubscribe} from "../../contracts/src/index";

export class InMemoryEventBus implements EventBus {
  private readonly handlers=new Map<string,Set<EventHandler<unknown>>>();
  constructor(private readonly diagnostics?:DiagnosticsStore,private readonly logger?:Logger){}
  subscribe<T>(eventType:string,handler:EventHandler<T>):Unsubscribe{
    const set=this.handlers.get(eventType)??new Set<EventHandler<unknown>>();
    set.add(handler as EventHandler<unknown>); this.handlers.set(eventType,set);
    return ()=>{
      set.delete(handler as EventHandler<unknown>);
      if(set.size===0)this.handlers.delete(eventType);
    };
  }
  async publish<T>(event:Event<T>):Promise<void>{
    const handlers=[...(this.handlers.get(event.type)??[])];
    await Promise.allSettled(handlers.map(async handler=>{
      try{await handler(event);}
      catch(error){
        const message=error instanceof Error?error.message:String(error);
        this.diagnostics?.recordError("event-bus","EVENT_HANDLER_FAILED",message,{
          eventType:event.type,eventId:event.id,source:event.source
        });
        this.logger?.error("Event subscriber failed",{eventType:event.type,eventId:event.id,error:message});
      }
    }));
  }
  subscriberCount(type?:string){
    return type?this.handlers.get(type)?.size??0:[...this.handlers.values()].reduce((sum,set)=>sum+set.size,0);
  }
}
