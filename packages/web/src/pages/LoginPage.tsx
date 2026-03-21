import React, { useState, useCallback } from 'react';
import { Card, CardBody, CardHeader, Input, Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faKey, faChevronRight, faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../store/authStore';
import { useTranslation } from 'react-i18next';

export function LoginPage() {
  const { t } = useTranslation();
  const { login, state } = useAuth();
  const [token, setToken] = useState('');
  const [helpExpanded, setHelpExpanded] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!token.trim()) return;
    await login(token.trim());
  }, [token, login]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  }, [handleSubmit]);

  return (
    <div className="h-screen w-full flex items-center justify-center bg-default-50">
      <Card className="w-full max-w-md mx-4">
        <CardHeader className="flex flex-col items-center gap-2 pt-8 pb-2">
          <h1 className="text-2xl font-bold">TX-5DR</h1>
          <p className="text-default-500 text-sm">{t('auth:loginPage.subtitle')}</p>
        </CardHeader>
        <CardBody className="gap-4 px-8 pb-8">
          <Input
            label={t('auth:loginPage.tokenLabel')}
            placeholder={t('auth:loginPage.tokenPlaceholder')}
            type="password"
            variant="bordered"
            value={token}
            onValueChange={setToken}
            onKeyDown={handleKeyDown}
            startContent={<FontAwesomeIcon icon={faKey} className="text-default-400" />}
            isDisabled={state.loginLoading}
            autoFocus
          />

          {state.loginError && (
            <p className="text-danger text-sm">{state.loginError}</p>
          )}

          <Button
            color="primary"
            variant="solid"
            fullWidth
            isLoading={state.loginLoading}
            onPress={handleSubmit}
            isDisabled={!token.trim()}
          >
            {t('auth:loginPage.submit')}
          </Button>

          {/* 折叠式帮助文字 */}
          <div className="mt-1">
            <button
              type="button"
              className="text-xs text-default-400 hover:text-default-500 transition-colors flex items-center gap-1 cursor-pointer"
              onClick={() => setHelpExpanded(!helpExpanded)}
            >
              <FontAwesomeIcon
                icon={helpExpanded ? faChevronDown : faChevronRight}
                className="text-[10px]"
              />
              {t('auth:loginPage.helpTitle')}
            </button>
            {helpExpanded && (
              <p className="text-xs text-default-400 mt-1.5 pl-3.5 leading-relaxed">
                {t('auth:loginPage.helpContent')}
              </p>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
