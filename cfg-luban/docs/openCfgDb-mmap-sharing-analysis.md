# `openCfgDb` internals: mmap loading and cross-process / cross-thread sharing

A precise code audit of `openCfgDb` in `@dogsvr/cfg-luban`, verifying that across multiple processes (`dir` / `zonesvr` / `battlesvr`) and multiple `worker_thread`s it really does load config via mmap and share physical memory between processes and threads.

Conclusion: **yes, and optimally so.** Every point below lines up with the source.

---

## 1. What `openCfgDb` actually passes to lmdb

`cfg-luban/src/db.ts:22-27`:

```ts
cfgDb = open({
    path: options.dbPath,
    readOnly: true,
    maxReaders: options.maxReaders ?? 512,
    mapSize: options.mapSize ?? 4 * 1024 * 1024 * 1024,
});
```

Cross-referenced against `node_modules/lmdb/open.js:176-189` (flag assembly) and `:105-106` (`overlappingSync` derivation):

| Input | Resulting LMDB flag / behavior | Effect |
|---|---|---|
| `readOnly: true` | `MDB_RDONLY (0x20000)` | Env opened read-only; any `put`/`del` returns EACCES |
| `maxReaders: 512` | `mdb_env_set_maxreaders(512)` | Reader lock table holds at most 512 concurrent read slots |
| `mapSize: 4GB` | `mdb_env_set_mapsize` | Upper bound on address-space mapping |
| `useWritemap` not passed | `MDB_WRITEMAP` **not** set | Irrelevant in read-only mode (`readOnly` also forces it off); OK |
| `noReadAhead` not passed | Kernel readahead enabled | Friendly to full-table blob reads and sequential scans |
| `noSubdir` not passed | `path` has no extension, so `Boolean(extension) = false` | Directory layout: `data.mdb` + `lock.mdb` |
| `overlappingSync` default | `readOnly=true` forces it off at `open.js:105` | Read-only mode doesn't need overlapping sync |

---

## 2. mmap — yes, and it's LMDB's only loading mode

**LMDB's data access is mmap-only; it's not an "option."** `mdb_env_open()` unconditionally calls:

```
mmap(fd, mapSize, PROT_READ[|PROT_WRITE], MAP_SHARED, ...)
```

There is no API to turn mmap off — LMDB's entire B+Tree is pointer-dereferenced directly onto the mmap region.

With `readOnly:true`, the mapping is `PROT_READ | MAP_SHARED` (no `PROT_WRITE`), which means:

- Physical pages are **managed by the OS page cache**
- They do **not** count against the process's anonymous RSS
- Pages of the same inode touched by multiple processes **physically share one page-cache copy**

---

## 3. Cross-process sharing — yes

This is LMDB's core design. Mapped onto `example-proj`'s deployment:

- `dir`, `zonesvr`, `battlesvr` each call `openCfgDb(...)` and each trigger `mmap(data.mdb, MAP_SHARED)`
- The kernel keys the page cache by inode; all three processes' VMAs point at **the same physical pages**
- A 4 GB config set **does not** balloon to 12 GB RSS across the three
- `lock.mdb` is the reader table (`maxReaders=512` sets its size) and is coordinated across processes via POSIX file locks + inter-process mutex — cross-process safe
- The only writer is `@dogsvr/cfg-luban-cli` (one-shot ingest at codegen time); **it's not a runtime actor**
- All runtime processes open `readOnly:true`, so there is no write contention

The only theoretical risk is "multiple processes holding read-only readers while another process does a fork-on-write" — but this project has no runtime writers, so the scenario doesn't exist.

---

## 4. Cross-`worker_thread` sharing — yes, with one code-level constraint

Node `worker_thread`s are independent V8 isolates, but they **share the same process address space** and a single loaded `.node` native addon.

- Each worker **must call `openCfgDb()` independently**:
  - The module-level variables in `db.ts:5-7` (`cfgDb` / `cfgTableGettersMap` / `cfgTableRootFnMap`) are per-isolate
  - Without an `openCfgDb` call in the worker, they remain `null`, and `getCfgDb()` throws `"CfgDb not opened. Call openCfgDb() first."`
- But the **underlying `mmap` only happens once**:
  - The lmdb addon caches `MDB_env*` internally by path
  - Multiple `open()` calls on the same path within one process reuse the same `MDB_env` instance
  - So N workers all calling `open()` result in exactly **1** `mmap()` syscall
  - Each worker's read transaction takes its own `lock.mdb` reader slot
- `maxReaders: 512` is far more than enough for "`workerThreadNum` + a handful of txns" (this project typically runs in single digits to low tens)

Current code convention: "call `openCfgDb` inside the `workerReady` callback" — this is consistent with the semantics above.

---

## 5. A "pseudo zero-copy" caveat worth knowing

Not every `getBinaryFast` return is an mmap view. See `node_modules/lmdb/read.js:87-134`:

| Case | Path | Copy behavior |
|---|---|---|
| Small value (fits in the preallocated reusable `getValueBytes` buffer) | Native-side `memcpy` once into the reusable buffer | 1 JS-side memory copy |
| Large value / spans overflow pages (`rc == -30001`) | Uses `getMMapBuffer` / `getSharedBuffer`; JS receives a `Uint8Array` viewed directly over the mmap region | **Zero copy** |

Threshold: `NEW_BUFFER_THRESHOLD = 0x8000` = **32 KB** (`read.js:43`).

For cfg-luban concretely:

- Each LMDB entry is **the FlatBuffers binary of an entire Tb table** (`import-lmdb` works at table granularity)
- Non-trivial tables (items, skills, monsters, …) are well over 32 KB and hit the **zero-copy mmap path**
- Only very small tables (e.g. a few global-constant tables) fall onto the memcpy path

Even for small tables that go through memcpy:

- Disk I/O is still 0 (mmap hits the page cache)
- There's just one extra JS-side `memcpy(size)` into the reusable buffer
- **Cross-process / cross-thread page-cache sharing is unaffected**

---

## 6. Conclusion

- ✅ **mmap loading**: yes, and it cannot be disabled. With `readOnly:true` the mapping is `PROT_READ | MAP_SHARED`
- ✅ **Cross-process sharing**: yes, physical sharing at the OS page cache level — three server processes loading 4 GB of config do *not* become 12 GB RSS
- ✅ **Cross-`worker_thread` sharing**: yes — within one addon the `MDB_env` is singleton-per-path and `mmap()` fires exactly once
- ⚠️ **Constraint**: each worker needs its own `openCfgDb()` to initialize JS-side state (already the case — called inside `workerReady`)
- ⚠️ **Note**: `getBinaryFast` memcpys values < 32 KB into a reusable buffer once — irrelevant for "whole-table" blobs, a single JS-side copy for very small tables, and neither changes disk / page-cache sharing semantics

`openCfgDb`'s current parameter set is **correct and optimal** for the goal: *"multi-process + multi-`worker_thread` read-only shared config."*

---

## Appendix A: relevant source locations

| File | Key lines | Notes |
|---|---|---|
| `cfg-luban/src/db.ts` | 22-27 | `open(...)` call site |
| `cfg-luban/src/db.ts` | 5-7 | Module-level singleton state (per-isolate) |
| `node_modules/lmdb/open.js` | 105-106 | `readOnly` forces `overlappingSync` off |
| `node_modules/lmdb/open.js` | 176-189 | LMDB flags bitmap assembly |
| `node_modules/lmdb/read.js` | 43 | `NEW_BUFFER_THRESHOLD = 0x8000` |
| `node_modules/lmdb/read.js` | 87-134 | `getBinaryFast` path split (memcpy vs mmap view) |
| `node_modules/lmdb/read.js` | 1013-1015 | `getSharedBuffer` — mmap view cache keyed by `bufferId` |

---

## 7. Clarifying `maxReaders` vs. LMDB transactions (txn)

### 7.1 What a txn is

The **txn** limited by `maxReaders: 512` is the LMDB **read transaction**.

Key facts:

- `maxReaders` does **not** limit threads, processes, or envs —
  it limits **how many read transactions are simultaneously active and holding a slot in `lock.mdb`**
- Rules:
  - Each active read txn occupies **1** slot
  - The slot is released on `mdb_txn_commit()` / `mdb_txn_abort()` / `mdb_txn_reset()`
  - After a reset, the slot can be **reused** via `mdb_txn_renew()` (no new slot)

### 7.2 The `lmdb` npm package's "reusable read txn" wrapper

See `node_modules/lmdb/read.js:52-86`:

```js
let readTxn, readTxnRenewed;
// inside getBinaryFast:
let txn = env.writeTxn
    || (options && options.transaction)
    || (readTxnRenewed ? readTxn : renewReadTxn(this));
```

Wrapper behavior:

1. Each **LMDBStore instance per worker** holds **one** `readTxn`
2. The first `get` calls `renewReadTxn` and claims 1 slot
3. Subsequent `get`s reuse the same txn — **no extra slots**
4. On the next event turn / after a write txn, it resets; the next `get` renews into the same slot

**Conclusion**: "one worker reading normally = 1 reader slot held." That's the origin of "a handful of txns."

### 7.3 Other sources of slot consumption

For cfg-luban's purely read-only workload, the scenarios that could take extra slots:

| Scenario | Extra slot? |
|---|---|
| Same worker calling `getCfgRow` in a loop | No — reuses the renewed txn |
| N `worker_thread`s each calling `openCfgDb` | Yes — N slots (1 per worker) |
| 3 processes (`dir` / `zonesvr` / `battlesvr`) | Yes — `3 × (workerThreadNum + 1 main thread)` slots |
| Caller explicitly passes `options.transaction` | Yes — +1 per such call |
| Async `getAsync` / `getBFAsync` reads in flight | Temporarily +1 (`txn.refCount++`, `read.js:141`) |
| Main worker happens to be in flush/reset mid-read | Briefly may be 2 |

### 7.4 Order-of-magnitude estimate

Assume the project's upper-bound scale:

- 3 server processes
- `workerThreadNum: 16` per process (already generous)
- Each worker: 1 resident readTxn + 1-2 occasional transient txns

Peak ≈ `3 × 16 × 3` ≈ **144 slots**

The default `maxReaders: 512` leaves roughly a **3.5×** headroom. The workloads that can actually exhaust 512 are things like "cross-machine replica readers + thousands of local connections each opening explicit txns" — cfg-luban has none of that.

---

## 8. Does the current cfg-luban implementation use transactions?

### 8.1 Explicit transactions: 0

Grepping under `cfg-luban/src/`:

```
grep -rn "transaction\|txn\|beginTxn\|childTransaction\|transactionSync\|transactionAsync" src/
```

**Zero matches.** No transaction API is called anywhere in cfg-luban's source.

### 8.2 Implicit transactions: every `get` runs inside one, invisibly

That does not mean "no transactions" — **every LMDB `get` must be inside a read transaction at the C level**, and that's a hard LMDB rule. The `lmdb` npm package just hides it from the caller.

All four query APIs in `cfg-luban/src/index.ts` (`getCfgRow` / `getCfgRowList` / `getCfgRowUnsafe` / `forEachCfgRow`) reach only a single LMDB method:

```ts
const raw = db.getBinaryFast(tableName);
```

Which expands to `node_modules/lmdb/read.js:81-92`:

```js
getBinaryFast(id, options) {
    let rc;
    let txn = env.writeTxn
        || (options && options.transaction)
        || (readTxnRenewed ? readTxn : renewReadTxn(this));  // ← the only branch we hit
    rc = this.lastSize = getByBinary(
        this.dbAddress,
        this.writeKey(id, keyBytes, 0),
        (options && options.ifNotTxnId) || 0,
        txn.address || 0,
    );
    ...
}
```

How the three branches land in cfg-luban's world:

| Branch | Trigger | cfg-luban |
|---|---|---|
| `env.writeTxn` | The worker is inside a write txn | ❌ Read-only — there is never a writeTxn |
| `options.transaction` | Caller explicitly passed a txn | ❌ The cfg-luban API never exposes this parameter |
| `renewReadTxn(this)` | Neither of the above | ✅ **The only branch that ever fires** |

### 8.3 Full `renewReadTxn` lifecycle

Each LMDBStore (i.e. the `cfgDb` returned by `open()` in a worker) maintains a **resident `readTxn`**:

- First `get` → `mdb_txn_begin(RDONLY)`, claims 1 `lock.mdb` reader slot
- Subsequent `get`s in the same worker → reuse `readTxn`; **no new slot**
- Next event turn auto-runs `mdb_txn_reset()`; the next `get` does `mdb_txn_renew()` (same slot)
- The slot is truly released with `mdb_txn_abort()` only when the worker exits (process teardown) or `closeCfgDb()` is called explicitly

### 8.4 Practical impact on cfg-luban

- **Zero** explicit transaction calls in cfg-luban source
- Each worker's LMDBStore holds **1** resident implicit read txn at runtime
- No matter how many times or how often that worker calls `getCfgRow`, it still occupies **just 1 reader slot**
- There is no "many gets → slot exhaustion" failure mode

### 8.5 Corollary

The "a handful of txns" phrasing from §7 **is not produced by cfg-luban itself** — it is the baseline set by the `lmdb` package's internal machinery:

> 1 worker ≈ 1 slot (resident readTxn); very occasional +1 (reset/renew boundary on event turns, or the refCount bump for async reads).

cfg-luban's code **fully hides** this from the caller — there is no transaction concept at the business layer. That's the right design: a read-only config lookup API has no reason to expose txn semantics.

---

## Appendix B: source locations referenced by §7–8

| File | Key lines | Notes |
|---|---|---|
| `cfg-luban/src/index.ts` | 57, 82, 110, 134 | The single LMDB entry point from each of the 4 query APIs: `db.getBinaryFast(tableName)` |
| `node_modules/lmdb/read.js` | 52-55 | `readTxn` / `readTxnRenewed` closure-variable declarations |
| `node_modules/lmdb/read.js` | 81-92 | `getBinaryFast`'s three-way txn selection |
| `node_modules/lmdb/read.js` | 86 | `renewReadTxn(this)` — the reset/renew reuse point for the resident readTxn |
| `node_modules/lmdb/read.js` | 141 | Async read `txn.refCount++` — the source of the transient extra slot |
