/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--bg-canvas)',
        surface: 'var(--bg-surface)',
        muted: 'var(--bg-muted)',
        subtle: 'var(--bg-subtle)',
        main: 'var(--text-main)',
        'text-muted': 'var(--text-muted)',
        faint: 'var(--text-faint)',
        'border-default': 'var(--border-default)',
        'border-strong': 'var(--border-strong)',
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          fg: 'var(--accent-fg)',
        },
        destructive: 'var(--destructive)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
      },
    },
  },
  plugins: [],
}
