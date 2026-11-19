# 反检测（Bypass）维护手册

> 适用范围：`packages/napcat-core/helper/{bypass,bypass-probe,pe-imports,config}.ts`、
> `packages/napcat-shell/base.ts`、`packages/napcat-framework/napcat.ts`、
> `packages/napcat-webui-{backend,frontend}` 的「反检测」页。

## 1. 这套东西由谁实现

真正做反检测的是**预编译原生模块** `packages/napcat-native/napi2native/napi2native.<platform>.node`
（基于 Frida Gum，源码不在本仓库）。本仓库只负责四件事：

```
napcat.json(bypass)  →  归一化/校验  →  enableAllBypasses(原生)  →  记录状态 & 静态自检  →  WebUI
        │                    │                    │                        │
   external/napcat.json   helper/config.ts   helper/bypass.ts      helper/bypass-probe.ts
```

因此**改开关语义要改原生模块**；本仓库能做的、也最容易出问题的是：配置漂移、调用遗漏、
QQ 换版本后依赖静默消失。这三件事都已在本仓库内收口。

## 2. 六个开关的真实实现（逆向 `napi2native.win32.x64.node` 得到）

| 开关 | 实现方式 | 依赖（缺了就失效） | 原生日志关键字 |
|---|---|---|---|
| `hook` | IAT 伪装：hook `VirtualQuery`，把 `AllocationBase` 指回 kernel32，RWX 页报成 RX | `wrapper.node` 导入 `VirtualQuery` | `[BYPASS-IAT] ...` |
| `module` | 模块枚举隐藏：过滤注入模块（boothook / moehoo / napi2native / pty / ffmpegaddon / dpapi），并挂一个 stub `ffmpeg.dll` | `K32EnumProcessModules`、`GetModuleHandleW`、`GetModuleHandleExA` | `[BYPASS-MODNUM] ...` |
| `process` | 进程名伪装：`GetModuleFileNameA/W` 返回 QQ 自身路径 | `GetModuleFileNameA/W` | `[BYPASS-PROCESS] ...` |
| `window` | 补建 Chromium `base::PowerMonitor` 的 `Base_PowerMessageWindow`（真实客户端天然有） | QQNT.dll 内的窗口类名 | `[BYPASS] Window class bypass enabled` |
| `js` | hook `NodeContextifyContextMetrics1` 伪造 contextify 计数，并隐藏注入的 JS 清单（`launcher.js`、`application.asar\*.background.js`） | QQNT.dll 内的 Node 运行时符号 | `[BYPASS-WIN] NodeContextifyContextMetrics1 ...` |
| `container` | 原生模块内部处理，无外部可核对特征 | — | `[BYPASS] ========== ... ==========` |

`hook` 里还有一条 `VirtualQueryEx` 子 hook；**QQ 9.9.37-54395 的 wrapper.node 并不导入它**，
所以那条子 hook 永远空转（只会打 WARN）。自检把 `VirtualQueryEx` 标为 optional，就是这个原因。

## 3. 实测数据（QQ 9.9.37-54395，2026-11 采样）

| 事实 | 值 | 采集方式 |
|---|---|---|
| wrapper.node 大小 | 118,186,536 B | `Get-Item` |
| wrapper.node 导入 | 38 个 DLL / 1202 个 API | `helper/pe-imports.ts`（64 ms） |
| `VirtualQuery` | kernel32.dll ✅ | 导入表 |
| `VirtualQueryEx` | ❌ 未导入 | 导入表 |
| `K32EnumProcessModules` / `GetModuleHandleW` / `GetModuleHandleExA` | kernel32.dll ✅ | 导入表 |
| `GetModuleFileNameW` / `GetModuleFileNameA` | kernel32.dll ✅ | 导入表 |
| `Base_PowerMessageWindow` | QQNT.dll（214 MB）偏移 199,677,600，UTF-16 | 分块字节扫描 |
| `NodeContextifyContextMetrics1` | QQNT.dll 偏移 207,117,202，ASCII | 分块字节扫描 |

`napi2native.json` 的 125 条 `version-arch` 记录只覆盖 send/recv 两个 RVA（PacketBackend 用），
与反检测开关无关——不要把它们混为一谈。

## 4. 静态自检怎么判

`probeBypassCompat()` 按开关核对依赖，结果四态：

| 状态 | 含义 | 处理 |
|---|---|---|
| `present` | 依赖全在 | 正常 |
| `partial` | 部分依赖缺失（如 QQ 不再导入某个 API） | 打 WARN，该子能力可能空转 |
| `missing` | 依赖全缺 / 文件找不到 | 打 WARN，开关基本无效 |
| `unknown` | 没有可静态核对的特征（`container`） | 只能靠原生日志 |

设计取舍：

- **只在有开关开启时才扫描**。`QQNT.dll` 有 200 MB+，全关时不做无谓 IO。
- **按 `(路径, size, mtime, 特征)` 缓存**，同一进程内重复请求不重复扫描。
- **任何异常都收敛成 `report.error`**，绝不影响启动——反检测失败可以降级，启动失败不行。

WebUI「反检测」页会显示：本次启动是否真的接管、哪些开关生效、逐开关自检徽标（悬停看缺失项）。

## 5. QQ 换版本后的维护流程

1. **看日志**：搜 `[Bypass]`。出现 `反检测依赖缺失: xxx (missing|partial) -> wrapper.node!Api` 就说明 QQ 改了实现。
2. **重定位导入**（Windows）：

   ```powershell
   node -e "const m=require('./packages/napcat-core/helper/pe-imports.ts');" # TS 需用 vitest 或 tsx 运行
   ```

   仓库内更省事的方式：写一个临时 `.mts` 脚本 `import { parsePeImportsFromFile, flattenImports } from '<repo>/packages/napcat-core/helper/pe-imports.ts'`，
   然后 `flattenImports(parsePeImportsFromFile('<QQ>/versions/<ver>/resources/app/wrapper.node'))`，直接查 API 是否存在。

3. **重定位字符串特征**（`window` / `js`）：

   ```powershell
   # 分块扫描，避免 200MB 一次性进内存
   $fs=[IO.File]::OpenRead($dll); $buf=New-Object byte[] (8MB)
   # 或直接用 helper/bypass-probe.ts 的 scanFileForSignature(file, pattern, 'utf16le'|'ascii')
   ```

   命中即说明目标还在；未命中时先确认是否换了模块（QQ 会把 Chromium/Node 放在 `QQNT.dll`、`flue.dll` 等大文件里），
   再决定改 `BYPASS_STATIC_REQUIREMENTS` 还是让原生模块跟进。

4. **改 `BYPASS_STATIC_REQUIREMENTS`**（`helper/bypass-probe.ts`）：只改依赖表，不改开关语义。
5. **验收**：`pnpm test` 里 `bypassConfig.test.ts` 的守卫会检查「每个开关都有依赖定义」「五平台产物齐全」；
   真机再跑一次，日志应出现 `[Bypass] 反检测已应用: hook=true,...` 且自检全 `present`。

## 6. 排障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| WebUI 显示「napi2native 未加载」 | 原生模块缺失/平台不支持/加载失败 | 看 `Napi2NativeLoader` 日志；确认 `dist/native/napi2native/napi2native.<platform>.node` 存在 |
| 显示「反检测未接管」+ `enableAllBypasses 返回 false` | 原生模块内部部分失败 | 打开 `NAPCAT_ENABLE_VERBOSE_LOG=1` 看 `napi2native_bypass.log` |
| 显示「已通过环境变量禁用」 | `NAPCAT_DISABLE_BYPASS=1` | 去掉环境变量重启 |
| 改了开关没反应 | 开关只在启动时应用 | 重启（WebUI 文案已注明） |
| 自检 `missing` 但日志说已应用 | QQ 改了实现，原生模块还在按旧特征工作 | 按第 5 节重定位，必要时更新原生模块 |

环境变量：

- `NAPCAT_DISABLE_BYPASS=1`：整体跳过反检测（排查"是不是反检测导致的问题"时用）。
- `NAPCAT_ENABLE_VERBOSE_LOG=1`：打开原生模块详细日志。

## 7. 不变量（测试守着，改代码前先看）

`packages/napcat-test/bypassConfig.test.ts` 断言：

1. 随包 `packages/napcat-core/external/napcat.json` 的 `bypass` 键集合 = `BYPASS_KEYS`，且全为布尔、等于默认值。
2. 前端 `napcat_conf.d.ts` 的 `BypassOptions` 键集合 = `BYPASS_KEYS`。
3. `SUPPORTED_BYPASS_PLATFORMS` 里每个平台都有 `napi2native.<platform>.node` 产物且大小合理。
4. 每个开关都在 `BYPASS_STATIC_REQUIREMENTS` 里有依赖定义与非空说明。
5. `applyBypass` 在模块缺失 / 环境变量禁用 / 返回 false / 抛异常四种情况下都只降级、不抛异常。
6. 单字段类型写错只丢该字段，不丢整份配置（历史缺陷回归）。

新增开关的顺序：`BYPASS_KEYS` → `DEFAULT_BYPASS_OPTIONS` → `BypassOptionsSchema` →
`BYPASS_STATIC_REQUIREMENTS` → 前端 `BypassOptions` 与页面 `BYPASS_ITEMS` → 原生模块。
