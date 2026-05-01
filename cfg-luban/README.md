# @dogsvr/cfg-luban

Runtime library for reading Luban-generated game config (FlatBuffers + LMDB).

For the config generation pipeline (Excel → LMDB), see the sibling package [`@dogsvr/cfg-luban-cli`](../cfg-luban-cli/README.md). For this repo's overall layout and dev workflow, see the [repo README](../README.md). For how this fits into the wider framework, see [`@dogsvr/dogsvr`](https://github.com/dogsvr/dogsvr).

## Install

```sh
npm install @dogsvr/cfg-luban
```

**Node.js**: tested on **v16.15.1 on Linux (x86-64)**. Newer LTS versions (18 / 20 / 22) are expected to work but are not routinely exercised; older versions may not. File an issue if something breaks on your runtime.

## API

| Interface | Purpose |
|-----------|---------|
| `openCfgDb(options)` | Open the LMDB database and load `table_keys.json`. If `options.cfgModule` is passed (the flatc barrel), every table is auto-registered. |
| `closeCfgDb()` | Close the DB and clear all registered tables |
| `registerCfgTable(name, rootFn)` | Manually register a single table's FlatBuffers root accessor. Primary use: per-worker selective loading of large cfg, or tables that don't follow the `getRootAs<fullName>` convention. |
| `getCfgRow<T>(table, keys)` | Primary-key lookup; returns a plain object. O(log n) |
| `getCfgRowList<T>(table, keysList)` | Batch lookup on the same table (1 memcpy + N binary searches). O(N log n) |
| `getCfgRowUnsafe(table, keys)` | Primary-key lookup; returns the raw FlatBuffers accessor (no unpack). O(log n) |
| `forEachCfgRow<T>(table, cb)` | Iterate the entire table; return `false` from `cb` to stop early |

The `table` argument is always the Luban `full_name` form (e.g. `'TbItem'`), matching `table_keys.json`.

## Usage

### Worker initialization

Config paths should come from the worker thread config — don't hardcode them, so that a single build artifact can serve multiple environments. cfg-luban supports two wiring styles. Pick based on table count + per-worker coverage.

#### Style A — barrel module (recommended for small-to-medium cfg)

Minimal boilerplate. Eager-loads every flatc class in the barrel; bundler tree-shaking is defeated by the dynamic `cfgModule[fullName]` access. Fine up to ~1000 tables; beyond that each worker pays for classes it never touches.

```ts
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import { openCfgDb } from '@dogsvr/cfg-luban';
// The barrel file `ts/<topModule>.ts` is produced by cfg-luban-cli.
// Adjust the relative path to match your project layout.
import * as cfgModule from '<path-to-generated>/ts/cfg';

interface MyCfg { cfgDbPath: string; tableKeysPath: string; }

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    const cfg = dogsvr.getThreadConfig<MyCfg>();

    openCfgDb({
        dbPath: cfg.cfgDbPath,
        tableKeysPath: cfg.tableKeysPath,
        cfgModule,
    });
    // done — no registerCfgTable calls
});
```

#### Style B — per-table imports + manual `registerCfgTable` (recommended for large cfg with per-worker subsets)

Node only loads the imported table modules + their element-type dependencies. For cfg with thousands of tables where each worker role uses a clear subset, resident memory can drop 5–10× vs. Style A. The tradeoff is N lines of boilerplate and the need to keep the per-worker import list in sync with business code.

```ts
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import { openCfgDb, registerCfgTable } from '@dogsvr/cfg-luban';
// Import only the tables this worker actually queries.
import { TbReward } from '<path-to-generated>/ts/tb-reward';
import { TbSkill }  from '<path-to-generated>/ts/tb-skill';
import { TbItem }   from '<path-to-generated>/ts/tb-item';

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    const cfg = dogsvr.getThreadConfig<{ cfgDbPath: string; tableKeysPath: string }>();

    openCfgDb({ dbPath: cfg.cfgDbPath, tableKeysPath: cfg.tableKeysPath });
    registerCfgTable('TbReward', TbReward.getRootAsTbReward);
    registerCfgTable('TbSkill',  TbSkill.getRootAsTbSkill);
    registerCfgTable('TbItem',   TbItem.getRootAsTbItem);
});
```

The `dbPath` and `tableKeysPath` values come from whatever `worker_thread_config.json` the worker is launched with (see [`@dogsvr/dogsvr`](../../dogsvr/README.md) for how thread config loading works).

### Primary-key lookup

```ts
import { getCfgRow } from '@dogsvr/cfg-luban';

const reward = getCfgRow<RewardT>('TbReward', 1001);            // single key
const skill  = getCfgRow<SkillT>('TbSkill', [1001, 5]);         // composite key
const text   = getCfgRow<I18nT>('TbI18n', 'LOGIN_TITLE');       // string key
```

### Batch lookup (performance)

```ts
import { getCfgRowList } from '@dogsvr/cfg-luban';

// Same table, many keys: 1 memcpy + N binary searches (not N memcpys)
const rewards = getCfgRowList<RewardT>('TbReward', [1001, 1002, 1003]);
```

### Unsafe accessor (skip unpack)

```ts
import { getCfgRowUnsafe } from '@dogsvr/cfg-luban';

// Returns a FlatBuffers accessor; fields are read via method calls.
// ⚠️ The caller must finish using it within synchronous code — the accessor
//    becomes invalid after the next getBinaryFast.
const item = getCfgRowUnsafe('TbItem', 2001);
const damage = item?.damage();
const name   = item?.name();
```

### Iteration

```ts
import { forEachCfgRow } from '@dogsvr/cfg-luban';

// Find the first match
let found: RewardT | null = null;
forEachCfgRow<RewardT>('TbReward', (row) => {
    if (row.count > 1000) { found = row; return false; }
});

// Filter
const weapons: ItemT[] = [];
forEachCfgRow<ItemT>('TbItem', (row) => {
    if (row.type === 3) weapons.push(row);
});
```

## Migration note

LMDB keys and the `tableName` argument now use `TbXxx` (Luban `full_name`) rather than the lowercase filename stem `tbxxx`. After upgrading cfg-luban + cfg-luban-cli, rerun `npm run build` on your config package once so the regenerated LMDB matches the new keys. `registerCfgTable('tbitem', ...)` emits a one-shot warning to help catch stragglers.
