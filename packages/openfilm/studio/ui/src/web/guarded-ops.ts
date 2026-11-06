import { applyOps } from '../../../server/ops.mjs';
import type { Film, Op } from '../api';

/** Guard the original transaction, so unlock+remove in a raw batch cannot bypass a lock. */
export function guardedOps(film: Film, ops: Op[]): Film {
  const locked = film.tracks.filter((track) => track.locked);
  const after = applyOps(structuredClone(film), ops) as Film;
  for (const track of locked) {
    const ids = new Set(track.clips.map((clip) => clip.id));
    if (!ids.size) {
      const index = film.tracks.indexOf(track);
      if (ops.some((op) => (op.op === 'insert' || op.op === 'move') && op.track === index)) throw new Error('destination track is locked');
      continue;
    }
    const destination = after.tracks.find((candidate) => candidate.clips.some((clip) => ids.has(clip.id)));
    if (!destination || JSON.stringify(destination.clips) !== JSON.stringify(track.clips)) {
      throw new Error('a locked track cannot be changed; unlock it in a separate action first');
    }
  }
  return after;
}
