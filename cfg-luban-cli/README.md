# @dogsvr/cfg-luban-cli

Codegen CLI for [`@dogsvr/cfg-luban`](../cfg-luban/README.md): compiles designer Excel sheets into a read-only LMDB config database via Luban + FlatBuffers.

For this repo's overall layout, see the [repo README](../README.md). For how this fits into the wider framework, see [`@dogsvr/dogsvr`](https://github.com/dogsvr/dogsvr); for a working consumer, see [`example-proj-cfg`](../../example-proj-cfg).

## Install

```sh
npm install --save-dev @dogsvr/cfg-luban-cli
```

## Prerequisites

The CLI orchestrates external tools rather than vendoring them — you supply paths to `Luban.dll` and `flatc` on every invocation via `--luban-dll` / `--flatc` flags (or `LUBAN_DLL` / `FLATC` env vars). Keeping these as caller-supplied paths means:

- Same CLI works across dev machines, CI, container images — each environment points at whatever location its tools live in
- No vendored native binaries in `node_modules`
- Tool version bumps are a flag change, not a CLI release

Required tools:

| Tool | Notes |
|---|---|
| **Luban** (`Luban.dll`) | Managed by `dotnet` — cross-platform, works anywhere you have `dotnet` runtime. [Releases](https://github.com/focus-creative-games/luban/releases) |
| **flatc** (≥ 23.x) | Native binary — OS/arch specific. `flatc.exe` on Windows, Mach-O on macOS, ELF on Linux. [Releases](https://github.com/google/flatbuffers/releases) |
| **dotnet runtime** | For running Luban.dll. `apt install dotnet-runtime-8.0` / `brew install dotnet` / etc. |
| **python3 + openpyxl** | Used by `extract-keys` to read `__tables__.xlsx`. `pip install openpyxl` |
| **Node.js** | Tested on **v16.15.1 on Linux (x86-64)**. Newer LTS versions (18 / 20 / 22) are expected to work but are not routinely exercised; older versions may not. File an issue if something breaks on your runtime. |

## Usage

### Full pipeline

```sh
npx cfg-luban-cli build \
  --luban-dll /opt/luban/Luban.dll \
  --flatc     /opt/flatc \
  --designer  ./designer_cfg \
  --output    ./generated \
  --target    all           # optional, defaults to "all"
```

Produces under `--output`:

```
generated/
├── fbs/             # .fbs schema
├── json/            # JSON data (sorted by primary keys)
├── bin/             # per-table FlatBuffers binaries
├── ts/              # TypeScript accessors (emitted by flatc)
├── table_keys.json  # primary-key metadata per table
└── db/              # LMDB (data.mdb + lock.mdb)
```

The runtime ([`@dogsvr/cfg-luban`](../cfg-luban/README.md)) consumes `db/` and `table_keys.json` at process start, and the TypeScript accessors under `ts/` when registering each table.

### Single steps

Useful for CI debugging or partial re-runs:

```sh
npx cfg-luban-cli extract-keys \
  --tables-xlsx ./designer_cfg/Datas/__tables__.xlsx \
  --out         ./generated/table_keys.json

npx cfg-luban-cli sort-json \
  --keys     ./generated/table_keys.json \
  --json-dir ./generated/json

npx cfg-luban-cli import-lmdb \
  --bin-dir ./generated/bin \
  --db-dir  ./generated/db
```

### Pipeline stages

| Stage | Tool | Input → Output |
|---|---|---|
| 1. `run-luban` | `dotnet Luban.dll` | `designer_cfg/*.xlsx` → `fbs/schema.fbs` + `json/*.json` |
| 1.5. `extract-keys` | `python3` + `openpyxl` | `__tables__.xlsx` → `table_keys.json` |
| 2. `sort-json` | — | `json/*.json` sorted in place by primary key (required for binary-search lookup at runtime) |
| 3. `run-flatc` | `flatc` | `schema.fbs` + sorted JSON → `bin/*.bin` + `ts/` |
| 4. `import-lmdb` | `lmdb` | `bin/*.bin` → `db/data.mdb` |

### Environment variable fallback

When a required flag is missing, the CLI falls back to these env vars: `LUBAN_DLL`, `FLATC`, `DESIGNER_DIR`, `OUTPUT_DIR`. CLI flags always win.

## Bundled `templates/`

The package ships a `templates/` directory (whitelisted via `files` in `package.json`):

```
@dogsvr/cfg-luban-cli/
└── templates/
    └── flatbuffers/
        └── schema.sbn
```

`schema.sbn` is a [Scriban](https://github.com/scriban/scriban) template consumed by Luban as a **custom code template** (passed via `--customTemplateDir`). `--customTemplateDir` has **replace** semantics, not merge — when we supply a `flatbuffers/schema.sbn`, it wholesale replaces Luban's stock template. Most of our file therefore just reproduces the stock behavior; the two lines that actually differ from stock are:

- **No per-table `root_type`**. FlatBuffers only honors the *last* `root_type` in a schema — multiple tables would silently shadow each other. Luban's stock template emits one, so our replacement omits it. Instead, `run-flatc` passes `--root-type cfg.Tb<X>` to `flatc` on every per-table binary compile.
- **Single `file_identifier "CFGL"`** stamped into every `.bin`, used only as a sanity magic (per-table uniqueness is enforced by filename + schema, not magic).

Everything else — the `enum` / `union` / `table` / `KeyValue_*` / `Tb<X> { data_list: [<X>] }` sections — is a **faithful reproduction of Luban's native output**. In particular:

- Each table is wrapped as `Tb<X> { data_list: [<X>] }` not because we invented that shape, but because `FlatBuffersJsonExporter` (Luban's JSON emitter) **hardcodes** the field name `data_list`. Luban's JSON output for every table is `{ "data_list": [...] }`. If our `.fbs` didn't declare a matching `Tb<X>.data_list`, flatc would fail to compile the JSON.
- We have to keep this section in the custom template purely because of the replace semantics — omit it, and the wrapping disappears from `.fbs` while Luban still emits JSON expecting it.

The `// WARN! The name 'data_list' is used by FlatBuffersJsonExporter. don't modify it!` comment in the template exists to remind future editors of exactly this constraint.

### How it's wired at runtime

`run-luban` resolves the template dir relative to the installed package root:

```ts
// src/pipeline.ts
const customTemplateDir = path.resolve(__dirname, '..', 'templates');
// dist/pipeline.js  -> <pkg>/templates   (published layout)
// src/pipeline.ts   -> <pkg>/templates   (local dev layout)
```

Consumers **never** configure the template path — it's implementation detail. If you need to change the schema shape, edit `templates/flatbuffers/schema.sbn` in this repo and rebuild, rather than forking at the consumer.

### Adding more templates

To override additional Luban target templates, add files under `templates/<target>/<name>.sbn`. The whole `templates/` tree is passed as `--customTemplateDir` to Luban, which matches by `<target>/<name>` convention against its stock templates.
