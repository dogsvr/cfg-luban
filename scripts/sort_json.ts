/**
 * sort_json.ts — Sort JSON data files by primary keys (pre-flatc step).
 *
 * Usage: npx tsx scripts/sort_json.ts <tableKeysPath> <jsonDir>
 *
 * Reads table_keys.json for each table's primary key fields,
 * then sorts each <tableName>.json's data_list array by multi-level key ascending.
 * Overwrites JSON files in-place. Must run BEFORE flatc --binary.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface TableKeyInfo {
    keys: string[];
    [key: string]: any;
}

type TableKeysConfig = Record<string, TableKeyInfo>;

function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('Usage: npx tsx scripts/sort_json.ts <tableKeysPath> <jsonDir>');
        process.exit(1);
    }

    const tableKeysPath = path.resolve(args[0]);
    const jsonDir = path.resolve(args[1]);

    // Load table_keys.json
    const tableKeys: TableKeysConfig = JSON.parse(fs.readFileSync(tableKeysPath, 'utf-8'));

    let sortedCount = 0;

    for (const [tableName, info] of Object.entries(tableKeys)) {
        const jsonPath = path.join(jsonDir, `${tableName}.json`);
        if (!fs.existsSync(jsonPath)) {
            console.warn(`Warning: ${jsonPath} not found, skipping`);
            continue;
        }

        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

        // Luban generates JSON with a "data_list" array
        if (!data.data_list || !Array.isArray(data.data_list)) {
            console.warn(`Warning: ${tableName}.json has no data_list array, skipping`);
            continue;
        }

        const keys = info.keys;

        // Multi-level sort: first key primary, second key secondary, etc.
        data.data_list.sort((a: any, b: any) => {
            for (const key of keys) {
                const va = a[key];
                const vb = b[key];
                if (va < vb) return -1;
                if (va > vb) return 1;
            }
            return 0;
        });

        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
        sortedCount++;
    }

    console.log(`Sorted ${sortedCount} JSON files by primary keys.`);
}

main();
