// Small stroke icon set (24×24 grid).
const P = {
  chat: 'M4 5h16v11H8l-4 4V5z',
  today: 'M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8a4 4 0 100 8 4 4 0 000-8z',
  tasks: 'M5 5h14v14H5zM8.5 12l2.5 2.5 4.5-5',
  projects: 'M5 4h10a3 3 0 013 3v13H8a3 3 0 01-3-3V4zM5 17a3 3 0 013-3h10',
  memory: 'M7 4h10v16l-5-3.5L7 20V4z',
  files: 'M4 6h6l2 2h8v11H4V6z',
  approvals: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3zM9 12l2 2 4-4',
  settings: 'M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h13M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  clip: 'M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8',
  x: 'M6 6l12 12M18 6L6 18',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  bell: 'M6 16V11a6 6 0 1112 0v5l2 2H4l2-2zM10 20a2 2 0 004 0',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16v4z',
  lock: 'M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z',
  unlock: 'M7 11V8a5 5 0 019.6-2M6 11h12v9H6z',
  refresh: 'M20 12a8 8 0 11-2.3-5.7M20 4v5h-5',
  play: 'M8 5l11 7-11 7V5z',
  pause: 'M8 5v14M16 5v14',
  clock: 'M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  alert: 'M12 4l9 16H3l9-16zM12 10v4M12 17v.5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  calendar: 'M5 6h14v14H5zM5 10h14M9 4v4M15 4v4',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z',
  browser: 'M4 5h16v14H4zM4 9h16M7 7h.01M10 7h.01',
  doc: 'M7 3h7l5 5v13H7V3zM14 3v5h5M10 13h6M10 17h6',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6l1-7z',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM5 20a7 7 0 0114 0',
  pin: 'M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z',
  back: 'M15 6l-6 6 6 6',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  sparkle: 'M12 4l1.8 4.7L18.5 10l-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.3L12 4z',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
};

export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', P[name] || P.sparkle);
  svg.append(path);
  return svg;
}

const TOOL_ICONS = {
  email: 'mail', calendar: 'calendar', browser: 'browser', task: 'tasks', memory: 'memory', document: 'doc', file: 'files',
  schedule: 'clock', reminder: 'clock', briefing: 'today', monitor: 'eye', job: 'clock', project: 'projects', course: 'projects', grade: 'projects', fetch: 'globe', web: 'globe',
};

export function toolIcon(name) {
  const key = Object.keys(TOOL_ICONS).find((k) => name.includes(k));
  return icon(key ? TOOL_ICONS[key] : 'bolt', 15);
}
