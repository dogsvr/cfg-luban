/**
 * pipeline.ts — Orchestrate the full Excel -> LMDB build pipeline.
 *
 * Steps (mirroring the original gen.sh):
 *   1. run-luban           xlsx          -> .fbs + .json
 *   1.5. extract-table-keys xlsx         -> table_keys.json
 *   2. sort-json           json/         -> sorted json/ (in place)
 *   3. run-flatc           fbs + json/   -> bin/ + ts/
 *   4. import-lmdb         bin/          -> db/
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runLuban } from './steps/run-luban';
import { extractTableKeys } from './steps/extract-table-keys';
import { sortJson } from './steps/sort-json';
import { runFlatc } from './steps/run-flatc';
import { importLmdb } from './steps/import-lmdb';

export interface BuildOptions {
    lubanDll: string;
    flatc: string;
    designer: string;   // designer_cfg dir (containing luban.conf)
    output: string;     // root output dir (we create fbs/ json/ bin/ ts/ db/ inside)
    target?: string;    // luban target, default "all"
}

/**
 * templates/ directory shipped inside this package. Resolves to
 * <pkg>/templates after tsc (dist/pipeline.js -> ../templates) and
 * <pkg>/templates during local dev (src/pipeline.ts -> ../templates).
 */
function resolveTemplatesDir(): string {
    return path.resolve(__dirname, '..', 'templates');
}

interface LubanConf {
    targets?: Array<{ name: string; topModule?: string }>;
}

function readTopModule(designerDir: string, target: string): string {
    const confPath = path.join(designerDir, 'luban.conf');
    if (!fs.existsSync(confPath)) {
        throw new Error(`luban.conf not found: ${confPath}`);
    }
    const conf: LubanConf = JSON.parse(fs.readFileSync(confPath, 'utf-8'));
    const t = (conf.targets ?? []).find((x) => x.name === target);
    if (!t || !t.topModule) {
        throw new Error(
            `luban.conf target "${target}" not found or missing topModule (${confPath})`
        );
    }
    return t.topModule;
}

export async function build(opts: BuildOptions): Promise<void> {
    const target = opts.target ?? 'all';
    const designerDir = path.resolve(opts.designer);
    const outRoot = path.resolve(opts.output);

    const outFbs = path.join(outRoot, 'fbs');
    const outJson = path.join(outRoot, 'json');
    const outBin = path.join(outRoot, 'bin');
    const outTs = path.join(outRoot, 'ts');
    const outDb = path.join(outRoot, 'db');
    const tableKeysPath = path.join(outRoot, 'table_keys.json');

    // Clean output
    fs.rmSync(outRoot, { recursive: true, force: true });
    for (const d of [outFbs, outJson, outBin, outTs, outDb]) {
        fs.mkdirSync(d, { recursive: true });
    }

    const topModule = readTopModule(designerDir, target);

    // Step 1: Luban
    await runLuban({
        lubanDll: opts.lubanDll,
        designerDir,
        customTemplateDir: resolveTemplatesDir(),
        outputFbsDir: outFbs,
        outputJsonDir: outJson,
        target,
    });

    // Step 1.5: table_keys.json
    await extractTableKeys({
        tablesXlsx: path.join(designerDir, 'Datas', '__tables__.xlsx'),
        out: tableKeysPath,
    });

    // Step 2: sort json
    await sortJson({ keys: tableKeysPath, jsonDir: outJson });

    // Step 3: flatc
    await runFlatc({
        flatc: opts.flatc,
        schemaFbs: path.join(outFbs, 'schema.fbs'),
        jsonDir: outJson,
        outputBinDir: outBin,
        outputTsDir: outTs,
        tableKeysPath,
        topModule,
    });

    // Step 4: import to LMDB
    await importLmdb({ binDir: outBin, dbDir: outDb });

    console.log(`Build complete. LMDB at ${outDb}`);
}
