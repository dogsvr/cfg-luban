/**
 * extract-table-keys — Generate table_keys.json from __tables__.xlsx.
 *
 * Reads Luban's __tables__.xlsx (columns: full_name / value_type /
 * read_schema_from_file / input / index / mode / group / ...) and produces a
 * table_keys.json consumed by sort-json and import-lmdb.
 *
 * Output shape:
 *   {
 *     "<json_filename_stem>": {
 *       "mode": "map" | "list" | "one",
 *       "keys": ["id"],                  // always present
 *       "value_type": "Rank",            // element type, used as --root-type cfg.Tb<X>
 *       "full_name": "TbRank",
 *       "index": "k1+k2" | "k1,k2",      // list only: raw index string
 *       "is_union": true | false         // list only: '+' = union, ',' = multi
 *     }
 *   }
 *
 * The key is the *output file stem* luban actually writes, not full_name.
 * Luban's json target lowercases full_name and strips dots, e.g.
 *   "TbRank"       -> "tbrank"
 *   "game.TbItem"  -> "gametbitem"
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

interface TableRow {
    full_name: string;
    value_type: string;
    input: string;
    index: string; // may be empty; "k1+k2" = union; "k1,k2" = multi
    mode: string;  // one | map | list | "" (defaults to map)
    group: string;
}

interface TableKeyEntry {
    mode: 'one' | 'map' | 'list';
    keys: string[];
    value_type: string;
    full_name: string;
    index?: string;
    is_union?: boolean;
}

export interface ExtractTableKeysOptions {
    tablesXlsx: string;
    out: string;
}

function fullNameToStem(fullName: string): string {
    return fullName.toLowerCase().replace(/\./g, '');
}

function parseIndex(index: string, valueType: string): { keys: string[]; isUnion: boolean } {
    const raw = (index ?? '').trim();
    if (!raw) {
        return { keys: [valueType], isUnion: false };
    }
    if (raw.includes('+')) {
        return { keys: raw.split('+').map((s) => s.trim()).filter(Boolean), isUnion: true };
    }
    if (raw.includes(',')) {
        return { keys: raw.split(',').map((s) => s.trim()).filter(Boolean), isUnion: false };
    }
    return { keys: [raw], isUnion: false };
}

function parseMode(mode: string): 'one' | 'map' | 'list' {
    const m = (mode ?? '').trim().toLowerCase();
    if (m === 'one' || m === 'list') return m;
    return 'map';
}

/**
 * Read __tables__.xlsx via a short Python helper (openpyxl).
 * openpyxl is part of the usual mac/linux python tool belt; swapping to
 * a Node-native xlsx reader means adding a dependency we don't need.
 */
function readTablesXlsx(xlsxPath: string): TableRow[] {
    const pyScript = `
import json, sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1], data_only=True)
ws = wb.active
rows = list(ws.iter_rows(values_only=True))
if len(rows) < 3:
    print("[]")
    sys.exit(0)
header = [ (c or "").strip() if isinstance(c, str) else c for c in rows[0] ]
out = []
for r in rows[1:]:
    if not r: continue
    first = r[0]
    if isinstance(first, str) and first.strip().startswith("##"):
        continue
    if all(c is None or (isinstance(c, str) and not c.strip()) for c in r):
        continue
    obj = {}
    for i, key in enumerate(header):
        if not key or key == "##var":
            continue
        obj[key] = r[i] if i < len(r) else None
    out.append(obj)
print(json.dumps(out, ensure_ascii=False))
`;
    const stdout = execFileSync('python3', ['-c', pyScript, xlsxPath], {
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
    });
    const raw = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return raw.map((o) => ({
        full_name: String(o.full_name ?? '').trim(),
        value_type: String(o.value_type ?? '').trim(),
        input: String(o.input ?? '').trim(),
        index: String(o.index ?? '').trim(),
        mode: String(o.mode ?? '').trim(),
        group: String(o.group ?? '').trim(),
    }));
}

export async function extractTableKeys(opts: ExtractTableKeysOptions): Promise<void> {
    const xlsxPath = path.resolve(opts.tablesXlsx);
    const outPath = path.resolve(opts.out);

    if (!fs.existsSync(xlsxPath)) {
        throw new Error(`tables xlsx not found: ${xlsxPath}`);
    }

    const rows = readTablesXlsx(xlsxPath);
    const result: Record<string, TableKeyEntry> = {};

    for (const row of rows) {
        if (!row.full_name || !row.value_type) continue;

        const mode = parseMode(row.mode);
        const { keys, isUnion } = parseIndex(row.index, row.value_type);
        const stem = fullNameToStem(row.full_name);

        if (mode === 'list') {
            result[stem] = {
                mode,
                keys,
                value_type: row.value_type,
                full_name: row.full_name,
                index: row.index || keys.join(isUnion ? '+' : ','),
                is_union: isUnion,
            };
        } else {
            result[stem] = {
                mode,
                keys,
                value_type: row.value_type,
                full_name: row.full_name,
            };
        }
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
    console.log(`[extract-table-keys] wrote ${Object.keys(result).length} entries -> ${outPath}`);
}
