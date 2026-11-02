import React from 'react';

/*
 * FDE2E Film's mark (fork rebrand, T01): a slate-and-playhead glyph drawn with the surrounding
 * text's color. The upstream OpenFilm mark is not used: the fork does not carry upstream's
 * trademark (FORK.md). A final bound mark arrives with the appicon pipeline (batch 6).
 */
export function BrandLogo({ size = 18 }: { size?: number }) {
  const gap = `fde2e-film-gap-${React.useId().replace(/:/g, '')}`;
  const playhead = 'M38 18H52C55.3 18 58 20.7 58 24V36L66 42C68 43.5 68 46.5 66 48L58 54V82C58 85.3 55.3 88 52 88H38C34.7 88 32 85.3 32 82V54L24 48C22 46.5 22 43.5 24 42L32 36V24C32 20.7 34.7 18 38 18Z';
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="currentColor" className="block shrink-0" role="img" aria-label="FDE2E Film">
      <mask id={gap} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <rect width="100" height="100" fill="#fff" />
        <path d={playhead} stroke="#000" strokeWidth="8" strokeLinejoin="round" />
      </mask>
      <g mask={`url(#${gap})`}>
        <rect x="20" y="12" width="64" height="20" rx="5" />
        <rect x="20" y="68" width="64" height="20" rx="5" />
        <rect x="72" y="20" width="16" height="60" rx="5" />
      </g>
      <path d={playhead} />
    </svg>
  );
}
