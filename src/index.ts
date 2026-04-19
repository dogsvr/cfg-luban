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
 * 按主键查找单行，返回 unpack() plain object。
 * 单主键: getCfgRow<RewardT>('TbReward', 1001)
 * 联合主键: getCfgRow<SkillT>('TbSkill', [1001, 5])
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

    // 单 key 快速路径（零数组分配）
    if (!Array.isArray(keys)) {
        const item = binarySearchSingle(table, keys, getters[0]);
        return item ? item.unpack() as T : null;
    }
    const item = binarySearchComposite(table, keys, getters);
    return item ? item.unpack() as T : null;
}

/**
 * 同表批量主键查找。1次 getBinaryFast（1次 memcpy）+ N次二分。
 * 性能版：避免同表多次查找时的 N次整表 memcpy。
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
 * 按主键查找单行，返回 FlatBuffers accessor（不调用 unpack）。
 * ⚠️ 调用方承诺在同步代码内使用完毕（下次 getBinaryFast 后 accessor 失效）。
 * 适用于性能敏感路径：只需读取少量字段时避免全字段 unpack 开销。
 * accessor 上的字段是方法调用: item.name(), item.damage()
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
 * 遍历整张表。callback 返回 false 可提前终止。
 * 用法：
 * - 查找首个匹配: forEachCfgRow('TbReward', (row) => { if (...) { found = row; return false; } })
 * - 筛选多行: forEachCfgRow('TbItem', (row) => { if (row.type === 3) results.push(row); })
 * - 全表遍历: forEachCfgRow('TbItem', (row) => { ... })
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
