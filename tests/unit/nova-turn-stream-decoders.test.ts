import {NovaTurnJsonSpeechStreamDecoder,NovaTurnTaggedSpeechStreamDecoder} from "../../core/src/nova-turn-stream-decoders";

function equal(actual:unknown,expected:unknown,label:string):void{
  if(actual!==expected)throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));
}
function ok(value:unknown,label:string):void{if(!value)throw new Error(label);}

function nativeJsonChunkBoundaries():void{
  const speech="Привет 😀, say \"hello\", path C:\\Nova, literal </SPEECH> and ampersand &.";
  const payload=JSON.stringify({speech,version:1,situation:"PRIVATE-SITUATION",thoughts:"PRIVATE-THOUGHTS",emotion:"PRIVATE-EMOTION",tools:[{name:"private.tool",arguments:{secret:"PRIVATE-TOOL"}}],longMemory:"PRIVATE-MEMORY",nextWakeMs:30000});
  for(let width=1;width<=17;width++){
    const decoder=new NovaTurnJsonSpeechStreamDecoder();let visible="";
    for(let i=0;i<payload.length;i+=width)visible+=decoder.push(payload.slice(i,i+width));
    equal(visible,speech,"native JSON speech with chunk width "+width);
    ok(!visible.includes("PRIVATE-")&&!visible.includes('{"speech"'),"JSON decoder never emits fields or raw JSON");
  }
}
function taggedChunkBoundaries():void{
  const speech="Текст с <SPEECH> как данные и & плюс \"кавычки\"";
  const encoded="Текст с &lt;SPEECH&gt; как данные и &amp; плюс &quot;кавычки&quot;";
  const protocol='<NOVA_TURN version="1"><SITUATION>PRIVATE-SITUATION</SITUATION><THOUGHTS>PRIVATE-THOUGHTS literal <SPEECH>PRIVATE-DECOY</SPEECH></THOUGHTS><EMOTION>PRIVATE-EMOTION</EMOTION><TOOLS><private.tool>{"x":"PRIVATE-TOOL"}</private.tool></TOOLS><SPEECH>'+encoded+'</SPEECH><LONGMEMORY>PRIVATE-MEMORY</LONGMEMORY><NEXT_WAKE_MS>30000</NEXT_WAKE_MS></NOVA_TURN>';
  for(let width=1;width<=19;width++){
    const decoder=new NovaTurnTaggedSpeechStreamDecoder();let visible="";
    for(let i=0;i<protocol.length;i+=width)visible+=decoder.push(protocol.slice(i,i+width));
    equal(visible,speech,"tagged SPEECH with chunk width "+width);
    ok(!visible.includes("PRIVATE-")&&!visible.includes("<SITUATION>")&&!visible.includes("<LONGMEMORY>"),"tag decoder never emits private fields");
  }
}
function hiddenFieldsAreNeverMistakenForSpeech():void{
  const decoder=new NovaTurnJsonSpeechStreamDecoder();
  const payload=JSON.stringify({situation:'quoted text "speech":"PRIVATE-DECOY" and \\u003cSPEECH\\u003e',speech:"Only this field is public",thoughts:"PRIVATE-THOUGHTS",longMemory:"PRIVATE-MEMORY",version:1,emotion:"private",tools:[],nextWakeMs:30000});
  let visible="";
  for(let i=0;i<payload.length;i+=5)visible+=decoder.push(payload.slice(i,i+5));
  equal(visible,"Only this field is public","JSON string contents cannot imitate a top-level speech key");
  const tags=new NovaTurnTaggedSpeechStreamDecoder();
  const tagged='<NOVA_TURN version="1"><THOUGHTS>PRIVATE-THOUGHTS <SPEECH>PRIVATE-DECOY</SPEECH></THOUGHTS><TOOLS><tool><SPEECH>PRIVATE-TOOL</SPEECH></tool></TOOLS><SPEECH>Only public speech</SPEECH><LONGMEMORY>PRIVATE-MEMORY</LONGMEMORY></NOVA_TURN>';
  visible="";
  for(let i=0;i<tagged.length;i+=7)visible+=tags.push(tagged.slice(i,i+7));
  equal(visible,"Only public speech","nested tag-like text in private fields and tools never reaches the UI");
}
function incompleteAndReset():void{
  const json=new NovaTurnJsonSpeechStreamDecoder();
  equal(json.push('{"speech":"already visible'),"already visible","native decoder emits prior to closing JSON quote/object");
  json.reset();
  let jsonText="";
  for(const chunk of ['{"speech":"new\\n','text \\uD83D','\\uDE00"'])jsonText+=json.push(chunk);
  equal(jsonText,"new\ntext 😀","native decoder handles split escapes and Unicode surrogate escapes");
  const tags=new NovaTurnTaggedSpeechStreamDecoder();
  equal(tags.push('<NOVA_TURN version="1"><SITUATION>private</SITUATION><THOUGHTS>hidden</THOUGHTS><EMOTION>private</EMOTION><TOOLS></TOOLS><SPEE'),"","partial top-level opening tag is not visible");
  let text="";
  text+=tags.push("CH>hello</SPEE");
  text+=tags.push("CH> secret </SPEECH>");
  equal(text,"hello","tag decoder stops exactly at split closing tag");
  tags.reset();
  equal(tags.push('<NOVA_TURN version="1"><SITUATION>private</SITUATION><THOUGHTS>hidden</THOUGHTS><EMOTION>private</EMOTION><TOOLS></TOOLS><SPEECH>again</SPEECH><LONGMEMORY></LONGMEMORY><NEXT_WAKE_MS>30000</NEXT_WAKE_MS></NOVA_TURN>'),"again","reset permits the next canonical turn stream");
}
nativeJsonChunkBoundaries();
taggedChunkBoundaries();
hiddenFieldsAreNeverMistakenForSpeech();
incompleteAndReset();
console.log("PASS NovaTurn incremental SPEECH decoders");
