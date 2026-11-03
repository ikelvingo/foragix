import { type Foragix, type ForagixOptions } from './index.js';
export declare const EXIT_OK = 0;
export declare const EXIT_REFUSED = 2;
export declare const EXIT_ERROR = 1;
declare const COMMANDS: readonly ["search", "fetch", "information", "status"];
export type Command = (typeof COMMANDS)[number];
/** Machine-readable failure codes. Stable; agents may branch on these. */
export type CliErrorCode = 'usage_error' | 'config_missing' | 'config_invalid' | 'data_dir_unwritable' | 'internal_error';
export interface CliIo {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
    /** Reads all of stdin. Only called when `--input-json` is given. */
    readonly readStdin: () => Promise<string>;
    readonly env: NodeJS.ProcessEnv;
    /** Whether stdin is an interactive terminal; `--input-json` refuses to read from one. */
    readonly stdinIsTty: boolean;
    /** Working directory used to locate a `.env`; defaults to `process.cwd()`. */
    readonly cwd?: string;
    /** Injection point for tests. */
    readonly createForagix?: (options: ForagixOptions) => Foragix;
}
/** The optional config file. Its absence is normal and enables nothing special. */
export declare function defaultConfigPath(env: NodeJS.ProcessEnv): string;
/**
 * Run one CLI invocation and return the process exit code.
 * Never throws: every failure becomes a JSON object on stdout plus a stderr diagnostic.
 */
export declare function runCli(argv: readonly string[], ioOverrides?: Partial<CliIo>): Promise<number>;
export {};
