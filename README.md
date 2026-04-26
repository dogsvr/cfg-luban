# cfg-luban

Monorepo hosting two independent npm packages that together form the dogsvr game-config pipeline:

| Directory | npm package | Purpose |
|---|---|---|
| [`cfg-luban/`](./cfg-luban/) | `@dogsvr/cfg-luban` | Runtime library — loads the generated LMDB and exposes lookup APIs (`getCfgRow`, `getCfgRowList`, `forEachCfgRow`, …) |
| [`cfg-luban-cli/`](./cfg-luban-cli/) | `@dogsvr/cfg-luban-cli` | Codegen CLI — compiles designer Excel → FlatBuffers → LMDB |

`designer_cfg/` (the actual Excel source) lives in business-side repos, not here — see [`example-proj-cfg/`](../example-proj-cfg) for a working integration example.

## Repo structure

Two packages, flat layout, no npm workspaces. Each package has its own `package.json`, `node_modules`, and `dist`; install and build independently:

```sh
cd cfg-luban     && npm install && npm run build
cd cfg-luban-cli && npm install && npm run build
```

For usage, API reference, and pipeline details, see each package's own README linked above.

## Development

### Building

Each package is a standard tsc project:

```sh
cd <pkg> && npm run build    # rm -rf dist && tsc [&& chmod +x dist/cli.js for CLI]
```

Verification across the repo is build-only; no tests, no lint.

### Local iteration against `example-proj-cfg`

To try CLI changes before publishing, point `example-proj-cfg` at a local tarball or use `npm link`:

```sh
cd cfg-luban/cfg-luban-cli && npm run build
cd ../../example-proj-cfg  && npm install ../cfg-luban/cfg-luban-cli
npm run build                               # triggers your local CLI
```

### Publishing

Both packages use the modern `files` whitelist + `exports` scheme — publish from the package root (no `cd dist`):

```sh
cd <pkg>
npm run build
npm publish
```

`npm pack --dry-run` shows the tarball contents before publishing.

### Repo conventions

- `**/node_modules/` and `**/dist/` are gitignored at the repo root
- Changes to either package are committed together when semantically coupled (e.g. CLI writes a new field that runtime needs to read)
- Version bumps are coordinated manually — there's no release automation
