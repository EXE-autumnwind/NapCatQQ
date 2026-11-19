import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Button } from '@heroui/button';
import toast from 'react-hot-toast';

import SaveButtons from '@/components/button/save_buttons';
import PageLoading from '@/components/page_loading';
import SwitchCard from '@/components/switch_card';

import QQManager from '@/controllers/qq_manager';

interface BypassFormData {
  hook: boolean;
  window: boolean;
  module: boolean;
  process: boolean;
  container: boolean;
  js: boolean;
  o3HookMode: boolean;
}

const BYPASS_ITEMS: { key: keyof BypassOptions; label: string; description: string; }[] = [
  { key: 'hook', label: 'Hook', description: 'hook特征隐藏' },
  { key: 'window', label: 'Window', description: '窗口伪造' },
  { key: 'module', label: 'Module', description: '加载模块隐藏' },
  { key: 'process', label: 'Process', description: '进程反检测' },
  { key: 'container', label: 'Container', description: '容器反检测' },
  { key: 'js', label: 'JS', description: 'JS反检测' },
];

const PROBE_STYLE: Record<BypassProbeState, { text: string; className: string; }> = {
  present: { text: '依赖就绪', className: 'bg-success-100 text-success-700 border-success-200' },
  partial: { text: '部分依赖缺失', className: 'bg-warning-100 text-warning-700 border-warning-200' },
  missing: { text: '依赖缺失', className: 'bg-danger-100 text-danger-700 border-danger-200' },
  unknown: { text: '无法静态核对', className: 'bg-default-100 text-default-600 border-default-200' },
};

const BypassConfigCard = () => {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<BypassStatusPayload | null>(null);
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
    setValue,
  } = useForm<BypassFormData>();

  const loadConfig = async (showTip = false) => {
    try {
      setLoading(true);
      const config = await QQManager.getNapCatConfig();
      const bypass = (config.bypass ?? {}) as Partial<BypassOptions>;
      setValue('hook', bypass.hook ?? false);
      setValue('window', bypass.window ?? false);
      setValue('module', bypass.module ?? false);
      setValue('process', bypass.process ?? false);
      setValue('container', bypass.container ?? false);
      setValue('js', bypass.js ?? false);
      setValue('o3HookMode', config.o3HookMode === 1);
      // 状态接口失败不影响配置编辑
      try {
        setStatus(await QQManager.getBypassStatus());
      } catch {
        setStatus(null);
      }
      if (showTip) toast.success('刷新成功');
    } catch (error) {
      const msg = (error as Error).message;
      toast.error(`获取配置失败: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = handleSubmit(async (data) => {
    try {
      const { o3HookMode, ...bypass } = data;
      await QQManager.setNapCatConfig({ bypass, o3HookMode: o3HookMode ? 1 : 0 });
      toast.success('保存成功，重启后生效');
      await loadConfig();
    } catch (error) {
      const msg = (error as Error).message;
      toast.error(`保存失败: ${msg}`);
    }
  });

  const onReset = () => {
    loadConfig();
  };

  const onRefresh = async () => {
    await loadConfig(true);
  };

  const setAll = (value: boolean) => {
    for (const item of BYPASS_ITEMS) setValue(item.key, value);
  };

  useEffect(() => {
    loadConfig();
  }, []);

  if (loading) return <PageLoading loading />;

  const runtime = status?.status ?? null;
  const probe = status?.probe ?? null;

  const banner = (() => {
    if (status?.disabledByEnv) {
      return {
        className: 'border-warning-200 bg-warning-50 text-warning-700',
        title: '反检测已通过环境变量禁用',
        detail: '检测到 NAPCAT_DISABLE_BYPASS=1，本次启动不会应用任何反检测开关。',
      };
    }
    if (!status) {
      return {
        className: 'border-default-200 bg-default-50 text-default-600',
        title: '未取到运行状态',
        detail: '状态接口不可用（登录前或后端未就绪），下面只显示配置文件里的开关。',
      };
    }
    if (!status.platformSupported) {
      return {
        className: 'border-danger-200 bg-danger-50 text-danger-700',
        title: `当前平台 ${status.platform} 没有反检测实现`,
        detail: 'napi2native 未提供该平台产物，开关保存后不会生效。',
      };
    }
    if (!runtime) {
      return {
        className: 'border-default-200 bg-default-50 text-default-600',
        title: '本次启动尚未应用反检测',
        detail: '状态会在登录前初始化完成后写入；若长期为空，请检查日志里的 [Bypass] 行。',
      };
    }
    if (!runtime.moduleLoaded) {
      return {
        className: 'border-danger-200 bg-danger-50 text-danger-700',
        title: 'napi2native 未加载',
        detail: `反检测未生效：${runtime.error ?? '原生模块缺失或加载失败'}。请确认 packages/napcat-native/napi2native 随包发布。`,
      };
    }
    if (!runtime.applied) {
      return {
        className: 'border-warning-200 bg-warning-50 text-warning-700',
        title: '反检测未接管',
        detail: `原生模块返回未生效：${runtime.error ?? '未知原因'}。`,
      };
    }
    return {
      className: 'border-success-200 bg-success-50 text-success-700',
      title: '反检测已生效',
      detail: `本次启动已接管：${Object.entries(runtime.effective)
        .filter(([, enabled]) => enabled)
        .map(([key]) => key)
        .join(', ') || '（无开启项）'}。修改开关需重启生效。`,
    };
  })();

  return (
    <>
      <title>反检测配置 - NapCat WebUI</title>
      <div className='flex flex-col gap-1 mb-2'>
        <h3 className='text-lg font-semibold text-default-700'>反检测开关配置</h3>
        <p className='text-sm text-default-500'>
          控制 Napi2Native 模块的各项反检测功能，修改后需重启生效。
        </p>
      </div>

      <div className={`mb-3 rounded-xl border px-4 py-3 text-sm ${banner.className}`}>
        <p className='font-medium'>{banner.title}</p>
        <p className='mt-1 opacity-90 break-all'>{banner.detail}</p>
        {probe && (
          <p className='mt-1 opacity-80 break-all'>
            静态自检：QQ {probe.platform} · wrapper.node 导入 {probe.wrapperImports?.apis ?? 0} 个 API
            {probe.error ? ` · ${probe.error}` : ''}
          </p>
        )}
      </div>

      <div className='mb-3 flex flex-wrap items-center gap-2'>
        <Button size='sm' variant='flat' onPress={() => setAll(true)}>全部开启</Button>
        <Button size='sm' variant='flat' onPress={() => setAll(false)}>全部关闭</Button>
        {BYPASS_ITEMS.map((item) => {
          const switchProbe = probe?.switches?.[item.key];
          if (!switchProbe) return null;
          const style = PROBE_STYLE[switchProbe.state];
          return (
            <span
              key={item.key}
              title={switchProbe.missing.length > 0 ? `缺失: ${switchProbe.missing.join(', ')}` : switchProbe.detail}
              className={`rounded-full border px-2 py-0.5 text-tiny ${style.className}`}
            >
              {item.key} · {style.text}
            </span>
          );
        })}
      </div>

      <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3'>
        {BYPASS_ITEMS.map((item) => (
          <Controller
            key={item.key}
            control={control}
            name={item.key}
            render={({ field }) => (
              <SwitchCard
                {...field}
                label={item.label}
                description={item.description}
              />
            )}
          />
        ))}
        <Controller
          control={control}
          name='o3HookMode'
          render={({ field }) => (
            <SwitchCard
              {...field}
              label='o3HookMode'
              description='O3 Hook 模式'
            />
          )}
        />
      </div>
      <SaveButtons
        onSubmit={onSubmit}
        reset={onReset}
        isSubmitting={isSubmitting}
        refresh={onRefresh}
      />
    </>
  );
};

export default BypassConfigCard;
