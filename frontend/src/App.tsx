import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { UploadPage } from './pages/UploadPage';
import { DownloadPage } from './pages/DownloadPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { getApiBaseUrl } from './api';

export function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <div className="min-h-screen bg-canvas text-main font-sans selection:bg-main selection:text-canvas">
          <div className="w-full max-w-[560px] mx-auto px-5 py-6 flex flex-col min-h-screen text-left">
            <Navbar />
            <main className="flex-1 pt-16 pb-12">
              <Routes>
                <Route path="/" element={<UploadPage />} />
                <Route path="/d/:token" element={<DownloadPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </main>
            {import.meta.env.DEV && (
              <footer className="pt-4 pb-2 border-t border-border-default/50 text-[11px] text-text-muted font-mono">
                API: {getApiBaseUrl() || 'same-origin'}
              </footer>
            )}
          </div>
        </div>
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
