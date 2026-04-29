/**
 * import-lmdb — Import FlatBuffers .bin files into LMDB.
 *
 * Reads all .bin files from binDir, translates each filename stem (lowercase,
 * e.g. "tbitem") to its full_name (e.g. "TbItem") via table_keys.json, then
 * writes:
 *   key   = full_name (if found in table_keys.json) or stem (fallback)
 *   value = raw binary content
 * into LMDB at dbDir.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { open } from 'lmdb';

export interface ImportLmdbOptions {
    binDir: string;
    dbDir: string;
    tableKeysPath: string;   // path to table_keys.json for stem -> full_name translation
}

interface TableKeyEntry {
    full_name: string;
    [key: string]: unknown;
}

export async function importLmdb(opts: ImportLmdbOptions): Promise<void> {
    const binDir = path.resolve(opts.binDir);
    const dbPath = path.resolve(opts.dbDir);
    const tableKeysPath = path.resolve(opts.tableKeysPath);

    if (!fs.existsSync(binDir)) {
        throw new Error(`bin dir not found: ${binDir}`);
    }
    if (!fs.existsSync(tableKeysPath)) {
        throw new Error(`table_keys.json not found: ${tableKeysPath}`);
    }
    fs.mkdirSync(dbPath, { recursive: true });

    // Build stem -> full_name map.
    const tableKeys: Record<string, TableKeyEntry> = JSON.parse(
        fs.readFileSync(tableKeysPath, 'utf-8')
    );
    const stemToFullName = new Map<string, string>();
    for (const [stem, entry] of Object.entries(tableKeys)) {
        if (entry && entry.full_name) stemToFullName.set(stem, entry.full_name);
    }

    const db = open({
        path: dbPath,
        encoding: 'binary',          // store raw bytes; runtime reads via getBinaryFast
        maxReaders: 512,
        mapSize: 4 * 1024 * 1024 * 1024,
    });

    try {
        const files = fs.readdirSync(binDir).filter((f) => f.endsWith('.bin'));
        if (files.length === 0) {
            console.warn(`[import-lmdb] no .bin files in ${binDir}`);
            return;
        }

        let count = 0;
        for (const file of files) {
            const stem = path.basename(file, '.bin');
            const key = stemToFullName.get(stem);
            if (!key) {
                console.warn(`[import-lmdb] ${stem}.bin has no entry in table_keys.json, falling back to stem as key`);
            }
            const binary = fs.readFileSync(path.join(binDir, file));
            await db.put(key ?? stem, binary);
            count++;
        }
        await db.flushed;
        console.log(`[import-lmdb] wrote ${count} tables -> ${dbPath}`);
    } finally {
        await db.close();
    }
}
