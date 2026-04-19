/**
 * importer.ts — Import FlatBuffers .bin files into LMDB.
 *
 * Usage: npx tsx scripts/importer.ts <binDir> <dbPath>
 *
 * Reads all .bin files from <binDir>, writes each as:
 *   key = tableName (filename without .bin extension)
 *   value = binary content
 * into LMDB at <dbPath>.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { open } from 'lmdb';

function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('Usage: npx tsx scripts/importer.ts <binDir> <dbPath>');
        process.exit(1);
    }

    const binDir = path.resolve(args[0]);
    const dbPath = path.resolve(args[1]);

    // Ensure db directory exists
    if (!fs.existsSync(dbPath)) {
        fs.mkdirSync(dbPath, { recursive: true });
    }

    const db = open({
        path: dbPath,
        maxReaders: 512,
        mapSize: 4 * 1024 * 1024 * 1024,
    });

    const files = fs.readdirSync(binDir).filter(f => f.endsWith('.bin'));

    if (files.length === 0) {
        console.warn(`Warning: No .bin files found in ${binDir}`);
        db.close();
        return;
    }

    let importedCount = 0;

    for (const file of files) {
        const tableName = path.basename(file, '.bin');
        const filePath = path.join(binDir, file);
        const binary = fs.readFileSync(filePath);

        db.putSync(tableName, binary);
        importedCount++;
    }

    db.close();
    console.log(`Imported ${importedCount} tables into LMDB at ${dbPath}`);
}

main();
