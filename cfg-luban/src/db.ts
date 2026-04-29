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
 *
 * If `options.cfgModule` is passed (typically `import * as cfgModule from
 * '<pkg>/dist/ts/cfg'`), every table in table_keys.json is auto-registered
 * by looking up `cfgModule[fullName].getRootAs<fullName>`. Otherwise the
 * caller must invoke registerCfgTable() for each table it intends to query.
 *
 * Failure modes (all synchronous, throw on fatal):
 *   - lmdb open error (bad path, permission, corrupt mdb)
 *   - table_keys.json missing / unreadable / invalid JSON
 *   - table_keys.json entry missing required fields (full_name, keys)
 *   - cfgModule provided but every table misses (likely wrong import path)
 * Partial misses (cfgModule has some but not all tables) emit a warn and
 * continue — legitimate for Style B-ish setups where a worker only uses a
 * subset of tables.
 */
export function openCfgDb(options: CfgLubanOptions): void {
    if (cfgDb) {
        throw new Error('CfgDb already opened. Call closeCfgDb() first if re-opening.');
    }

    cfgDb = open({
        path: options.dbPath,
        readOnly: true,
        encoding: 'binary',          // matches cfg-luban-cli's import-lmdb encoding
        maxReaders: options.maxReaders ?? 512,
        mapSize: options.mapSize ?? 4 * 1024 * 1024 * 1024,
    }) as unknown as Database;

    // Load table_keys.json and build getters map keyed by full_name (e.g. "TbItem").
    // The JSON's top-level keys are the lowercase filename stems; we use them only
    // to iterate — all runtime identity (map keys, LMDB keys, public API) is full_name.
    const raw = fs.readFileSync(options.tableKeysPath, 'utf-8');
    let tableKeys: CfgTableKeysConfig;
    try {
        tableKeys = JSON.parse(raw);
    } catch (e: any) {
        throw new Error(`openCfgDb: failed to parse ${options.tableKeysPath}: ${e.message}`);
    }

    // Structural validation — catch schema regressions (e.g. CLI version mismatch).
    for (const [stem, info] of Object.entries(tableKeys)) {
        if (!info || typeof info.full_name !== 'string' || !info.full_name) {
            throw new Error(
                `openCfgDb: table_keys.json entry "${stem}" is missing "full_name". ` +
                `Rebuild your cfg package with a compatible cfg-luban-cli.`
            );
        }
        if (!Array.isArray(info.keys) || info.keys.length === 0) {
            throw new Error(
                `openCfgDb: table_keys.json entry "${stem}" (${info.full_name}) is missing "keys". ` +
                `Rebuild your cfg package with a compatible cfg-luban-cli.`
            );
        }
    }

    cfgTableGettersMap.clear();
    for (const info of Object.values(tableKeys)) {
        const getters = info.keys.map(k => snakeToCamel(k));
        cfgTableGettersMap.set(info.full_name, getters);
    }

    // Auto-register from barrel module when provided.
    if (options.cfgModule) {
        const mod = options.cfgModule;
        const totalTables = Object.keys(tableKeys).length;
        let registered = 0;
        const missingClass: string[] = [];
        const missingRootFn: string[] = [];

        for (const info of Object.values(tableKeys)) {
            const cls = mod[info.full_name];
            if (!cls) { missingClass.push(info.full_name); continue; }
            const rootFn = cls['getRootAs' + info.full_name];
            if (typeof rootFn !== 'function') {
                missingRootFn.push(info.full_name);
                continue;
            }
            cfgTableRootFnMap.set(info.full_name, rootFn);
            registered++;
        }

        // Fail fast when cfgModule is almost certainly wired to the wrong module.
        if (registered === 0 && totalTables > 0) {
            throw new Error(
                `openCfgDb: cfgModule did not expose any TbXxx class from table_keys.json ` +
                `(expected ${totalTables} tables, found 0). Likely causes: wrong barrel ` +
                `import path, stale cfg package, or mismatched topModule. ` +
                `First few expected class names: ${missingClass.slice(0, 5).join(', ')}.`
            );
        }

        // Partial miss — legitimate (e.g. user intentionally excluded a table),
        // but noisy setups often hide bugs here, so surface it as a warning.
        if (missingClass.length > 0 || missingRootFn.length > 0) {
            const preview = missingClass.slice(0, 5).join(', ');
            const more = missingClass.length > 5 ? `, +${missingClass.length - 5} more` : '';
            console.warn(
                `[cfg-luban] openCfgDb auto-registered ${registered}/${totalTables} tables. ` +
                (missingClass.length > 0
                    ? `${missingClass.length} not exported by cfgModule: ${preview}${more}. `
                    : '') +
                (missingRootFn.length > 0
                    ? `${missingRootFn.length} classes lack getRootAs<X>: ${missingRootFn.slice(0, 3).join(', ')}. `
                    : '') +
                `Call registerCfgTable() for any missing tables you need to query.`
            );
        }
    }
}

/**
 * Register a table's FlatBuffers root accessor function.
 * Must be called after openCfgDb(), before using getCfgRow etc.
 *
 * tableName must be the full_name form ('TbItem'), matching table_keys.json
 * and LMDB keys. Lowercase stem form ('tbitem') is deprecated and will warn
 * on every call so every mistyped name is surfaced.
 *
 * Registering a name absent from table_keys.json is allowed (escape hatch for
 * bespoke tables) but warns: without getters, only forEachCfgRow works against
 * such tables — getCfgRow will throw "not found in table_keys.json".
 */
export function registerCfgTable(tableName: string, rootFn: CfgRootFn): void {
    if (/^tb[a-z0-9_]+$/.test(tableName)) {
        console.warn(
            `[cfg-luban] registerCfgTable("${tableName}", ...) looks like the old ` +
            `lowercase stem form. Use the full_name form (e.g. "Tb${tableName.slice(2).replace(/^[a-z]/, c => c.toUpperCase())}") instead. ` +
            `Queries against the stem form will miss.`
        );
    }
    if (cfgDb && !cfgTableGettersMap.has(tableName)) {
        console.warn(
            `[cfg-luban] registerCfgTable("${tableName}", ...) — not present in table_keys.json. ` +
            `getCfgRow/getCfgRowList/getCfgRowUnsafe will throw for this table; ` +
            `only forEachCfgRow will work.`
        );
    }
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
    if (!rootFn) throw new Error(`Table "${tableName}" not registered. Call registerCfgTable() first, or pass cfgModule to openCfgDb().`);
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
