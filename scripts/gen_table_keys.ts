/**
 * gen_table_keys.ts — Generate table_keys.json from __tables__.xlsx.
 *
 * Usage: npx tsx scripts/gen_table_keys.ts <tablesXlsxPath> <outputJsonPath>
 *
 * Reads Luban's __tables__.xlsx (columns: full_name / value_type /
 * read_schema_from_file / input / index / mode / group / ...) and produces a
 * table_keys.json consumed by sort_json.ts and the LMDB importer.
 *
 * Output shape matches tools/luban_custom_templates/flatbuffers/table_keys.sbn:
 *   {
 *     "<json_filename_stem>": {
 *       "mode": "map" | "list" | "one",
 *       "keys": ["id"],                  // always present
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
    mode: string; // one | map | list | "" (defaults to map)
    group: string;
}

interface TableKeyEntry {
    mode: 'one' | 'map' | 'list';
    keys: string[];
    /** Element type name (e.g. "Rank" for TbRank). Used by gen.sh to pass
     *  --root-type cfg.Tb<X> when flatc-compiling this table's json. */
    value_type: string;
    /** Table wrapper name as declared in the .fbs (e.g. "TbRank"). */
    full_name: string;
    // list-mode extras, mirroring table_keys.sbn
    index?: string;
    is_union?: boolean;
}

/** Luban json target's file-stem rule: lowercase full_name and strip dots. */
function fullNameToStem(fullName: string): string {
    return fullName.toLowerCase().replace(/\./g, '');
}

/** Parse the "index" column into key list + whether it is a union index. */
function parseIndex(index: string, valueType: string): { keys: string[]; isUnion: boolean } {
    const raw = (index ?? '').trim();
    if (!raw) {
        // Luban rule: empty => first field of value_type. We can't peek at
        // the bean schema from here, so fall back to value_type as a
        // placeholder and let the caller fix it up if needed.
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

/** Normalize mode; empty defaults to map per luban semantics. */
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
# Row 0 is the ##var header row; rows starting with ## are metadata.
header = [ (c or "").strip() if isinstance(c, str) else c for c in rows[0] ]
out = []
for r in rows[1:]:
    if not r: continue
    first = r[0]
    if isinstance(first, str) and first.strip().startswith("##"):
        continue
    # Some rows are just blank padding
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

function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('Usage: npx tsx scripts/gen_table_keys.ts <__tables__.xlsx> <output table_keys.json>');
        process.exit(1);
    }

    const xlsxPath = path.resolve(args[0]);
    const outPath = path.resolve(args[1]);

    if (!fs.existsSync(xlsxPath)) {
        console.error(`Error: ${xlsxPath} not found`);
        process.exit(1);
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
            // map / one: keys only (one-mode has no meaningful key, kept for consistency)
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
    console.log(`Wrote ${Object.keys(result).length} table keys -> ${outPath}`);
}

main();
