# @dogsvr/cfg-luban

Runtime library for reading Luban-generated game config (FlatBuffers + LMDB).

For the config generation pipeline (Excel → LMDB), see the sibling package [`@dogsvr/cfg-luban-cli`](../cfg-luban-cli/README.md).

## Install

```sh
npm install @dogsvr/cfg-luban
```

## API

| Interface | Purpose |
|-----------|---------|
| `openCfgDb(options)` | Open the LMDB database and load `table_keys.json` |
| `closeCfgDb()` | Close the DB and clear all registered tables |
| `registerCfgTable(name, rootFn)` | Register a table's FlatBuffers root accessor |
| `getCfgRow<T>(table, keys)` | Primary-key lookup; returns a plain object. O(log n) |
| `getCfgRowList<T>(table, keysList)` | Batch lookup on the same table (1 memcpy + N binary searches). O(N log n) |
| `getCfgRowUnsafe(table, keys)` | Primary-key lookup; returns the raw FlatBuffers accessor (no unpack). O(log n) |
| `forEachCfgRow<T>(table, cb)` | Iterate the entire table; return `false` from `cb` to stop early |

## Usage

### Worker initialization

Config paths should come from the worker thread config — don't hardcode them, so that a single build artifact can serve multiple environments:

```ts
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import { openCfgDb, registerCfgTable } from '@dogsvr/cfg-luban';
// Accessor imports come from the TypeScript output of cfg-luban-cli.
// Adjust the relative path to match your project layout.
import { TbReward } from '<path-to-generated>/ts/tb-reward';
import { TbSkill }  from '<path-to-generated>/ts/tb-skill';
import { TbItem }   from '<path-to-generated>/ts/tb-item';

interface MyCfg { cfgDbPath: string; tableKeysPath: string; }

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    const cfg = dogsvr.getThreadConfig<MyCfg>();

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
