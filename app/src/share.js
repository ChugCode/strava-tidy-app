// Pure helpers for naming and sharing the tidied file (testable without a browser).

/** "<original base name>-tidied<extension>", e.g. exercise_tcx_file.tcx -> exercise_tcx_file-tidied.tcx */
export function outputFileName(originalName, extension) {
  const base = (originalName || '').replace(/\.[^./\\]+$/, '') || 'activity';
  return `${base}-tidied${extension}`;
}

/** True when the page was opened by the service worker after a Web Share Target POST. */
export function parseSharedFlag(search) {
  try {
    return new URLSearchParams(search || '').get('shared') === '1';
  } catch {
    return false;
  }
}
