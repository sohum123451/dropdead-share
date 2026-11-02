import React from 'react';
import { Link } from 'react-router-dom';

export const NotFoundPage: React.FC = () => {
  return (
    <div className="space-y-4">
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
};
