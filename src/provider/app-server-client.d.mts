export interface AppServerClientOptions {
  /** 已解析的可执行文件（resolveZcodeBin 的绝对路径），必须是绝对路径。 */
  executable: string;
  /** command 之外的 argv 前缀（node + zcode.cjs 路径 / 空数组）。 */
  argvPrefix: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log?: (record: Record<string, unknown>) => void;
}

export class AppServerClient {
  static spawn(opts: AppServerClientOptions): AppServerClient;
  waitReady(timeoutMs?: number): Promise<boolean>;
  rpc<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  getStderr(): string;
  close(): Promise<void>;
}
