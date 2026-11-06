/** The same correction semantics for server and OPFS transcripts. */
import { alignTranslation, replacePiece, segmentLine } from './subtitle-segments.mjs';
/**
 * @param {import('./transcript-format.mjs').Transcript | null} had
 * @param {{startMs:number,text:string,language?:string,part?:number}} change
 * @param {import('./transcript-format.mjs').Transcript | null} [translation]
 * @returns {import('./transcript-format.mjs').Transcript | null}
 */
export function changeTranscriptLine(had, change, translation) {
  const {startMs,text,language,part}=change;
  const original=had?.lines.find(l=>l.startMs===startMs);
  if(!had||!original)return null;
  const said=text.replace(/\s+/g,' ').trim();
  const pieces=part===undefined||had.cut?null:segmentLine(original),piece=pieces?.[part??0];
  if(pieces&&!piece)return null;
  if(language){
    const kept=translation?.lines??[],others=kept.filter(l=>l.startMs!==startMs),before=kept.find(l=>l.startMs===startMs);
    const next=before&&pieces&&piece?replacePiece(before,alignTranslation(before.text,pieces)[piece.part],said).text:said;
    return {lines:next?[...others,{text:next,startMs,endMs:original.endMs}].sort((a,b)=>a.startMs-b.startMs):others};
  }
  let changed;
  if(piece){const next=replacePiece(original,piece,said,piece.startMs);changed=next.text?{...next,startMs:original.startMs,endMs:original.endMs}:null;}
  else{if(said===original.text)return had;changed=said?{text:said,startMs:original.startMs,endMs:original.endMs}:null;}
  return {...had,lines:changed?had.lines.map(l=>l===original?changed:l):had.lines.filter(l=>l!==original)};
}
