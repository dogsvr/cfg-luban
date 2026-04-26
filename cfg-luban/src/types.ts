import { ByteBuffer } from 'flatbuffers';

/** Per-table key metadata from table_keys.json */
export interface CfgTableKeyInfo {
    keys: string[];  // primary key field names (snake_case from Luban), e.g. ["skill_id", "level"]
}

/** Full table_keys.json structure */
export type CfgTableKeysConfig = Record<string, CfgTableKeyInfo>;

/** Options for openCfgDb() */
export interface CfgLubanOptions {
    dbPath: string;           // LMDB directory path
    tableKeysPath: string;    // path to table_keys.json
    maxReaders?: number;      // default 512
    mapSize?: number;         // default 4GB
}

/** FlatBuffers root accessor function type */
export type CfgRootFn = (bb: ByteBuffer) => any;
