#!/usr/bin/env node
/* istanbul ignore file */
import { runCli } from './main';

runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
}).then((exitCode) => {
    if (process.argv[2] !== 'watch') {
        process.exit(exitCode);
    }
});
