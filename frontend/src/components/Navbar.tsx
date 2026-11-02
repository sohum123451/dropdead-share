import React from 'react';
import { Link } from 'react-router-dom';

export const Navbar: React.FC = () => {
  return (
    <header className="py-2">
      <Link
        to="/"
        className="text-base font-semibold tracking-tight text-main hover:opacity-80 transition-opacity"
      >
        DropDead
      </Link>
    </header>
  );
};
