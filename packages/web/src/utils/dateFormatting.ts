import i18n from '../i18n/index';

function getLocale(): string {
  return i18n.language === 'zh' ? 'zh-CN' : 'en-US';
}

export function formatDateTime(date: string | number | Date): string {
  return new Date(date).toLocaleString(getLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDate(date: string | number | Date): string {
  return new Date(date).toLocaleDateString(getLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function formatTime(date: string | number | Date): string {
  return new Date(date).toLocaleTimeString(getLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
