import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardBody, CardHeader, Chip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import dependencies from '../../data/dependencies.json';
import { openExternal } from '../../utils/openExternal';

type DependencyCategory = 'frontend' | 'backend' | 'electron' | 'protocol' | 'tools';

interface Dependency {
  name: string;
  version: string;
  license: string;
  url: string;
  category: DependencyCategory;
}

const CATEGORY_ORDER: DependencyCategory[] = [
  'frontend',
  'backend',
  'electron',
  'protocol',
  'tools',
];

function isCopyleftLicense(license: string): boolean {
  const upper = license.toUpperCase();
  return upper.startsWith('GPL') || upper.startsWith('LGPL') || upper.startsWith('MPL');
}

export const DependencyList: React.FC = () => {
  const { t } = useTranslation('about');

  const grouped = useMemo(() => {
    const result: Record<DependencyCategory, Dependency[]> = {
      frontend: [],
      backend: [],
      electron: [],
      protocol: [],
      tools: [],
    };
    for (const dep of dependencies as Dependency[]) {
      result[dep.category]?.push(dep);
    }
    return result;
  }, []);

  return (
    <Card shadow="none">
      <CardHeader className="flex flex-col items-start gap-1 px-6 pt-5 pb-2">
        <h2 className="text-lg font-semibold text-foreground">
          {t('dependencies.title')}
        </h2>
        <p className="text-xs text-default-500">{t('dependencies.subtitle')}</p>
      </CardHeader>
      <CardBody className="gap-5 px-6 pb-5">
        {CATEGORY_ORDER.map((cat) => {
          const items = grouped[cat];
          if (!items || items.length === 0) return null;
          return (
            <div key={cat} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-default-700 uppercase tracking-wide">
                {t(`dependencies.category.${cat}`)}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {items.map((dep) => (
                  <li
                    key={`${cat}-${dep.name}`}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <a
                      href={dep.url}
                      onClick={(e) => {
                        e.preventDefault();
                        openExternal(dep.url);
                      }}
                      className="text-primary hover:underline cursor-pointer inline-flex items-center gap-1"
                    >
                      {dep.name}
                      <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="text-xs opacity-60" />
                    </a>
                    {dep.version && dep.version !== '—' && (
                      <span className="text-default-400 text-xs">@{dep.version}</span>
                    )}
                    <Chip
                      size="sm"
                      variant="flat"
                      color={isCopyleftLicense(dep.license) ? 'warning' : 'default'}
                    >
                      {dep.license}
                    </Chip>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
};
