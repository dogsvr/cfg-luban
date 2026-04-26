#!/usr/bin/env node
/**
 * cfg-luban-cli — codegen CLI for @dogsvr/cfg-luban.
 *
 * Subcommands:
 *   build          Full pipeline: Excel -> LMDB
 *   extract-keys   Generate table_keys.json from __tables__.xlsx
 *   sort-json      Sort each <stem>.json's data_list by primary keys
 *   import-lmdb    Import <bin>/*.bin into LMDB
 *
 * All tool paths (Luban.dll, flatc) are passed via --luban-dll / --flatc flags.
 * Environment variables LUBAN_DLL / FLATC / DESIGNER_DIR / OUTPUT_DIR are
 * honored only as fallbacks when the corresponding flag is not supplied.
 *
 * Arg parsing: hand-rolled so we can support Node 16 (node:util.parseArgs
 * only stabilized in 18.3). Handles --flag value, --flag=value, -h boolean
 * short alias, and repeated flags (last wins — so wrappers can set defaults
 * and callers can override by appending).
 */

import { build } from './pipeline';
import { extractTableKeys } from './steps/extract-table-keys';
import { sortJson } from './steps/sort-json';
import { importLmdb } from './steps/import-lmdb';

type Flag = { type: 'string' } | { type: 'boolean'; short?: string };
type FlagSpec = Record<string, Flag>;

/**
 * Minimal arg parser. Only supports long flags (--name, --name=value,
 * --name value) and configured short boolean aliases (e.g. -h). Repeated
 * string flags: last one wins (matches Node parseArgs behavior, and lets
 * wrappers pre-seed defaults). Unknown flags / positional args cause exit.
 */
function parseFlags(args: string[], spec: FlagSpec): Record<string, string | boolean | undefined> {
    const out: Record<string, string | boolean | undefined> = {};
    const shortMap: Record<string, string> = {};
    for (const [long, f] of Object.entries(spec)) {
        if (f.type === 'boolean' && f.short) shortMap[f.short] = long;
    }

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        let name: string | undefined;
        let inlineValue: string | undefined;

        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq >= 0) {
                name = a.slice(2, eq);
                inlineValue = a.slice(eq + 1);
            } else {
                name = a.slice(2);
            }
        } else if (a.startsWith('-') && a.length === 2) {
            const long = shortMap[a.slice(1)];
            if (!long) {
                console.error(`Unknown flag: ${a}`);
                process.exit(2);
            }
            name = long;
        } else {
            console.error(`Unexpected positional argument: ${a}`);
            process.exit(2);
        }

        const f = spec[name];
        if (!f) {
            console.error(`Unknown flag: --${name}`);
            process.exit(2);
        }

        if (f.type === 'boolean') {
            if (inlineValue !== undefined) {
                console.error(`--${name} is a boolean flag, does not take a value`);
                process.exit(2);
            }
            out[name] = true;
        } else {
            let value: string | undefined = inlineValue;
            if (value === undefined) {
                const next = args[i + 1];
                if (next === undefined || next.startsWith('-')) {
                    console.error(`--${name} requires a value`);
                    process.exit(2);
                }
                value = next;
                i++;
            }
            out[name] = value; // last wins
        }
    }
    return out;
}

function printTopLevelHelp(): void {
    process.stdout.write(`\
cfg-luban-cli — codegen pipeline for @dogsvr/cfg-luban

Usage:
  cfg-luban-cli <subcommand> [options]

Subcommands:
  build           Full Excel -> LMDB pipeline
  extract-keys    Generate table_keys.json from __tables__.xlsx
  sort-json       Sort <stem>.json data_list by primary keys (in place)
  import-lmdb     Import <binDir>/*.bin into LMDB

Run 'cfg-luban-cli <subcommand> --help' for subcommand details.
`);
}

function printBuildHelp(): void {
    process.stdout.write(`\
cfg-luban-cli build — full pipeline: Excel -> LMDB

Options (required unless noted):
  --luban-dll <path>   Path to Luban.dll           [env: LUBAN_DLL]
  --flatc <path>       Path to flatc binary        [env: FLATC]
  --designer <dir>     Directory containing luban.conf
                                                   [env: DESIGNER_DIR]
  --output <dir>       Output root (default: ./generated)
                                                   [env: OUTPUT_DIR]
  --target <name>      Luban target (default: "all")
  -h, --help           Show this help
`);
}

function requireStr(name: string, value: string | undefined, envName?: string): string {
    const v = value ?? (envName ? process.env[envName] : undefined);
    if (!v) {
        const envHint = envName ? ` or env ${envName}` : '';
        console.error(`Error: missing required --${name}${envHint}`);
        process.exit(2);
    }
    return v;
}

async function runBuild(argv: string[]): Promise<void> {
    const values = parseFlags(argv, {
        'luban-dll': { type: 'string' },
        'flatc':     { type: 'string' },
        'designer':  { type: 'string' },
        'output':    { type: 'string' },
        'target':    { type: 'string' },
        'help':      { type: 'boolean', short: 'h' },
    });

    if (values.help) { printBuildHelp(); return; }

    await build({
        lubanDll: requireStr('luban-dll', values['luban-dll'] as string, 'LUBAN_DLL'),
        flatc:    requireStr('flatc',     values['flatc']     as string, 'FLATC'),
        designer: requireStr('designer',  values['designer']  as string, 'DESIGNER_DIR'),
        output:   (values['output']  as string) ?? process.env.OUTPUT_DIR ?? './generated',
        target:   (values['target']  as string) ?? 'all',
    });
}

async function runExtractKeys(argv: string[]): Promise<void> {
    const values = parseFlags(argv, {
        'tables-xlsx': { type: 'string' },
        'out':         { type: 'string' },
        'help':        { type: 'boolean', short: 'h' },
    });
    if (values.help) {
        console.log('Usage: cfg-luban-cli extract-keys --tables-xlsx <path> --out <path>');
        return;
    }
    await extractTableKeys({
        tablesXlsx: requireStr('tables-xlsx', values['tables-xlsx'] as string),
        out:        requireStr('out',         values['out']         as string),
    });
}

async function runSortJson(argv: string[]): Promise<void> {
    const values = parseFlags(argv, {
        'keys':     { type: 'string' },
        'json-dir': { type: 'string' },
        'help':     { type: 'boolean', short: 'h' },
    });
    if (values.help) {
        console.log('Usage: cfg-luban-cli sort-json --keys <table_keys.json> --json-dir <dir>');
        return;
    }
    await sortJson({
        keys:    requireStr('keys',     values['keys']     as string),
        jsonDir: requireStr('json-dir', values['json-dir'] as string),
    });
}

async function runImportLmdb(argv: string[]): Promise<void> {
    const values = parseFlags(argv, {
        'bin-dir': { type: 'string' },
        'db-dir':  { type: 'string' },
        'help':    { type: 'boolean', short: 'h' },
    });
    if (values.help) {
        console.log('Usage: cfg-luban-cli import-lmdb --bin-dir <dir> --db-dir <dir>');
        return;
    }
    await importLmdb({
        binDir: requireStr('bin-dir', values['bin-dir'] as string),
        dbDir:  requireStr('db-dir',  values['db-dir']  as string),
    });
}

async function main(): Promise<void> {
    const [subcmd, ...rest] = process.argv.slice(2);
    if (!subcmd || subcmd === '-h' || subcmd === '--help') {
        printTopLevelHelp();
        return;
    }

    switch (subcmd) {
        case 'build':         await runBuild(rest);        break;
        case 'extract-keys':  await runExtractKeys(rest);  break;
        case 'sort-json':     await runSortJson(rest);     break;
        case 'import-lmdb':   await runImportLmdb(rest);   break;
        default:
            console.error(`Unknown subcommand: ${subcmd}`);
            printTopLevelHelp();
            process.exit(2);
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : err);
    process.exit(1);
});
