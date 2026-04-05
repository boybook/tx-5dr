import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Tab, Tabs } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faKey, faLock, faUser } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../store/authStore';

export type AuthLoginMethod = 'token' | 'password';

interface AuthLoginFormProps {
  initialMethod?: AuthLoginMethod;
  compact?: boolean;
  autoFocus?: boolean;
  onSuccess?: () => void;
}

export function AuthLoginForm({
  initialMethod = 'token',
  compact = false,
  autoFocus = false,
  onSuccess,
}: AuthLoginFormProps) {
  const { t } = useTranslation();
  const { state, dispatch, login, loginWithPassword } = useAuth();
  const [method, setMethod] = useState<AuthLoginMethod>(initialMethod);
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const inputSize = compact ? 'sm' : 'md';

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_LOGIN_ERROR' });
  }, [dispatch]);

  useEffect(() => {
    clearError();
  }, [method, clearError]);

  const canSubmit = useMemo(() => {
    if (method === 'token') {
      return token.trim().length > 0;
    }
    return username.trim().length > 0 && password.length > 0;
  }, [method, password.length, token, username]);

  const handleSubmit = useCallback(async () => {
    let success = false;
    if (method === 'token') {
      success = await login(token.trim());
      if (success) {
        setToken('');
      }
    } else {
      success = await loginWithPassword(username.trim(), password);
      if (success) {
        setUsername('');
        setPassword('');
      }
    }

    if (success) {
      clearError();
      onSuccess?.();
    }
  }, [clearError, login, loginWithPassword, method, onSuccess, password, token, username]);

  const handleTokenKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && token.trim()) {
      void handleSubmit();
    }
  }, [handleSubmit, token]);

  const handlePasswordKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && username.trim() && password) {
      void handleSubmit();
    }
  }, [handleSubmit, password, username]);

  return (
    <div className="flex flex-col gap-3">
      <Tabs
        size={compact ? 'sm' : 'md'}
        selectedKey={method}
        onSelectionChange={(key) => setMethod(key as AuthLoginMethod)}
        fullWidth
      >
        <Tab key="token" title={t('auth:login.methods.token')} />
        <Tab key="password" title={t('auth:login.methods.password')} />
      </Tabs>

      {method === 'token' ? (
        <Input
          size={inputSize}
          label={t('auth:login.tokenLabel')}
          placeholder={t('auth:login.tokenPlaceholder')}
          type="password"
          value={token}
          onValueChange={(value) => {
            setToken(value);
            if (state.loginError) clearError();
          }}
          onKeyDown={handleTokenKeyDown}
          isDisabled={state.loginLoading}
          autoFocus={autoFocus}
          startContent={<FontAwesomeIcon icon={faKey} className="text-default-400" />}
          variant="bordered"
        />
      ) : (
        <>
          <Input
            size={inputSize}
            label={t('auth:login.usernameLabel')}
            placeholder={t('auth:login.usernamePlaceholder')}
            value={username}
            onValueChange={(value) => {
              setUsername(value);
              if (state.loginError) clearError();
            }}
            isDisabled={state.loginLoading}
            autoFocus={autoFocus}
            startContent={<FontAwesomeIcon icon={faUser} className="text-default-400" />}
            variant="bordered"
          />
          <Input
            size={inputSize}
            label={t('auth:login.passwordLabel')}
            placeholder={t('auth:login.passwordPlaceholder')}
            type="password"
            value={password}
            onValueChange={(value) => {
              setPassword(value);
              if (state.loginError) clearError();
            }}
            onKeyDown={handlePasswordKeyDown}
            isDisabled={state.loginLoading}
            startContent={<FontAwesomeIcon icon={faLock} className="text-default-400" />}
            variant="bordered"
          />
        </>
      )}

      {state.loginError && (
        <p className="text-danger text-sm">{state.loginError}</p>
      )}

      <Button
        color="primary"
        fullWidth
        isLoading={state.loginLoading}
        isDisabled={!canSubmit}
        onPress={() => void handleSubmit()}
      >
        {method === 'token' ? t('auth:login.submitToken') : t('auth:login.submitPassword')}
      </Button>
    </div>
  );
}
