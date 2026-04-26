/**
 * run-flatc — Invoke flatc to produce TypeScript + per-table binaries.
 *
 * Mirrors gen.sh Step 3 (two sub-steps):
 *
 *   3a) flatc --ts --gen-object-api --force-defaults -o $OUTPUT_DIR/ts \
 *             $OUTPUT_DIR/fbs/schema.fbs
 *
 *   3b) for each table_keys entry:
 *         flatc --binary --force-defaults \
 *           --root-type <topModule>.Tb<value_type> \
 *           -o $OUTPUT_DIR/bin \
 *           $OUTPUT_DIR/fbs/schema.fbs $OUTPUT_DIR/json/<stem>.json
 *
 * topModule is read from luban.conf.targets[name==target].topModule.
 * schema.fbs has no root_type (custom schema.sbn strips it) because
 * FlatBuffers honors only the LAST root_type; we pass it per-table here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export interface RunFlatcOptions {
    flatc: string;
    schemaFbs: string;       // .../fbs/schema.fbs
    jsonDir: string;         // .../json
    outputBinDir: string;    // .../bin
    outputTsDir: string;     // .../ts
    tableKeysPath: string;   // .../table_keys.json
    topModule: string;       // from luban.conf, e.g. "cfg"
}

interface TableEntry {
    value_type: string;
    [key: string]: unknown;
}

export async function runFlatc(opts: RunFlatcOptions): Promise<void> {
    const flatc = path.resolve(opts.flatc);
    const schemaFbs = path.resolve(opts.schemaFbs);
    const jsonDir = path.resolve(opts.jsonDir);
    const outBin = path.resolve(opts.outputBinDir);
    const outTs = path.resolve(opts.outputTsDir);

    fs.mkdirSync(outBin, { recursive: true });
    fs.mkdirSync(outTs, { recursive: true });

    // 3a: one-shot TypeScript emission for the whole schema.
    console.log('[run-flatc] emitting TypeScript...');
    await spawnAsync(flatc, [
        '--ts', '--gen-object-api', '--force-defaults',
        '-o', outTs,
        schemaFbs,
    ]);

    // 3b: per-table binary with explicit --root-type.
    const tableKeys: Record<string, TableEntry> = JSON.parse(
        fs.readFileSync(path.resolve(opts.tableKeysPath), 'utf-8')
    );

    let compiled = 0;
    for (const [stem, entry] of Object.entries(tableKeys)) {
        const jsonFile = path.join(jsonDir, `${stem}.json`);
        if (!fs.existsSync(jsonFile)) {
            console.warn(`[run-flatc] ${jsonFile} missing, skip`);
            continue;
        }
        const rootType = `${opts.topModule}.Tb${entry.value_type}`;
        console.log(`[run-flatc]   ${stem} -> ${rootType}`);
        await spawnAsync(flatc, [
            '--binary', '--force-defaults',
            '--root-type', rootType,
            '-o', outBin,
            schemaFbs,
            jsonFile,
        ]);
        compiled++;
    }
    console.log(`[run-flatc] compiled ${compiled} tables`);
}

function spawnAsync(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
}
