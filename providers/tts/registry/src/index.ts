import type {TtsProvider,TtsProviderCapabilities} from "../../../../contracts/src/tts";

export interface TtsProviderDescriptor {
  id:string;
  capabilities:TtsProviderCapabilities;
}
export type TtsProviderFactory=()=>TtsProvider;

/** Composition-root owned registry; no concrete provider dependencies live here. */
export class TtsProviderRegistry {
  private readonly factories=new Map<string,TtsProviderFactory>();
  private readonly instances=new Map<string,TtsProvider>();

  register(factory:TtsProviderFactory):void {
    const provider=factory();
    if(!provider.id||this.factories.has(provider.id))throw new Error("TTS provider id is missing or already registered.");
    this.factories.set(provider.id,factory);
    this.instances.set(provider.id,provider);
  }

  get(id:string):TtsProvider|undefined {
    return this.instances.get(id);
  }

  list():TtsProviderDescriptor[] {
    return [...this.instances.values()].map(provider=>({id:provider.id,capabilities:provider.capabilities()}));
  }
}
