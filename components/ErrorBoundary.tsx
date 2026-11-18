import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Error inesperado en la interfaz.',
    };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="max-w-2xl mx-auto my-12 p-6 bg-white border border-red-200 rounded-xl shadow-sm">
          <h2 className="text-lg font-semibold text-red-800">
            Se produjo un error en el espacio de trabajo
          </h2>
          <p className="mt-2 text-sm text-slate-600 break-words">{this.state.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, message: '' })}
            className="mt-4 px-4 py-2 text-sm font-medium bg-purple-700 text-white rounded-lg hover:bg-purple-800 transition-colors"
          >
            Reintentar vista
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
