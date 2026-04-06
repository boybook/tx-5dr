import React from 'react';
import { Button } from '@heroui/react';
import i18n from '../../i18n';
import { createLogger } from '../../utils/logger';

const logger = createLogger('AppErrorBoundary');

interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    logger.error('Application subtree crashed', {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background px-6">
        <div className="max-w-md w-full rounded-2xl border border-default-200 bg-content1 p-6 shadow-lg text-center">
          <h1 className="text-xl font-semibold text-foreground">
            {i18n.t('common:appError.title')}
          </h1>
          <p className="mt-3 text-sm text-default-500">
            {i18n.t('common:appError.description')}
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Button color="primary" onPress={this.handleRetry}>
              {i18n.t('common:appError.retry')}
            </Button>
            <Button variant="flat" onPress={() => window.location.reload()}>
              {i18n.t('common:appError.refresh')}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
