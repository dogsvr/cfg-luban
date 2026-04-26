/**
 * run-luban — Invoke Luban (dotnet Luban.dll) to convert Excel -> .fbs + .json.
 *
 * Mirrors gen.sh Step 1:
 *   cd $DESIGNER_DIR
 *   dotnet $LUBAN_DLL -t <target> -c flatbuffers -d flatbuffers-json \
 *     --conf luban.conf --customTemplateDir $CUSTOM_TEMPLATE_DIR \
 *     -x outputCodeDir=$OUTPUT_DIR/fbs \
 *     -x outputDataDir=$OUTPUT_DIR/json
 *
 * Luban resolves paths in luban.conf relative to the config's directory,
 * so we cwd into designerDir. --customTemplateDir and outputCodeDir /
 * outputDataDir are absolute paths to avoid relative-path confusion.
 */

import * as path from 'node:path';
import { spawn } from 'node:child_process';

export interface RunLubanOptions {
    lubanDll: string;        // absolute path to Luban.dll
    designerDir: string;     // dir containing luban.conf
    customTemplateDir: string; // templates/flatbuffers parent
    outputFbsDir: string;
    outputJsonDir: string;
    target: string;          // e.g. "all"
}

export async function runLuban(opts: RunLubanOptions): Promise<void> {
    const lubanDll = path.resolve(opts.lubanDll);
    const designerDir = path.resolve(opts.designerDir);
    const customTemplateDir = path.resolve(opts.customTemplateDir);
    const outputFbsDir = path.resolve(opts.outputFbsDir);
    const outputJsonDir = path.resolve(opts.outputJsonDir);

    const args = [
        lubanDll,
        '-t', opts.target,
        '-c', 'flatbuffers',
        '-d', 'flatbuffers-json',
        '--conf', 'luban.conf',
        '--customTemplateDir', customTemplateDir,
        '-x', `outputCodeDir=${outputFbsDir}`,
        '-x', `outputDataDir=${outputJsonDir}`,
    ];

    console.log(`[run-luban] dotnet ${args.join(' ')}`);
    await spawnAsync('dotnet', args, { cwd: designerDir });
    console.log('[run-luban] done');
}

function spawnAsync(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: 'inherit', cwd: opts.cwd });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
}
