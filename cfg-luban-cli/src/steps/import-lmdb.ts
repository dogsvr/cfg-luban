/**
 * import-lmdb — Import FlatBuffers .bin files into LMDB.
 *
 * Reads all .bin files from binDir, writes each as:
 *   key   = table stem (filename without .bin extension)
 *   value = raw binary content
 * into LMDB at dbDir.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { open } from 'lmdb';

export interface ImportLmdbOptions {
    binDir: string;
    dbDir: string;
}

export async function importLmdb(opts: ImportLmdbOptions): Promise<void> {
    const binDir = path.resolve(opts.binDir);
    const dbPath = path.resolve(opts.dbDir);

    if (!fs.existsSync(binDir)) {
        throw new Error(`bin dir not found: ${binDir}`);
    }
    fs.mkdirSync(dbPath, { recursive: true });

    const db = open({
        path: dbPath,
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
            const tableName = path.basename(file, '.bin');
            const binary = fs.readFileSync(path.join(binDir, file));
            await db.put(tableName, binary);
            count++;
        }
        await db.flushed;
        console.log(`[import-lmdb] wrote ${count} tables -> ${dbPath}`);
    } finally {
        await db.close();
    }
}
