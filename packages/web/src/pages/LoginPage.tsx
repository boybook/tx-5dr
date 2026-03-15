import React, { useState, useCallback } from 'react';
import { Card, CardBody, CardHeader, Input, Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faKey } from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../store/authStore';

export function LoginPage() {
  const { login, state } = useAuth();
  const [token, setToken] = useState('');

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
          <p className="text-default-500 text-sm">数字电台远程控制</p>
        </CardHeader>
        <CardBody className="gap-4 px-8 pb-8">
          <Input
            label="访问令牌"
            placeholder="粘贴令牌..."
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
            登录
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
