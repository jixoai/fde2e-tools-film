/**
 * What this release brings, said to the person after an update, in every language Studio speaks (a release without them
 * all does not compile), grouped as new, improved and fixed. Only this release's: the dialog tells what the version now
 * running brings, and the changelog on GitHub keeps every release's.
 *
 * Written when a release is made (the "Version packages" pull request), in place of the release before's: the
 * changesets say everything that changed, for the changelog; these say every change a person would notice, in their
 * words, one line each (at most 24). A version without them fails the tests (whats-new.test.ts), so that pull request
 * cannot be merged until they are written.
 *
 * After an update they appear once (Studio's prefs keep `seenVersion`). A new install shows none: there is nothing it
 * was updated from.
 */
import type { Language } from '@/i18n';

export type NoteKind = 'new' | 'improved' | 'fixed';
export interface ReleaseNote { kind: NoteKind; text: string }
export interface ReleaseNotes { version: string; date: string; notes: Record<Language, ReleaseNote[]> }

export const RELEASE: ReleaseNotes = {
  version: '0.3.0',
  date: '2026-11-05',
  notes: {
    en: [
      { kind: 'new', text: 'FDE2E Film now runs as a private, browser-only studio: projects, media, versions and exports stay in this browser’s OPFS.' },
      { kind: 'new', text: 'Agents can use the same editor through 44 WebMCP tools for projects, media, timeline edits, versions and exports.' },
      { kind: 'new', text: 'Import existing media from local files, base64/data payloads or approved HTTPS media hosts; Film never asks for a provider key.' },
      { kind: 'improved', text: 'MP4 and WebM exports stream frames into WebCodecs with bounded memory, optional browser-side audio mixing and persistent download files.' },
      { kind: 'fixed', text: 'Page clips export as their real pixels instead of black frames, long exports survive agent call timeouts, and the Web export tray offers actions that work in a browser.' },
    ],
    'zh-CN': [
      { kind: 'new', text: 'FDE2E Film 现已成为纯浏览器私有工作台：项目、素材、版本和导出物全部保存在当前浏览器的 OPFS。' },
      { kind: 'new', text: 'Agent 可通过 44 项 WebMCP 工具使用同一套编辑器，完成项目、素材、时间线、版本与导出操作。' },
      { kind: 'new', text: '可从本地文件、base64/data 载荷或获准的 HTTPS 素材域接入现成媒体；Film 永不索取 provider key。' },
      { kind: 'improved', text: 'MP4/WebM 导出改为有界内存流式送入 WebCodecs，可在浏览器内混音，并把成品持久保存到 downloads。' },
      { kind: 'fixed', text: '页面片段不再导出黑帧，长导出不再受 Agent 单次调用超时支配，Web 导出托盘只显示浏览器中真正可用的操作。' },
    ],
    ja: [
      { kind: 'new', text: 'FDE2E Film はブラウザだけで動く非公開スタジオになりました。プロジェクト、素材、版、書き出しはこのブラウザの OPFS に残ります。' },
      { kind: 'new', text: 'エージェントは 44 個の WebMCP ツールから同じ編集画面を使い、プロジェクト、素材、タイムライン、版、書き出しを操作できます。' },
      { kind: 'new', text: 'ローカルファイル、base64/data、許可済み HTTPS 素材ホストから既存メディアを取り込めます。Film が provider key を求めることはありません。' },
      { kind: 'improved', text: 'MP4/WebM はフレームを WebCodecs へ逐次渡し、メモリを制限したまま音声をブラウザ内でミックスし、downloads に保存します。' },
      { kind: 'fixed', text: 'ページクリップの黒画面、長い書き出しの呼び出しタイムアウト、ブラウザで使えない書き出し操作を修正しました。' },
    ],
    ko: [
      { kind: 'new', text: 'FDE2E Film은 브라우저 전용 비공개 스튜디오로 동작합니다. 프로젝트, 미디어, 버전, 내보내기 파일은 이 브라우저의 OPFS에 남습니다.' },
      { kind: 'new', text: '에이전트는 44개 WebMCP 도구로 같은 편집기를 사용해 프로젝트, 미디어, 타임라인, 버전과 내보내기를 다룰 수 있습니다.' },
      { kind: 'new', text: '로컬 파일, base64/data 또는 허용된 HTTPS 미디어 호스트에서 기존 미디어를 가져옵니다. Film은 provider key를 요구하지 않습니다.' },
      { kind: 'improved', text: 'MP4/WebM 프레임을 WebCodecs에 스트리밍해 메모리를 제한하고, 브라우저에서 오디오를 믹스하며, 결과를 downloads에 보관합니다.' },
      { kind: 'fixed', text: '페이지 클립의 검은 프레임, 긴 내보내기의 호출 시간 초과, 브라우저에서 쓸 수 없던 내보내기 동작을 수정했습니다.' },
    ],
    es: [
      { kind: 'new', text: 'FDE2E Film funciona como un estudio privado solo para navegador: proyectos, medios, versiones y exportaciones permanecen en el OPFS de este navegador.' },
      { kind: 'new', text: 'Los agentes usan el mismo editor mediante 44 herramientas WebMCP para proyectos, medios, línea de tiempo, versiones y exportaciones.' },
      { kind: 'new', text: 'Importa medios existentes desde archivos locales, base64/data o hosts HTTPS aprobados; Film nunca solicita una clave de proveedor.' },
      { kind: 'improved', text: 'MP4 y WebM envían fotogramas a WebCodecs con memoria acotada, mezcla de audio opcional en el navegador y archivos persistentes en downloads.' },
      { kind: 'fixed', text: 'Se corrigieron los fotogramas negros de páginas, los tiempos de espera en exportaciones largas y las acciones de escritorio que no funcionaban en la Web.' },
    ],
  },
};

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b` (x.y.z; a pre-release is older than its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ''] = v.split('-');
    return { parts: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** This release's notes when `version` is this release, else null. */
export function releaseNotes(version: string, release: ReleaseNotes = RELEASE): ReleaseNotes | null {
  return compareVersions(release.version, version) === 0 ? release : null;
}

/** Said on the window to show this release's notes again (Settings → About, Developer's preview). */
export const WHATS_NEW_EVENT = 'openfilm:whats-new';
export function showWhatsNew(): void {
  window.dispatchEvent(new CustomEvent(WHATS_NEW_EVENT));
}
