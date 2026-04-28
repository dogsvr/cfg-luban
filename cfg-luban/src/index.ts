import { ByteBuffer } from 'flatbuffers';
import { getCfgDb, getCfgTableGetters, getCfgTableRootFn } from './db';

// ---- Internal: Binary Search ----

function binarySearchSingle(table: any, key: number | string, getter: string): any | null {
    let lo = 0, hi = table.dataListLength() - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const item = table.dataList(mid);
        if (!item) break;
        const val = item[getter]();
        if (val === key) return item;
        if (val < key) lo = mid + 1;
        else hi = mid - 1;
    }
    return null;
}

function binarySearchComposite(
    table: any,
    keys: (number | string)[],
    getters: string[]
): any | null {
    let lo = 0, hi = table.dataListLength() - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const item = table.dataList(mid);
        if (!item) break;
        let cmp = 0;
        for (let i = 0; i < keys.length; i++) {
            const val = item[getters[i]]();
            if (val < keys[i]) { cmp = -1; break; }
            if (val > keys[i]) { cmp = 1; break; }
        }
        if (cmp === 0) return item;
        if (cmp < 0) lo = mid + 1;
        else hi = mid - 1;
    }
    return null;
}

// ---- Public API ----

/**
 * Look up a single row by primary key and return an unpack()'d plain object.
 * Single key:    getCfgRow<RewardT>('TbReward', 1001)
 * Composite key: getCfgRow<SkillT>('TbSkill', [1001, 5])
 */
export function getCfgRow<T>(
    tableName: string,
    keys: number | string | (number | string)[]
): T | null {
    const db = getCfgDb();
    const rootFn = getCfgTableRootFn(tableName);
    const getters = getCfgTableGetters(tableName);
    const raw = db.getBinaryFast(tableName);
    if (!raw) return null;
    const table = rootFn(new ByteBuffer(raw));
    if (table.dataListLength() === 0) return null;

    // Single-key fast path (zero array allocation)
    if (!Array.isArray(keys)) {
        const item = binarySearchSingle(table, keys, getters[0]);
        return item ? item.unpack() as T : null;
    }
    const item = binarySearchComposite(table, keys, getters);
    return item ? item.unpack() as T : null;
}

/**
 * Batch primary-key lookup against the same table. 1× getBinaryFast (1× memcpy) + N× binary search.
 * Performance-oriented: avoids N full-table memcpys when looking up many rows in the same table.
 */
export function getCfgRowList<T>(
    tableName: string,
    keysList: (number | string | (number | string)[])[]
): (T | null)[] {
    const db = getCfgDb();
    const rootFn = getCfgTableRootFn(tableName);
    const getters = getCfgTableGetters(tableName);
    const raw = db.getBinaryFast(tableName);
    if (!raw) return keysList.map(() => null);
    const table = rootFn(new ByteBuffer(raw));
    if (table.dataListLength() === 0) return keysList.map(() => null);

    return keysList.map(keys => {
        if (!Array.isArray(keys)) {
            const item = binarySearchSingle(table, keys, getters[0]);
            return item ? item.unpack() as T : null;
        }
        const item = binarySearchComposite(table, keys, getters);
        return item ? item.unpack() as T : null;
    });
}

/**
 * Look up a single row by primary key and return the raw FlatBuffers accessor (no unpack).
 * ⚠️ Caller must finish using it within the current sync turn — the accessor is invalidated
 *    by the next getBinaryFast call.
 * Use on performance-sensitive paths where only a few fields are read and full-row unpack
 * would be wasted. Fields on the accessor are method calls: item.name(), item.damage().
 */
export function getCfgRowUnsafe(
    tableName: string,
    keys: number | string | (number | string)[]
): any | null {
    const db = getCfgDb();
    const rootFn = getCfgTableRootFn(tableName);
    const getters = getCfgTableGetters(tableName);
    const raw = db.getBinaryFast(tableName);
    if (!raw) return null;
    const table = rootFn(new ByteBuffer(raw));
    if (table.dataListLength() === 0) return null;

    if (!Array.isArray(keys)) {
        return binarySearchSingle(table, keys, getters[0]);
    }
    return binarySearchComposite(table, keys, getters);
}

/**
 * Iterate every row in the table. Return false from the callback to stop early.
 * Patterns:
 * - Find first match: forEachCfgRow('TbReward', (row) => { if (...) { found = row; return false; } })
 * - Filter multiple:  forEachCfgRow('TbItem',   (row) => { if (row.type === 3) results.push(row); })
 * - Full scan:        forEachCfgRow('TbItem',   (row) => { ... })
 */
export function forEachCfgRow<T>(
    tableName: string,
    callback: (row: T, index: number) => void | boolean
): void {
    const db = getCfgDb();
    const rootFn = getCfgTableRootFn(tableName);
    const raw = db.getBinaryFast(tableName);
    if (!raw) return;
    const table = rootFn(new ByteBuffer(raw));
    for (let i = 0; i < table.dataListLength(); i++) {
        const item = table.dataList(i);
        if (!item) continue;
        if (callback(item.unpack() as T, i) === false) break;
    }
}

// ---- Re-exports ----

export { openCfgDb, closeCfgDb, registerCfgTable } from './db';
export { CfgLubanOptions, CfgTableKeysConfig, CfgTableKeyInfo, CfgRootFn } from './types';
