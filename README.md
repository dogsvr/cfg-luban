# @dogsvr/cfg-luban

Luban + FlatBuffers + LMDB game config module for dogsvr.

## Build Pipeline (gen.sh)

One-click build script: Excel → LMDB database.

### Prerequisites

| Dependency | Location | How to obtain |
|-----------|----------|---------------|
| Luban | `tools/luban/` | Download from [luban releases](https://github.com/focus-creative-games/luban/releases) |
| flatc | `tools/flatc` | Download from [FlatBuffers releases](https://github.com/google/flatbuffers/releases) (>= 23.x) |
| .NET Runtime | System PATH | Required by Luban (`dotnet Luban.dll`) |
| Node.js deps | `node_modules/` | `npm install` (flatbuffers, lmdb, tsx) |

### Directory Structure

```
cfg-luban/
├── excel/              ← Designer-edited Excel files (git tracked)
├── luban/
│   ├── luban.conf      ← Luban project config
│   └── custom_templates/flatbuffers/
│       └── table_keys.sbn   ← Custom template for table_keys.json
├── tools/              ← Third-party binaries (gitignored)
│   ├── luban/          ← Luban release
│   └── flatc           ← flatc binary
└── gen_output/         ← All generated artifacts (gitignored)
    ├── fbs/            ← .fbs schema files
    ├── json/           ← JSON data (sorted by primary keys)
    ├── bin/            ← FlatBuffers binary files
    ├── ts/             ← TypeScript code (with XxxT classes + unpack())
    ├── table_keys.json ← Primary key metadata per table
    └── db/             ← LMDB database (data.mdb + lock.mdb)
```

### Running

```bash
# Install Node.js dependencies (first time only)
npm install

# Run full build pipeline
./gen.sh
```

### Pipeline Steps

| Step | Tool | Input | Output |
|------|------|-------|--------|
| 1 | Luban | `excel/*.xlsx` | `gen_output/fbs/`, `gen_output/json/`, `gen_output/table_keys.json` |
| 2 | sort_json.ts | `table_keys.json` + `json/*.json` | `json/*.json` (sorted in-place) |
| 3 | flatc | `fbs/*.fbs` + sorted `json/*.json` | `gen_output/bin/`, `gen_output/ts/` |
| 4 | importer.ts | `bin/*.bin` | `gen_output/db/` (LMDB) |

### Configuration

Edit the top of `gen.sh` to customize paths:

```bash
LUBAN_DLL="tools/luban/Luban.dll"
FLATC="tools/flatc"
EXCEL_DIR="excel"
OUTPUT_DIR="gen_output"
CUSTOM_TEMPLATE_DIR="luban/custom_templates"
```

## API

| Interface | Purpose |
|-----------|---------|
| `openCfgDb(options)` | Open LMDB config database and load table_keys.json |
| `closeCfgDb()` | Close database and clear all registrations |
| `registerCfgTable(name, rootFn)` | Register a table's FlatBuffers root accessor |
| `getCfgRow<T>(table, keys)` | Look up a single row by primary key, returns plain object, O(log n) |
| `getCfgRowList<T>(table, keysList)` | Batch primary key lookup on same table (1 memcpy + N binary searches), O(N log n) |
| `getCfgRowUnsafe(table, keys)` | Look up by primary key, returns FlatBuffers accessor (no unpack), O(log n) |
| `forEachCfgRow<T>(table, callback)` | Iterate entire table, callback returns false to break early |

## Usage

### Worker Initialization

```ts
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';
import { openCfgDb, registerCfgTable } from '@dogsvr/cfg-luban';
import { TbReward } from '../gen_output/ts/tb-reward';
import { TbSkill } from '../gen_output/ts/tb-skill';
import { TbItem } from '../gen_output/ts/tb-item';

dogsvr.workerReady(async () => {
    dogsvr.loadWorkerThreadConfig();
    const cfg = dogsvr.getThreadConfig<MyConfig>();

    openCfgDb({ dbPath: cfg.cfgDbPath, tableKeysPath: cfg.tableKeysPath });
    registerCfgTable('TbReward', TbReward.getRootAsTbReward);
    registerCfgTable('TbSkill', TbSkill.getRootAsTbSkill);
    registerCfgTable('TbItem', TbItem.getRootAsTbItem);
});
```

### Lookup by Primary Key

```ts
import { getCfgRow } from '@dogsvr/cfg-luban';
import { RewardT } from '../gen_output/ts/tb-reward';
import { SkillT } from '../gen_output/ts/tb-skill';

// Single primary key
const reward = getCfgRow<RewardT>('TbReward', 1001);

// Composite primary key
const skill = getCfgRow<SkillT>('TbSkill', [1001, 5]);

// String type primary key
const text = getCfgRow<I18nT>('TbI18n', 'LOGIN_TITLE');
```

### Batch Lookup (Performance)

```ts
import { getCfgRowList } from '@dogsvr/cfg-luban';
import { RewardT } from '../gen_output/ts/tb-reward';

// Same table, multiple keys: 1 memcpy + N binary searches (instead of N memcpys)
const rewards = getCfgRowList<RewardT>('TbReward', [1001, 1002, 1003]);
```

### High-Performance Accessor (No Unpack)

```ts
import { getCfgRowUnsafe } from '@dogsvr/cfg-luban';

// Returns FlatBuffers accessor, fields accessed via method calls
// ⚠️ Caller must finish using it within synchronous code (accessor invalidated after next getBinaryFast)
const item = getCfgRowUnsafe('TbItem', 2001);
const damage = item?.damage();
const name = item?.name();
```

### Iteration

```ts
import { forEachCfgRow } from '@dogsvr/cfg-luban';
import { RewardT } from '../gen_output/ts/tb-reward';
import { ItemT } from '../gen_output/ts/tb-item';

// Find first match
let found: RewardT | null = null;
forEachCfgRow<RewardT>('TbReward', (row) => {
    if (row.count > 1000) { found = row; return false; }
});

// Filter by condition
const weapons: ItemT[] = [];
forEachCfgRow<ItemT>('TbItem', (row) => {
    if (row.type === 3) weapons.push(row);
});

// Full table traversal
forEachCfgRow<ItemT>('TbItem', (row, index) => {
    console.log(index, row.name);
});
```
