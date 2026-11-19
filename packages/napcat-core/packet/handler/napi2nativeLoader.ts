import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { constants } from 'node:os';
import { LogWrapper } from '../../helper/log';
import { BypassOptions, SUPPORTED_BYPASS_PLATFORMS } from '../../helper/bypass';

export interface Napi2NativeExportType {
  initHook?: (send: string, recv: string) => boolean;
  setVerbose?: (verbose: boolean) => void; // 默认关闭日志
  enableAllBypasses?: (options?: BypassOptions) => boolean;
}

export class Napi2NativeLoader {
  private readonly supportedPlatforms: readonly string[] = SUPPORTED_BYPASS_PLATFORMS;
  private readonly exports: { exports: Napi2NativeExportType; } = { exports: {} };
  protected readonly logger: LogWrapper;
  private _loaded: boolean = false;
  private _modulePath: string | undefined;

  constructor ({ logger }: { logger: LogWrapper; }) {
    this.logger = logger;
    this.load();
  }

  private load (): void {
    const platform = process.platform + '.' + process.arch;

    if (!this.supportedPlatforms.includes(platform)) {
      this.logger.logWarn(`Napi2NativeLoader: 不支持的平台: ${platform}`);
      this._loaded = false;
      return;
    }

    const nativeModulePath = path.join(
      dirname(fileURLToPath(import.meta.url)),
      './native/napi2native/napi2native.' + platform + '.node'
    );
    this._modulePath = nativeModulePath;

    if (!fs.existsSync(nativeModulePath)) {
      this.logger.logWarn(`Napi2NativeLoader: 缺失运行时文件: ${nativeModulePath}`);
      this._loaded = false;
      return;
    }

    try {
      process.dlopen(this.exports, nativeModulePath, constants.dlopen.RTLD_LAZY);
      this._loaded = true;
      this.logger.log('[Napi2NativeLoader] 加载成功');
    } catch (error) {
      this.logger.logError('Napi2NativeLoader 加载出错:', error);
      this._loaded = false;
    }
  }

  get loaded (): boolean {
    return this._loaded;
  }

  /** 原生模块文件路径（未加载时为期望路径），用于反检测自检与排障 */
  get modulePath (): string | undefined {
    return this._modulePath;
  }

  get nativeExports (): Napi2NativeExportType {
    return this.exports.exports;
  }

  /**
   * 初始化 Hook
   * @param send send 偏移地址
   * @param recv recv 偏移地址
   * @returns 是否初始化成功
   */
  initHook (send: string, recv: string): boolean {
    if (!this._loaded) {
      this.logger.logWarn('Napi2NativeLoader 未成功加载，无法初始化 Hook');
      return false;
    }

    try {
      return this.nativeExports.initHook?.(send, recv) ?? false;
    } catch (error) {
      this.logger.logError('Napi2NativeLoader initHook 出错:', error);
      return false;
    }
  }
}
