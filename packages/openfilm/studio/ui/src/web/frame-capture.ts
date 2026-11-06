/**
 * Raster the currently displayed Film preview without asking the browser for CDP privileges.
 *
 * The outer timeline document is same-origin. Its visible clip may be a same-origin page iframe
 * (whose canvas/DOM we recursively flatten), a still/video/canvas, or ordinary DOM. External
 * resources are converted to data URLs before foreignObject rasterization so the output canvas
 * remains origin-clean and encodable. This is the page lane promised by D5; cross-origin page
 * clips still require the plugin-CDP lane and fail closed here.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

type CaptureElement = HTMLIFrameElement | HTMLCanvasElement | HTMLVideoElement | HTMLImageElement;

const styleOf = (element: Element): CSSStyleDeclaration | null => element.ownerDocument.defaultView?.getComputedStyle(element) ?? null;
const visible = (element: Element): boolean => {
  /* Each nested page owns another Window realm. Top-window constructors/getComputedStyle are not
     valid type tests for its elements even though the documents are same-origin. */
  const style = styleOf(element);
  if (!style) return false;
  const box = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0;
};

const fileDataUrl = async (url: string): Promise<string> => {
  if (url.startsWith('data:')) return url;
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`capture resource answered ${response.status}: ${new URL(url, location.href).pathname}`);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('capture resource could not be read'));
    reader.readAsDataURL(blob);
  });
};

const imageOf = async (src: string): Promise<HTMLImageElement> => {
  const image = new Image();
  image.decoding = 'sync';
  image.src = src;
  await image.decode();
  return image;
};

const canvasDataUrl = (source: CanvasImageSource, width: number, height: number): string => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
};

const replacementImage = (original: CaptureElement, copy: CaptureElement, src: string): HTMLImageElement => {
  const image = copy.ownerDocument.createElement('img');
  for (const attribute of [...copy.attributes]) {
    if (!['src', 'srcset'].includes(attribute.name)) image.setAttribute(attribute.name, attribute.value);
  }
  image.src = src;
  image.style.cssText = copy.getAttribute('style') ?? '';
  const style = styleOf(original);
  if (style) {
    /* A canvas/video/iframe becomes an img in the clone, so tag selectors no longer apply. Copy
       its computed presentation (position, transform, clip, opacity…) to keep the replacement in
       exactly the layer the person saw. Full-stage composites take the direct fast path and never
       pay this per-property cost. */
    for (const property of [...style]) {
      image.style.setProperty(property, style.getPropertyValue(property), style.getPropertyPriority(property));
    }
    image.style.objectFit = style.objectFit || 'fill';
    image.style.objectPosition = style.objectPosition || '50% 50%';
  }
  return image;
};

async function captureDocumentCanvas(document_: Document, width: number, height: number, transparent = false): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('2D canvas is unavailable');
  if(!transparent){ctx.fillStyle = '#000';ctx.fillRect(0, 0, canvas.width, canvas.height);}
  await drawDocument(ctx, document_, canvas.width, canvas.height);
  return canvas;
}

async function htmlImage(document_: Document, width: number, height: number): Promise<HTMLImageElement> {
  const clone = document_.documentElement.cloneNode(true) as HTMLElement;
  clone.setAttribute('xmlns', XHTML_NS);
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.style.overflow = 'hidden';
  clone.querySelectorAll('script, link[rel="modulepreload"], link[rel="preload"]').forEach((node) => node.remove());

  /* Resolve stylesheet/media links before the document moves under an opaque data: SVG URL. */
  for (const node of clone.querySelectorAll<HTMLElement>('[href],[src]')) {
    for (const attribute of ['href', 'src'] as const) {
      const value = node.getAttribute(attribute);
      if (value && !value.startsWith('data:') && !value.startsWith('blob:')) {
        try { node.setAttribute(attribute, new URL(value, document_.baseURI).href); } catch { /* malformed URLs fail when drawn */ }
      }
    }
  }

  const originals = [...document_.querySelectorAll<CaptureElement>('iframe,canvas,video,img')];
  const copies = [...clone.querySelectorAll<CaptureElement>('iframe,canvas,video,img')];
  for (let index = 0; index < copies.length; index += 1) {
    const original = originals[index];
    const copy = copies[index];
    if (!original || !copy || !visible(original)) continue;
    const box = original.getBoundingClientRect();
    let src: string;
    if (original.tagName === 'IMG') {
      src = await fileDataUrl((original as HTMLImageElement).currentSrc || (original as HTMLImageElement).src);
    } else if (original.tagName === 'IFRAME') {
      let child: Document | null = null;
      try { child = (original as HTMLIFrameElement).contentDocument; } catch { /* cross-origin: fail below */ }
      if (!child) throw new Error('the visible page clip is cross-origin; connect the Browser bridge CDP lane to capture it');
      // Nested layers retain alpha; only the final output chooses its background.
      src = (await captureDocumentCanvas(child, box.width, box.height, true)).toDataURL('image/png');
    } else {
      src = canvasDataUrl(original as CanvasImageSource, box.width, box.height);
    }
    copy.replaceWith(replacementImage(original, copy, src));
  }

  const svg = `<svg xmlns="${SVG_NS}" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`;
  return imageOf(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

const coversViewport = (element: Element, document_: Document): boolean => {
  const box = element.getBoundingClientRect();
  const root = document_.documentElement;
  const width = root.clientWidth || root.getBoundingClientRect().width;
  const height = root.clientHeight || root.getBoundingClientRect().height;
  return box.left <= 1 && box.top <= 1 && box.right >= width - 1 && box.bottom >= height - 1;
};

const onlyVisualBranch = (element: Element): boolean => {
  const ignored = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'BASE']);
  let branch: Element = element;
  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of [...parent.children]) {
      if (sibling !== branch && !ignored.has(sibling.tagName) && visible(sibling)) return false;
    }
    for (const child of [...parent.childNodes]) {
      if (child !== branch && child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) return false;
    }
    if (parent === element.ownerDocument.documentElement) break;
    branch = parent;
  }
  return true;
};

async function drawDocument(ctx: CanvasRenderingContext2D, document_: Document, width: number, height: number): Promise<boolean> {
  const candidates = [...document_.querySelectorAll<CaptureElement>('iframe,canvas,video,img')].filter(visible);
  const source = candidates.sort((a, b) => {
    const za = Number.parseInt(styleOf(a)?.zIndex || '0', 10) || 0;
    const zb = Number.parseInt(styleOf(b)?.zIndex || '0', 10) || 0;
    return za - zb;
  }).at(-1);
  /* A full-stage canvas/video/image or page iframe is already the composite. Drawing it directly
     is both exact and cheap for long exports. A smaller media element is only one layer: flatten
     it into a clone and raster the complete DOM instead of stretching that one layer full-stage. */
  if (source && coversViewport(source, document_) && onlyVisualBranch(source)) {
    if (source.tagName === 'IFRAME') {
      let child: Document | null = null;
      try { child = (source as HTMLIFrameElement).contentDocument; } catch { /* cross-origin: fail below */ }
      if (!child) throw new Error('the visible page clip is cross-origin; connect the Browser bridge CDP lane to capture it');
      await drawDocument(ctx, child, width, height);
      return true;
    }
    ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
    return true;
  }
  ctx.drawImage(await htmlImage(document_, width, height), 0, 0, width, height);
  return true;
}

/** Current frame as an origin-clean stage-sized canvas. */
export async function capturePreviewFrame(frame: HTMLIFrameElement, stage: { w: number; h: number }, transparent = false): Promise<HTMLCanvasElement> {
  const document_ = frame.contentDocument;
  if (!document_) throw new Error('the Film preview is not same-origin');
  return captureDocumentCanvas(document_, stage.w, stage.h, transparent);
}
