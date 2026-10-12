const PATHS = {
  undo: <path d="M7 4 3 8l4 4M3.5 8H11a4 4 0 0 1 0 8H8" />,
  redo: <path d="M13 4l4 4-4 4M16.5 8H9a4 4 0 0 0 0 8h3" />,
  sun: <><circle cx="10" cy="10" r="3.5" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" /></>,
  moon: <path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z" />,
  auto: <><circle cx="10" cy="10" r="6.5" /><path d="M10 3.5v13a6.5 6.5 0 0 0 0-13z" fill="currentColor" /></>,
  sidebar: <><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M3.8 4.8h3.4v10.4H3.8z" fill="currentColor" stroke="none" /></>,
  editor: <><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M7.5 4.8h5v10.4h-5z" fill="currentColor" stroke="none" /></>,
  preview: <><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M12.8 4.8h3.4v10.4h-3.4z" fill="currentColor" stroke="none" /></>,
  detach: <path d="M11 4h5v5M16 4l-6.5 6.5M8 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V12" />,
  attach: <path d="M14.5 10.5h-5v-5M9.5 10.5 16 4M8 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V13" />,
};

export function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
      {PATHS[name]}
    </svg>
  );
}
