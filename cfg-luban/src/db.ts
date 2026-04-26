import { open, Database } from 'lmdb';
import * as fs from 'node:fs';
import { CfgLubanOptions, CfgTableKeysConfig, CfgRootFn } from './types';

let cfgDb: Database | null = null;
let cfgTableGettersMap: Map<string, string[]> = new Map();
let cfgTableRootFnMap: Map<string, CfgRootFn> = new Map();

function snakeToCamel(s: string): string {
    return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Open LMDB config database and load table key metadata.
 * Call once at worker init (inside workerReady callback).
 */
export function openCfgDb(options: CfgLubanOptions): void {
    if (cfgDb) {
        throw new Error('CfgDb already opened. Call closeCfgDb() first if re-opening.');
    }

    cfgDb = open({
        path: options.dbPath,
        readOnly: true,
        maxReaders: options.maxReaders ?? 512,
        mapSize: options.mapSize ?? 4 * 1024 * 1024 * 1024,
    }) as unknown as Database;

    // Load table_keys.json and build getters map
    const raw = fs.readFileSync(options.tableKeysPath, 'utf-8');
    const tableKeys: CfgTableKeysConfig = JSON.parse(raw);

    cfgTableGettersMap.clear();
    for (const [tableName, info] of Object.entries(tableKeys)) {
        const getters = info.keys.map(k => snakeToCamel(k));
        cfgTableGettersMap.set(tableName, getters);
    }
}

/**
 * Register a table's FlatBuffers root accessor function.
 * Must be called after openCfgDb(), before using getCfgRow etc.
 */
export function registerCfgTable(tableName: string, rootFn: CfgRootFn): void {
    cfgTableRootFnMap.set(tableName, rootFn);
}

/** Get the opened LMDB database instance. Throws if not opened. */
export function getCfgDb(): Database {
    if (!cfgDb) throw new Error('CfgDb not opened. Call openCfgDb() first.');
    return cfgDb;
}

/** Get camelCase getter names for a table's primary key fields. */
export function getCfgTableGetters(tableName: string): string[] {
    const getters = cfgTableGettersMap.get(tableName);
    if (!getters) throw new Error(`Table "${tableName}" not found in table_keys.json.`);
    return getters;
}

/** Get the registered root accessor function for a table. */
export function getCfgTableRootFn(tableName: string): CfgRootFn {
    const rootFn = cfgTableRootFnMap.get(tableName);
    if (!rootFn) throw new Error(`Table "${tableName}" not registered. Call registerCfgTable() first.`);
    return rootFn;
}

/** Close the LMDB config database and clear all registrations. */
export function closeCfgDb(): void {
    if (cfgDb) {
        cfgDb.close();
        cfgDb = null;
    }
    cfgTableGettersMap.clear();
    cfgTableRootFnMap.clear();
}
