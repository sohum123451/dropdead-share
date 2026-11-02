import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  getLinkInfo,
  verifyPassword,
  requestDownload,
  type LinkInfoResponse,
  ApiError,
} from '../api';

type PortalState =
  | 'loading'
  | 'file_ready'
  | 'password_gate'
  | 'not_found'
  | 'expired'
  | 'exhausted';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatCountdown(targetIso: string): {
  text: string;
  isZero: boolean;
  isUnderFiveMinutes: boolean;
  totalMinutes: number;
} {
  const diffMs = new Date(targetIso).getTime() - Date.now();
  if (diffMs <= 0) {
    return { text: '00:00:00', isZero: true, isUnderFiveMinutes: true, totalMinutes: 0 };
  }

  const totalSeconds = Math.floor(diffMs / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number) => n.toString().padStart(2, '0');
  const isUnderFiveMinutes = diffMs < 5 * 60 * 1000;

  if (days > 0) {
    return {
      text: `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`,
      isZero: false,
      isUnderFiveMinutes: false,
      totalMinutes,
    };
  }

  return {
    text: `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`,
    isZero: false,
    isUnderFiveMinutes,
    totalMinutes,
  };
}

function formatLockout(seconds?: number): string {
  if (!seconds || seconds <= 0) return '15 minutes';
  if (seconds >= 60) {
    const mins = Math.ceil(seconds / 60);
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

export const DownloadPage: React.FC = () => {
  const { token } = useParams<{ token: string }>();

  const [state, setState] = useState<PortalState>('loading');
  const [fileInfo, setFileInfo] = useState<LinkInfoResponse | null>(null);

  // Countdown
  const [countdownText, setCountdownText] = useState<string>('');
  const [isUrgent, setIsUrgent] = useState<boolean>(false);
  const [coarseAnnouncement, setCoarseAnnouncement] = useState<string>('');
  const lastAnnouncedMinuteRef = useRef<number | null>(null);

  // Password Gate
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [isLockedOut, setIsLockedOut] = useState<boolean>(false);
  const [downloadGrantToken, setDownloadGrantToken] = useState<string | null>(null);

  // Download Trigger
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [downloadSuccessMessage, setDownloadSuccessMessage] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch link info on mount
  const fetchInfo = useCallback(async () => {
    if (!token) {
      setState('not_found');
      return;
    }

    try {
      const data = await getLinkInfo(token);
      setFileInfo(data);

      if (data.isPasswordProtected && !downloadGrantToken) {
        setState('password_gate');
      } else {
        setState('file_ready');
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.code === 'LINK_NOT_FOUND') {
          setState('not_found');
        } else if (err.code === 'LINK_EXPIRED') {
          setState('expired');
        } else if (err.code === 'DOWNLOADS_EXHAUSTED') {
          setState('exhausted');
        } else if (err.code === 'PASSWORD_REQUIRED') {
          setState('password_gate');
        } else {
          setState('not_found');
        }
      } else {
        setState('not_found');
      }
    }
  }, [token, downloadGrantToken]);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  // Live Countdown Ticker
  useEffect(() => {
    if (state === 'file_ready' && fileInfo?.expiresAt) {
      const updateTimer = () => {
        const { text, isZero, isUnderFiveMinutes, totalMinutes } = formatCountdown(fileInfo.expiresAt);
        setCountdownText(text);
        setIsUrgent(isUnderFiveMinutes);

        // Coarse screen reader announcement (updates once per minute)
        if (lastAnnouncedMinuteRef.current !== totalMinutes) {
          lastAnnouncedMinuteRef.current = totalMinutes;
          if (totalMinutes >= 60) {
            const hrs = Math.floor(totalMinutes / 60);
            setCoarseAnnouncement(`${hrs} hour${hrs === 1 ? '' : 's'} remaining`);
          } else if (totalMinutes > 0) {
            setCoarseAnnouncement(`${totalMinutes} minute${totalMinutes === 1 ? '' : 's'} remaining`);
          } else {
            setCoarseAnnouncement('Less than one minute remaining');
          }
        }

        if (isZero) {
          setState('expired');
          if (timerRef.current) {
            clearInterval(timerRef.current);
          }
        }
      };

      updateTimer();
      timerRef.current = setInterval(updateTimer, 1000);

      return () => {
        if (timerRef.current) {
          clearInterval(timerRef.current);
        }
      };
    }
  }, [state, fileInfo?.expiresAt]);

  // Handle Password Unlock
  const handleVerifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !passwordInput.trim() || isLockedOut) return;

    setIsVerifying(true);
    setPasswordError(null);

    try {
      const result = await verifyPassword(token, passwordInput);
      setDownloadGrantToken(result.downloadGrantToken);
      setState('file_ready');
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.code === 'RATE_LIMITED') {
          setIsLockedOut(true);
          const timeDesc = formatLockout(err.retryAfterSeconds);
          setPasswordError(`Too many attempts. Try again in ${timeDesc}.`);
        } else if (err.code === 'WRONG_PASSWORD') {
          if (err.attemptsLeft !== undefined) {
            setPasswordError(`Incorrect password. ${err.attemptsLeft} attempt${err.attemptsLeft === 1 ? '' : 's'} left.`);
          } else {
            setPasswordError('Incorrect password.');
          }
        } else if (err.code === 'LINK_EXPIRED') {
          setState('expired');
        } else if (err.code === 'DOWNLOADS_EXHAUSTED') {
          setState('exhausted');
        } else {
          setPasswordError(err.message);
        }
      } else {
        setPasswordError('Failed to verify password.');
      }
    } finally {
      setIsVerifying(false);
    }
  };

  // Handle Download Trigger
  const handleDownload = async () => {
    if (!token || isDownloading) return;

    setIsDownloading(true);
    setDownloadSuccessMessage(null);

    try {
      const payload: { password?: string; downloadGrantToken?: string } = {};
      if (downloadGrantToken) {
        payload.downloadGrantToken = downloadGrantToken;
      } else if (passwordInput.trim()) {
        payload.password = passwordInput.trim();
      }

      const res = await requestDownload(token, payload);

      // Trigger browser download via direct pre-signed URL
      const link = document.createElement('a');
      link.href = res.downloadUrl;
      link.setAttribute('download', fileInfo?.filename || 'download');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setDownloadSuccessMessage('Download started.');

      if (res.remainingDownloads <= 0) {
        setState('exhausted');
      } else if (fileInfo) {
        setFileInfo({
          ...fileInfo,
          remainingDownloads: res.remainingDownloads,
        });
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.code === 'DOWNLOADS_EXHAUSTED') {
          setState('exhausted');
        } else if (err.code === 'LINK_EXPIRED') {
          setState('expired');
        } else {
          alert(`Download failed: ${err.message}`);
        }
      } else {
        alert('Download failed. Please try again.');
      }
    } finally {
      setIsDownloading(false);
    }
  };

  // 1. LOADING STATE
  if (state === 'loading') {
    return (
      <div className="py-12 text-sm text-text-muted font-mono" data-testid="state-loading">
        Loading...
      </div>
    );
  }

  // 2. EXHAUSTED STATE
  if (state === 'exhausted') {
    return (
      <div className="space-y-4" data-testid="state-exhausted">
        <div>
          <h1 className="text-2xl sm:text-[26px] font-semibold text-main leading-tight">
            Download limit reached
          </h1>
          <p className="text-sm text-text-muted mt-1 leading-normal">
            This file is no longer available.
          </p>
        </div>
        <div className="pt-2">
          <Link
            to="/"
            className="inline-block px-3.5 py-2 border border-border-default bg-surface hover:bg-muted rounded-sm text-xs font-medium text-main transition-colors"
          >
            Share a file
          </Link>
        </div>
      </div>
    );
  }

  // 3. EXPIRED STATE
  if (state === 'expired') {
    return (
      <div className="space-y-4" data-testid="state-expired">
        <div>
          <h1 className="text-2xl sm:text-[26px] font-semibold text-main leading-tight">
            This link has expired
          </h1>
          <p className="text-sm text-text-muted mt-1 leading-normal">
            The file is no longer available.
          </p>
        </div>
        <div className="pt-2">
          <Link
            to="/"
            className="inline-block px-3.5 py-2 border border-border-default bg-surface hover:bg-muted rounded-sm text-xs font-medium text-main transition-colors"
          >
            Share a file
          </Link>
        </div>
      </div>
    );
  }

  // 4. NOT FOUND STATE
  if (state === 'not_found') {
    return (
      <div className="space-y-4" data-testid="state-not-found">
        <div>
          <h1 className="text-2xl sm:text-[26px] font-semibold text-main leading-tight">
            Link not found
          </h1>
          <p className="text-sm text-text-muted mt-1 leading-normal">
            Check the address, or ask the sender for a new link.
          </p>
        </div>
        <div className="pt-2">
          <Link
            to="/"
            className="inline-block px-3.5 py-2 border border-border-default bg-surface hover:bg-muted rounded-sm text-xs font-medium text-main transition-colors"
          >
            Share a file
          </Link>
        </div>
      </div>
    );
  }

  // 5. PASSWORD GATE STATE
  if (state === 'password_gate') {
    return (
      <div className="space-y-5" data-testid="state-password">
        <div>
          <h1 className="text-2xl sm:text-[26px] font-semibold text-main leading-tight">
            Password required
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Enter the password to access this file.
          </p>
        </div>

        <form onSubmit={handleVerifyPassword} className="space-y-3">
          <div>
            <label htmlFor="gate-password-input" className="sr-only">
              File password
            </label>
            <input
              id="gate-password-input"
              type="password"
              value={passwordInput}
              disabled={isLockedOut}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Enter password..."
              data-testid="gate-password-input"
              className="w-full px-2.5 py-2 bg-canvas border border-border-default rounded-sm text-sm text-main placeholder:text-text-muted/60 focus:border-border-strong font-mono disabled:opacity-60"
            />
          </div>

          {passwordError && (
            <div className="text-xs text-destructive" role="alert" data-testid="password-error">
              {passwordError}
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={isVerifying || !passwordInput.trim() || isLockedOut}
              data-testid="unlock-button"
              className="w-full py-2.5 px-4 bg-main text-canvas hover:opacity-90 rounded-sm text-sm font-medium transition-opacity disabled:opacity-50"
            >
              {isVerifying ? 'Verifying...' : 'Unlock'}
            </button>
          </div>
        </form>
      </div>
    );
  }

  // 6. FILE READY STATE (Main Screen)
  const remainingCount = fileInfo?.remainingDownloads ?? 1;

  return (
    <div className="space-y-6" data-testid="state-ready">
      {/* File Details Header */}
      <div>
        <h1 className="text-2xl sm:text-[26px] font-semibold text-main leading-tight truncate">
          {fileInfo?.filename || 'File ready'}
        </h1>
        <p className="text-sm text-text-muted mt-1 tabular-nums">
          {fileInfo ? formatBytes(fileInfo.fileSize) : '—'}
        </p>
      </div>

      <div className="border border-border-default rounded-md bg-surface p-5 space-y-6">
        {/* Countdown - Main Visual Element */}
        <div className="py-4 text-center space-y-1">
          <div className="text-xs text-text-muted font-mono tracking-wider uppercase">
            Time remaining
          </div>
          <div
            aria-hidden="true"
            data-testid="countdown-display"
            className={`text-3xl sm:text-4xl font-semibold tracking-tight font-mono tabular-nums ${
              isUrgent ? 'text-accent' : 'text-main'
            }`}
          >
            {countdownText || '00:00:00'}
          </div>
          {/* Coarse Announcement for Screen Readers */}
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {coarseAnnouncement}
          </div>
        </div>

        {/* Downloads Remaining Row */}
        <div className="border-t border-border-default pt-3 flex justify-between items-center text-xs text-text-muted">
          <span>Downloads remaining</span>
          <span className="text-main font-medium tabular-nums">
            {remainingCount} download{remainingCount === 1 ? '' : 's'} left
          </span>
        </div>

        {/* Download Action Button (Near-black with white text) */}
        <div>
          <button
            type="button"
            onClick={handleDownload}
            disabled={isDownloading}
            data-testid="download-button"
            className="w-full py-2.5 px-4 bg-main text-canvas hover:opacity-90 rounded-sm text-sm font-medium transition-opacity disabled:opacity-50"
          >
            {isDownloading ? 'Preparing...' : 'Download'}
          </button>
          {downloadSuccessMessage && (
            <p className="text-xs text-text-muted mt-2 text-center">{downloadSuccessMessage}</p>
          )}
        </div>
      </div>
    </div>
  );
};
