// Media seeks that land inside the frame they name. A plain `video.currentTime = t` at a frame boundary otherwise
// shows the previous frame about a third of the time. Every page that draws a film by seeking video runs it first,
// so the same t shows the same source frame in `look`, `render` and Studio's export.
export const SEEK_INSIDE_FRAME = `(()=>{const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');if(d.set.__film)return;const set=function(v){d.set.call(this,Number(v)+0.001)};set.__film=true;Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{configurable:true,enumerable:true,get(){return d.get.call(this)},set})})();`;
// The film's clock, for a page hosted to be drawn. Until the host draws the first frame the page runs on real time
// (loading may wait on timers and clocks); from then on, everything a page can read time from says the frame's t:
// `performance.now()` and requestAnimationFrame's timestamp are t in ms, `Date` is t after a fixed epoch, CSS and
// Web Animations the page left running stand at t (a CSS transition, whose progress is history, is finished), and
// `Math.random` restarts from a seed of t (and runs from a fixed seed while loading). So a page drawn with CSS
// keyframes, a requestAnimationFrame loop or random particles still draws the same picture for the same t, whatever
// was drawn before. The host calls `filmHost.time(t)` before `film.frame(t)` and `filmHost.settle(t)` after it;
// `filmHost.now()` is the real clock, for the host's own waiting.
export const FILM_CLOCK = `(()=>{const H=window.filmHost;if(!H||H.time)return;const P=performance,now=P.now.bind(P),D=Date,raf=window.requestAnimationFrame.bind(window),EPOCH=D.UTC(2026,0,1);let v=null,seed=0x2545f491;H.now=now;P.now=()=>v==null?now():v;function FilmDate(...a){const d=a.length||v==null?new D(...a):new D(EPOCH+v);return new.target?d:d.toString()}FilmDate.prototype=D.prototype;FilmDate.now=()=>v==null?D.now():EPOCH+v;FilmDate.parse=D.parse;FilmDate.UTC=D.UTC;window.Date=FilmDate;window.requestAnimationFrame=(cb)=>raf((ts)=>cb(v==null?ts:v));Math.random=()=>{seed=seed+0x6d2b79f5|0;let x=Math.imul(seed^seed>>>15,1|seed);x=x+Math.imul(x^x>>>7,61|x)^x;return((x^x>>>14)>>>0)/4294967296};const mine=new WeakSet();H.time=(t)=>{v=t*1000;seed=(Math.round(t*1e6)^0x2545f491)|0};H.settle=(t)=>{for(const a of document.getAnimations?.()??[]){if(typeof CSSTransition!=='undefined'&&a instanceof CSSTransition){a.finish();continue}if(!mine.has(a)){if(a.playState==='paused'||a.playState==='idle')continue;mine.add(a)}a.pause();a.currentTime=t*1000}}})();`;
// Before any page script: the host flag, the seek fix and the clock above.
export const HOST_FLAG = `window.filmHost={version:'0.1',name:'film'};${SEEK_INSIDE_FRAME}${FILM_CLOCK}`;
