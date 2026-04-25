import React from 'react';
import { Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotateRight, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
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
      <div className="min-h-screen w-full flex items-center justify-center bg-background px-6 py-10">
        <div className="flex w-full max-w-lg flex-col items-center gap-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-danger-50">
            <FontAwesomeIcon icon={faTriangleExclamation} className="text-3xl text-danger" />
          </div>

          <div className="space-y-2">
            <h1 className="text-xl font-semibold text-foreground">
              {i18n.t('common:appError.title')}
            </h1>
            <p className="mx-auto max-w-md text-sm leading-6 text-default-500">
              {i18n.t('common:appError.description')}
            </p>
          </div>

          <div className="flex w-full max-w-xs flex-col gap-3 sm:max-w-none sm:flex-row sm:justify-center">
            <Button
              color="primary"
              variant="flat"
              startContent={<FontAwesomeIcon icon={faRotateRight} />}
              onPress={this.handleRetry}
            >
              {i18n.t('common:appError.retry')}
            </Button>
            <Button variant="light" onPress={() => window.location.reload()}>
              {i18n.t('common:appError.refresh')}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
