interface BypassOptions {
  hook: boolean;
  window: boolean;
  module: boolean;
  process: boolean;
  container: boolean;
  js: boolean;
}

interface NapCatConfig {
  fileLog: boolean;
  consoleLog: boolean;
  fileLogLevel: string;
  consoleLogLevel: string;
  packetBackend: string;
  packetServer: string;
  o3HookMode: number;
  autoTimeSync: boolean;
  bypass?: BypassOptions;
}

/** 反检测开关在一次启动里的实际应用结果（对应 napcat-core/helper/bypass.ts） */
interface BypassApplyStatus {
  moduleLoaded: boolean;
  disabledByEnv: boolean;
  applied: boolean;
  requested: BypassOptions;
  effective: BypassOptions;
  error?: string;
  updatedAt: number;
}

type BypassProbeState = 'present' | 'partial' | 'missing' | 'unknown';

interface BypassSwitchProbe {
  key: keyof BypassOptions;
  state: BypassProbeState;
  missing: string[];
  detail: string;
}

/** 反检测静态自检结果（对应 napcat-core/helper/bypass-probe.ts） */
interface BypassProbeReport {
  platform: string;
  platformSupported: boolean;
  wrapperPath?: string;
  qqntPath?: string;
  wrapperImports?: { dlls: number; apis: number; };
  switches: Partial<Record<keyof BypassOptions, BypassSwitchProbe>>;
  checkedAt: number;
  error?: string;
}

interface BypassStatusPayload {
  status: BypassApplyStatus | null;
  probe: BypassProbeReport | null;
  config: BypassOptions;
  defaults: BypassOptions;
  platform: string;
  platformSupported: boolean;
  disabledByEnv: boolean;
}
