export type ThoughtId=string;
export type ThoughtExpression="internal"|"external_candidate";
export type MindRuntimeLifecycleState="off"|"starting"|"thinking"|"stopping"|"error";

export interface Thought{
  id:ThoughtId;
  timestamp:string;
  content:string;
  expression:ThoughtExpression;
}

export interface MindState{
  focus:string|null;
  lastThought:Thought|null;
  lastThoughtAt:string|null;
  recentThoughts:readonly Thought[];
  lifecycleState:MindRuntimeLifecycleState;
}
