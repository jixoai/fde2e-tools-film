/** Local VTT projection: the same parser and clipping rules as the server face. */
import { parseVtt, vttOf } from '../../../server/transcript-format.mjs';
import { changeTranscriptLine } from '../../../server/transcript-edit.mjs';
import { clipCues } from '../../../server/caption-projection.mjs';
import { filmSubtitleLanguageOf, filmSubtitleLanguagesIn } from '../../../server/film-subtitle.mjs';
import { readFilmFile } from '../../../../src/film-doc.mjs';
import { readFilm, readFileText, writePage, filmRev, listFiles } from './opfs/index.ts';
import { spansFor } from '../lib/film-runtime.ts';
import type { FilmCaptions } from '../lib/subtitles.ts';
import type { SourceCue } from '../lib/subtitle-cues.ts';

const transcriptPath = (src: string) => src.replace(/\.[^/.]+$/, '') + '.vtt';
export async function sourceCaptions(id: string, src: string) {
  const text = await readFileText(id, transcriptPath(src));
  const parsed = parseVtt(text ?? '');
  return {src,cut:parsed.cut === true,cues:parsed.lines as SourceCue[]};
}
export async function saveSourceCaptions(id: string, src: string, cues: SourceCue[]) {
  if (!Array.isArray(cues) || cues.some(c=>!Number.isFinite(c.startMs)||!Number.isFinite(c.endMs)||c.startMs<0||c.endMs<=c.startMs||typeof c.text!=='string')) throw new Error('invalid subtitle cues');
  const path=transcriptPath(src),before=await readFileText(id,path);
  const text=vttOf(cues,{cut:true});await writePage(id,path,text,before===null?null:await filmRev(before));
  return {before:{files:{[path]:before}},after:{files:{[path]:text}}};
}
export async function saveCaptionLine(id:string,change:{src:string;line:number;part?:number;text:string;language?:string}):Promise<boolean>{
  if(change.language&&!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(change.language))throw new Error('invalid subtitle language');
  const sourcePath=transcriptPath(change.src),original=await readFileText(id,sourcePath);
  const path=change.language?sourcePath.slice(0,-4)+`.${change.language}.vtt`:sourcePath;
  const before=path===sourcePath?original:await readFileText(id,path);
  const next=changeTranscriptLine(original===null?null:parseVtt(original),{...change,startMs:change.line},change.language&&before!==null?parseVtt(before):undefined);
  if(!next)return false;
  await writePage(id,path,vttOf(next.lines,next),before===null?null:await filmRev(before));return true;
}
export async function projectCaptions(id: string): Promise<FilmCaptions> {
  const film=await readFilm(id);const doc=film?readFilmFile(film.text).doc:null;
  const cues:FilmCaptions['cues']=[],untranscribed:string[]=[];
  const spans=spansFor(id),files=await listFiles(id);
  for(const track of doc?.tracks??[]) for(const clip of track.clips) {
    if(track.muted||track.hidden||(clip.volume??1)<=0||!(/\.(?:mp3|wav|m4a|aac|ogg|opus|flac|mp4|webm|mov)$/i.test(clip.src)))continue;
    const path=transcriptPath(clip.src),text=await readFileText(id,path);
    if(!text){untranscribed.push(clip.src);continue;}
    const transcript=parseVtt(text);const speed=clip.speed??1,at=clip.at??0,from=clip.time?.[0]??0;
    const end=clip.time?.[1]??spans?.find(s=>s.id===clip.id)?.native??(transcript.lines.at(-1)?.endMs??0)/1000;
    if(!Number.isFinite(end)||end<=from)continue;
    const alt = new Map<number,Record<string,string>>();
    const prefix=path.slice(0,-4)+'.';
    for(const file of files.files.filter(f=>f.path.startsWith(prefix)&&f.path.endsWith('.vtt'))){
      const language=file.path.slice(prefix.length,-4);if(language.includes('/'))continue;
      const translated=parseVtt(await readFileText(id,file.path)??'');
      for(const line of translated.lines)alt.set(line.startMs,{...alt.get(line.startMs),[language]:line.text});
    }
    cues.push(...clipCues(transcript.lines,{startMs:at*1000,fromMs:from*1000,durMs:(end-from)/speed*1000,speed},{src:clip.src,clip:clip.id,cut:transcript.cut,speaker:transcript.speaker,alt}));
  }
  cues.sort((a,b)=>a.startMs-b.startMs);
  return {cues,sourceLanguage:filmSubtitleLanguageOf(cues.map(c=>c.text).join(' ')),languages:filmSubtitleLanguagesIn(cues),untranscribed:[...new Set(untranscribed)]};
}
