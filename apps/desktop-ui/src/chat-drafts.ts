export type ChatDraftMap=Readonly<Record<string,string>>;

export function chatDraftKey(characterId:string,conversationId:string):string{
  return JSON.stringify([characterId,conversationId]);
}

export function readChatDraft(drafts:ChatDraftMap,key:string):string{
  return drafts[key]??"";
}

export function writeChatDraft(drafts:ChatDraftMap,key:string,value:string):Record<string,string>{
  return {...drafts,[key]:value};
}

export function clearSubmittedChatDraft(
  drafts:Record<string,string>,
  key:string,
  submitted:string
):Record<string,string>{
  return drafts[key]===submitted?{...drafts,[key]:""}:drafts;
}
