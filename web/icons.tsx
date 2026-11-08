import type { ReactNode } from "react";

const paths = {
  tasks: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" />
    </>
  ),
  sessions: (
    <>
      <rect x="2" y="3" width="12" height="10" />
      <path d="m4.5 6.5 2 1.5-2 1.5M8 10h3.5" />
    </>
  ),
  artifacts: (
    <>
      <path d="M3 2h7l3 3v9H3zM10 2v3h3" />
    </>
  ),
  history: (
    <>
      <circle cx="5" cy="4" r="1.6" />
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="11" cy="7" r="1.6" />
      <path d="M5 5.6v4.8M11 8.6c0 2-2 2.4-4.4 3" />
    </>
  ),
  activity: <path d="M1.5 8h3l2-5 3 10 2-5h3" />,
  approvals: (
    <path d="m8 1.8 5.2 2v4.3c0 3-2.3 5.1-5.2 6.1-2.9-1-5.2-3.1-5.2-6.1V3.8zM5.6 8l1.7 1.7 3.2-3.4" />
  ),
  connections: (
    <path d="m6 10 4-4M7 4.5l1.3-1.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.3 1.3a2.5 2.5 0 0 1-3.5-3.5L5.5 8" />
  ),
  settings: (
    <>
      <path d="M2 4h12M2 8h12M2 12h12" />
      <path d="M5 2v4M11 6v4M7 10v4" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </>
  ),
  panel: (
    <>
      <rect x="2" y="3" width="12" height="10" />
      <path d="M6 3v10m4.5-6.5L9 8l1.5 1.5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  html: <path d="M5.5 4.5 2 8l3.5 3.5m5-7L14 8l-3.5 3.5" />,
  diff: <path d="M5 2v6M2 5h6M2 12h6M10 3h4M10 13h4" />,
  files: <path d="M2 4h4l1.5 1.5H14V13H2z" />,
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof paths;
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="square"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
