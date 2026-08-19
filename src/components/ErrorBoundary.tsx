import React, { ErrorInfo, ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import * as Sentry from '@sentry/react';

interface Props {
  fallbackTitle?: string;
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({ errorInfo });
    try {
      Sentry.captureException(error, { extra: { componentStack: errorInfo.componentStack } });
    } catch (e) {
      console.warn("Failed to report caught crash to Sentry:", e);
    }
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 max-w-xl mx-auto my-8 bg-red-50 border border-red-200 rounded-3xl shadow-md space-y-4">
          <div className="flex items-center space-x-3 text-red-700">
            <AlertCircle className="w-8 h-8 shrink-0" />
            <div>
              <h2 className="text-lg font-extrabold">
                {this.props.fallbackTitle || 'A System Crash Has Occurred'}
              </h2>
              <p className="text-xs text-red-600">The application encountered a runtime exception.</p>
            </div>
          </div>
          <div className="p-4 bg-stone-900 text-red-400 rounded-2xl text-xs font-mono overflow-auto max-h-60 space-y-2">
            <p className="font-extrabold">{this.state.error?.toString()}</p>
            {this.state.errorInfo && (
              <pre className="text-[10px] leading-tight whitespace-pre-wrap">
                {this.state.errorInfo.componentStack}
              </pre>
            )}
          </div>
          <button
            onClick={() => window.location.reload()}
            className="w-full bg-red-700 hover:bg-red-800 text-white py-2.5 rounded-xl text-xs font-bold transition"
          >
            Reload Application
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
