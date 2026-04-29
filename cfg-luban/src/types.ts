import { ByteBuffer } from 'flatbuffers';

/** Per-table key metadata from table_keys.json */
export interface CfgTableKeyInfo {
    /** Primary key field names (snake_case from Luban), e.g. ["skill_id", "level"] */
    keys: string[];
    /** Luban full class name, e.g. "TbItem". Used as the runtime table identity. */
    full_name: string;
    /** Element type, e.g. "Item". Used as `--root-type <topModule>.Tb<value_type>` for flatc. */
    value_type: string;
    /** "map" | "list" | "one" — how Luban stores the table. */
    mode: 'map' | 'list' | 'one';
    /** list-mode only: raw index string like "k1+k2" or "k1,k2". */
    index?: string;
    /** list-mode only: true when index used '+' (union), false when ','. */
    is_union?: boolean;
}

/** Full table_keys.json structure */
export type CfgTableKeysConfig = Record<string, CfgTableKeyInfo>;

/** Options for openCfgDb() */
export interface CfgLubanOptions {
    dbPath: string;           // LMDB directory path
    tableKeysPath: string;    // path to table_keys.json
    maxReaders?: number;      // default 512
    mapSize?: number;         // default 4GB
    /**
     * Optional flatc barrel module (e.g. `import * as cfgModule from '<pkg>/dist/ts/cfg'`).
     * When provided, openCfgDb auto-registers every table whose class is found on the
     * module, deriving the root accessor as `cfgModule[fullName].getRootAs<fullName>`.
     * Missing classes are silently skipped (first getCfgRow on them will throw).
     * Omit this option if you prefer to call registerCfgTable() per table — useful for
     * large cfg where each worker only loads a subset of tables.
     */
    cfgModule?: Record<string, any>;
}

/** FlatBuffers root accessor function type */
export type CfgRootFn = (bb: ByteBuffer) => any;
