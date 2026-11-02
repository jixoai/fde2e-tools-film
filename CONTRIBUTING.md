# Contributing

Issues and pull requests are welcome (against `jixoai/fde2e-tools-film`, not upstream OpenFilm).

## Quick start

You need Node 22.18 or later (the tests run TypeScript directly), pnpm 9 (`corepack enable` gives the version
package.json names), ffmpeg on the PATH, and git.

```sh
pnpm install
pnpm dev          # Studio on http://localhost:4848, a sample project opens
pnpm test
pnpm build
```

## What this fork is

A destructive web transformation of [OpenFilm](https://github.com/openfilm/openfilm) (MIT): CLI → WebMCP,
ffmpeg CLI → in-browser encode, local files → OPFS. See [FORK.md](FORK.md) for the fork chain, the anchor
commit and what was cut. The film format spec (`packages/openfilm/SPEC.md`) and the verb manual
(`packages/openfilm/MANUAL.md`) are the contracts the web product follows.
