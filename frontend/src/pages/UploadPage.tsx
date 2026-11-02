import React, { useState, useRef, type DragEvent, type ChangeEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  initUpload,
  uploadDirectToS3,
  finalizeUpload,
  type FinalizeUploadResponse,
  ApiError,
} from '../api';

type UploadState = 'idle' | 'uploading' | 'finalizing' | 'done' | 'failed';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export const UploadPage: React.FC = () => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Expiry Duration
  const [durationValue, setDurationValue] = useState<number>(24);
  const [durationUnit, setDurationUnit] = useState<'minutes' | 'hours' | 'days'>('hours');

  // Max Downloads
  const [maxDownloads, setMaxDownloads] = useState<number>(5);

  // Password
  const [password, setPassword] = useState<string>('');

  // Upload Progress & State
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [bytesUploaded, setBytesUploaded] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Share Result
  const [shareResult, setShareResult] = useState<FinalizeUploadResponse | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<{ abort?: () => void }>({});

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setSelectedFile(e.dataTransfer.files[0]);
      setErrorMessage(null);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
      setErrorMessage(null);
    }
  };

  const handleDurationPresetChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === '10m') {
      setDurationValue(10);
      setDurationUnit('minutes');
    } else if (val === '1h') {
      setDurationValue(1);
      setDurationUnit('hours');
    } else if (val === '12h') {
      setDurationValue(12);
      setDurationUnit('hours');
    } else if (val === '24h') {
      setDurationValue(24);
      setDurationUnit('hours');
    } else if (val === '7d') {
      setDurationValue(7);
      setDurationUnit('days');
    }
  };

  const currentDurationPresetKey = (() => {
    if (durationUnit === 'minutes' && durationValue === 10) return '10m';
    if (durationUnit === 'hours' && durationValue === 1) return '1h';
    if (durationUnit === 'hours' && durationValue === 12) return '12h';
    if (durationUnit === 'hours' && durationValue === 24) return '24h';
    if (durationUnit === 'days' && durationValue === 7) return '7d';
    return '24h';
  })();

  const handleCancelUpload = () => {
    if (cancelRef.current.abort) {
      cancelRef.current.abort();
    }
    setUploadState('idle');
    setUploadProgress(0);
    setBytesUploaded(0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setErrorMessage('Select a file to share.');
      return;
    }

    setErrorMessage(null);
    setUploadState('uploading');
    setUploadProgress(0);
    setBytesUploaded(0);

    try {
      // 1. Init upload session
      const initRes = await initUpload({
        filename: selectedFile.name,
        fileSize: selectedFile.size,
        contentType: selectedFile.type || 'application/octet-stream',
        expiryValue: durationValue,
        expiryUnit: durationUnit,
        maxDownloads: maxDownloads,
        password: password.trim() ? password.trim() : undefined,
      });

      // 2. Direct S3 upload with progress
      await uploadDirectToS3(
        initRes.uploadUrl,
        selectedFile,
        selectedFile.type || 'application/octet-stream',
        (percent, loaded) => {
          setUploadProgress(percent);
          setBytesUploaded(loaded);
        },
        cancelRef.current
      );

      // 3. Finalize upload
      setUploadState('finalizing');
      const finalizeRes = await finalizeUpload(initRes.uploadId);

      setShareResult(finalizeRes);
      setUploadState('done');
    } catch (err: unknown) {
      setUploadState('failed');
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Upload failed. Please check connection and try again.');
      }
    }
  };

  const handleCopyLink = () => {
    if (!shareResult) return;
    const fullUrl = new URL(shareResult.sharePath, window.location.origin).toString();
    navigator.clipboard.writeText(fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    setSelectedFile(null);
    setShareResult(null);
    setUploadState('idle');
    setUploadProgress(0);
    setBytesUploaded(0);
    setErrorMessage(null);
    setPassword('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // --- 1. RESULT SCREEN (Receipt Style) ---
  if (uploadState === 'done' && shareResult) {
    const fullShareUrl = new URL(shareResult.sharePath, window.location.origin).toString();
    const formattedExpires = new Date(shareResult.expiresAt).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    return (
      <div className="space-y-6" data-testid="share-result-screen">
        <div>
          <h1 className="text-2xl sm:text-[26px] font-semibold text-main leading-tight" data-testid="share-ready">
            Link created
          </h1>
          <p className="text-sm text-text-muted mt-1">
            This link is available until it expires or reaches its download limit.
          </p>
        </div>

        <div className="border border-border-default rounded-md bg-surface p-5 space-y-4">
          {/* Share Link Row with mobile break-all / horizontal scroll */}
          <div className="space-y-1.5">
            <label htmlFor="share-link-input" className="text-xs text-text-muted">
              Share link
            </label>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <input
                id="share-link-input"
                type="text"
                readOnly
                value={fullShareUrl}
                data-testid="share-url-input"
                onClick={(e) => e.currentTarget.select()}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full px-2.5 py-2 bg-canvas border border-border-default rounded-sm text-xs text-main font-mono tabular-nums break-all focus:border-border-strong"
              />
              <button
                type="button"
                onClick={handleCopyLink}
                data-testid="copy-link-button"
                className="px-3.5 py-2 border border-border-default bg-surface hover:bg-muted text-main text-xs font-medium rounded-sm whitespace-nowrap transition-colors"
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </div>

          {/* Receipt Rows */}
          <div className="border-t border-border-default pt-3 space-y-2 text-xs">
            <div className="flex justify-between py-1.5 border-b border-border-default/60">
              <span className="text-text-muted">File name</span>
              <span className="text-main font-medium truncate max-w-[280px]">
                {selectedFile?.name || 'Uploaded file'}
              </span>
            </div>
            <div className="flex justify-between py-1.5 border-b border-border-default/60">
              <span className="text-text-muted">File size</span>
              <span className="text-main tabular-nums">
                {selectedFile ? formatBytes(selectedFile.size) : '—'}
              </span>
            </div>
            <div className="flex justify-between py-1.5 border-b border-border-default/60">
              <span className="text-text-muted">Expires</span>
              <span className="text-main">{formattedExpires}</span>
            </div>
            <div className="flex justify-between py-1.5 border-b border-border-default/60">
              <span className="text-text-muted">Downloads allowed</span>
              <span className="text-main tabular-nums">{shareResult.maxDownloads}</span>
            </div>
            <div className="flex justify-between py-1.5">
              <span className="text-text-muted">Password</span>
              <span className="text-main">
                {shareResult.isPasswordProtected ? 'Yes' : 'No'}
              </span>
            </div>
          </div>

          {/* Small Secondary QR Code */}
          <div className="border-t border-border-default pt-4 flex items-center justify-between">
            <span className="text-xs text-text-muted">Scan to open on mobile</span>
            <div className="p-1 bg-white border border-border-default rounded-sm">
              <QRCodeSVG value={fullShareUrl} size={80} level="M" />
            </div>
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={handleReset}
            data-testid="share-another-button"
            className="w-full py-2.5 px-4 border border-border-default bg-surface hover:bg-muted text-xs text-main rounded-sm font-medium transition-colors"
          >
            Share another file
          </button>
        </div>
      </div>
    );
  }

  // --- 2. UPLOAD SCREEN ---
  return (
    <div className="space-y-6">
      {/* Title */}
      <div>
        <h1 className="text-2xl sm:text-[26px] font-semibold text-main leading-tight" data-testid="app-title">
          Share files
        </h1>
        <p className="text-sm text-text-muted mt-1">
          Files are deleted after expiry or download limit.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Compact Drop Area with Stronger Border and Focus Ring */}
        <div
          tabIndex={0}
          role="button"
          aria-label="File upload dropzone"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          data-testid="file-dropzone"
          className={`border-2 border-dashed rounded-md p-6 text-center cursor-pointer transition-colors bg-surface focus:outline-none focus:ring-2 focus:ring-main focus:ring-offset-2 ${
            isDragging
              ? 'border-main bg-muted'
              : 'border-border-default hover:border-border-strong'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileChange}
            className="hidden"
            data-testid="file-input"
          />

          {selectedFile ? (
            <div className="space-y-1">
              <div className="text-sm font-medium text-main truncate max-w-[480px] mx-auto">
                {selectedFile.name}
              </div>
              <div className="text-xs text-text-muted tabular-nums">
                {formatBytes(selectedFile.size)} · click to change
              </div>
            </div>
          ) : (
            <div className="text-sm text-text-muted leading-relaxed">
              Drop file here or <span className="text-main underline font-medium" data-testid="file-browse">browse</span>
            </div>
          )}
        </div>

        {/* Sentence-Style Rule Builder */}
        <div className="border border-border-default rounded-md bg-surface p-4 text-sm text-main space-y-3">
          <div className="leading-relaxed flex flex-wrap items-center gap-2">
            <span>Delete after</span>
            <select
              value={currentDurationPresetKey}
              onChange={handleDurationPresetChange}
              data-testid="duration-select"
              aria-label="Expiry duration"
              className="bg-canvas border border-border-default rounded-sm px-2 py-1 text-xs text-main focus:border-border-strong cursor-pointer"
            >
              <option value="10m">10 minutes</option>
              <option value="1h">1 hour</option>
              <option value="12h">12 hours</option>
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
            </select>
            <span>or</span>
            <input
              type="number"
              min="1"
              max="100"
              value={maxDownloads}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                setMaxDownloads(isNaN(val) ? 1 : Math.max(1, Math.min(100, val)));
              }}
              data-testid="max-downloads-input"
              aria-label="Maximum downloads"
              className="w-16 bg-canvas border border-border-default rounded-sm px-2 py-1 text-xs text-main text-center font-mono tabular-nums focus:border-border-strong"
            />
            <span>download(s).</span>
          </div>

          <div className="pt-2 border-t border-border-default/60 flex items-center gap-2">
            <label htmlFor="password-field" className="text-xs text-text-muted whitespace-nowrap">
              Password:
            </label>
            <input
              id="password-field"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="optional"
              data-testid="password-input"
              className="flex-1 bg-canvas border border-border-default rounded-sm px-2.5 py-1.5 text-xs text-main placeholder:text-text-muted/60 focus:border-border-strong font-mono"
            />
          </div>
        </div>

        {/* Upload Progress & Error Feedback */}
        {uploadState === 'uploading' && (
          <div className="space-y-1.5 pt-1">
            <div className="flex justify-between text-xs text-text-muted">
              <span>Uploading {uploadProgress}%</span>
              <span className="tabular-nums">
                {formatBytes(bytesUploaded)} / {selectedFile ? formatBytes(selectedFile.size) : '—'}
              </span>
            </div>
            <div className="w-full bg-muted h-1 rounded-sm overflow-hidden">
              <div
                className="bg-main h-full transition-all duration-150"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <div className="text-right">
              <button
                type="button"
                onClick={handleCancelUpload}
                className="text-xs text-text-muted hover:text-destructive transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {uploadState === 'finalizing' && (
          <div className="text-xs text-text-muted py-1">Verifying storage...</div>
        )}

        {errorMessage && (
          <div className="text-xs text-destructive py-1" role="alert" data-testid="upload-error">
            {errorMessage}
          </div>
        )}

        {/* Primary Action Button (Near-black background with white text) */}
        <div>
          <button
            type="submit"
            disabled={uploadState === 'uploading' || uploadState === 'finalizing'}
            data-testid="create-link-button"
            className="w-full py-2.5 px-4 bg-main text-canvas hover:opacity-90 rounded-sm text-sm font-medium transition-opacity disabled:opacity-50"
          >
            {uploadState === 'uploading'
              ? 'Uploading...'
              : uploadState === 'finalizing'
              ? 'Verifying...'
              : 'Create link'}
          </button>
        </div>
      </form>
    </div>
  );
};
