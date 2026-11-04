import { Chip, Popover, PopoverContent, PopoverTrigger } from '@heroui/react';
import type { PluginStatus } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

/** The status snapshot carries its own evidence; opening it does not depend on log history. */
export function PluginAutoDisableDetails({ plugin }: { plugin: PluginStatus }) {
  const { t } = useTranslation('settings');
  const info = plugin.autoDisableInfo;

  return (
    <Popover placement="bottom-end" showArrow>
      <PopoverTrigger>
        <button
          type="button"
          aria-label={t('plugins.disableDetailsAction')}
          className="rounded-full outline-none transition-opacity hover:opacity-75 focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2"
        >
          <Chip as="span" size="sm" variant="dot" color="danger" className="text-xs cursor-pointer">
            <span className="underline decoration-dotted underline-offset-2">
              {t('plugins.statusAutoDisabled')}
            </span>
          </Chip>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(26rem,calc(100vw-2rem))] items-stretch p-4">
        <div className="space-y-3 text-sm">
          <div>
            <h3 className="font-semibold text-danger">{t('plugins.disableDetailsTitle')}</h3>
            <p className="mt-1 text-xs text-default-500">{plugin.name} · v{plugin.version}</p>
          </div>
          {info && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              <dt className="text-default-500">{t('plugins.disableReason')}</dt>
              <dd>{t(`plugins.disableReasons.${info.reason}`)}</dd>
              <dt className="text-default-500">{t('plugins.disableTime')}</dt>
              <dd><time dateTime={new Date(info.timestamp).toISOString()}>{new Date(info.timestamp).toLocaleString()}</time></dd>
              <dt className="text-default-500">{t('plugins.disableOperation')}</dt>
              <dd className="break-all font-mono">{info.operation}</dd>
              {info.operatorId && <>
                <dt className="text-default-500">{t('plugins.disableOperator')}</dt>
                <dd className="break-all">{info.operatorId}</dd>
              </>}
            </dl>
          )}
          <div>
            <h4 className="mb-2 text-xs font-medium">{t('plugins.disableErrors')}</h4>
            {info && info.errors.length > 0 ? (
              <ol className="max-h-60 space-y-2 overflow-y-auto overscroll-contain">
                {[...info.errors].reverse().map((error, index) => (
                  <li key={`${error.timestamp}:${index}`} className="rounded-lg bg-default-100 p-2 text-xs">
                    <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-default-500">
                      <span>{t('plugins.disableErrorNumber', { number: info.errors.length - index })}</span>
                      <time dateTime={new Date(error.timestamp).toISOString()}>{new Date(error.timestamp).toLocaleString()}</time>
                      {index === 0 && (
                        <span className="font-medium text-danger">{t('plugins.disableTrigger')}</span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap break-words font-mono select-text">{error.message}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-default-100 p-2 text-xs select-text">
                {info?.message || plugin.lastError || t('plugins.disableDetailsUnavailable')}
              </p>
            )}
          </div>
          <p className="border-t border-default-200 pt-3 text-xs leading-relaxed text-default-500">
            {t('plugins.disableRecoveryHint')}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
