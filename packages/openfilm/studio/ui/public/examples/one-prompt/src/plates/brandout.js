// FDE2E edition end plate. The upstream OpenFilm mark/wordmark was deliberately removed: this
// adaptation keeps the scene timing and replaces the trademarked lockup with FDE2E product text.
import { Scene } from '../px/scene.js';
import { Layer2D, clearRT } from '../px/gl.js';
import { LIN, rgba } from '../px/palette.js';
import { F, font } from '../px/type.js';
import { clamp, ease } from '../px/util.js';
import { EDGE_POST } from './leader-kit.js';

const progress = (t, a, b) => clamp((t - a) / Math.max(1e-6, b - a));

export default class BrandOut extends Scene {
  text = new Layer2D();

  render(f, out) {
    const { renderer, comp, start, end } = this.ctx;
    clearRT(renderer, out, LIN.ink);
    const c = this.text.ctx;
    this.text.clear();
    const appear = ease.outExpo(progress(f.t, start, start + 0.38));
    const fade = 1 - ease.inCubic(progress(f.t, end - 0.42, end - 0.03));
    const alpha = appear * fade;

    c.save();
    c.translate(960, 520);
    c.scale(0.88 + appear * 0.12, 1);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = font(F.archivo(100, 900), 186);
    c.letterSpacing = '10px';
    c.fillStyle = rgba('bone', alpha);
    c.fillText('FDE2E', 0, 0);
    c.letterSpacing = '0px';
    c.restore();

    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.font = font(F.mono(500), 31);
    c.letterSpacing = '5px';
    c.fillStyle = rgba('signal', alpha * 0.95);
    c.fillText('FILM.TOOL.FDE2E.COM', 960, 690);
    c.letterSpacing = '0px';
    comp.draw(renderer, this.text.upload(), out);
    return { ...EDGE_POST, bloom: 0.68, halation: 0.3, fade: 1 - fade };
  }
}
