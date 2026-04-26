/**
 * sort-json — Sort JSON data files by primary keys (pre-flatc step).
 *
 * Reads table_keys.json for each table's primary key fields, then sorts each
 * <tableStem>.json's `data_list` array by multi-level key ascending.
 * Overwrites JSON files in-place. Must run BEFORE flatc --binary for the
 * resulting binaries to support binary search.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface TableKeyInfo {
    keys: string[];
    [key: string]: any;
}
type TableKeysConfig = Record<string, TableKeyInfo>;

export interface SortJsonOptions {
    keys: string;      // path to table_keys.json
    jsonDir: string;   // directory containing <stem>.json files
}

export async function sortJson(opts: SortJsonOptions): Promise<void> {
    const tableKeysPath = path.resolve(opts.keys);
    const jsonDir = path.resolve(opts.jsonDir);

    const tableKeys: TableKeysConfig = JSON.parse(fs.readFileSync(tableKeysPath, 'utf-8'));

    let sortedCount = 0;
    for (const [tableName, info] of Object.entries(tableKeys)) {
        const jsonPath = path.join(jsonDir, `${tableName}.json`);
        if (!fs.existsSync(jsonPath)) {
            console.warn(`[sort-json] ${jsonPath} not found, skip`);
            continue;
        }

        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        if (!data.data_list || !Array.isArray(data.data_list)) {
            console.warn(`[sort-json] ${tableName}.json has no data_list array, skip`);
            continue;
        }

        const keys = info.keys;
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

    console.log(`[sort-json] sorted ${sortedCount} files in ${jsonDir}`);
}
