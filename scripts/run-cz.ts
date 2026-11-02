import { runCz } from '@zyplux/cz/cli';

const CLI_ARGUMENT_OFFSET = 2;
await runCz(process.argv.slice(CLI_ARGUMENT_OFFSET));
