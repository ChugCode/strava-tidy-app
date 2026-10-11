// Pure helpers for naming and sharing the tidied file (testable without a browser).

/** "<original base name>-tidied<extension>", e.g. exercise_tcx_file.tcx -> exercise_tcx_file-tidied.tcx */
export function outputFileName(originalName, extension) {
  const base = (originalName || '').replace(/\.[^./\\]+$/, '') || 'activity';
  return `${base}-tidied${extension}`;
}

/**
 * Returns a File that navigatorLike.canShare accepts, or null. Tries the real mime type first, then
 * application/octet-stream (some browsers refuse to share TCX by its own type).
 */
export function pickShareFile(text, name, mimeType, navigatorLike) {
  if (!navigatorLike || typeof navigatorLike.canShare !== 'function') return null;
  for (const type of [mimeType, 'application/octet-stream']) {
    try {
      const file = new File([text], name, { type });
      if (navigatorLike.canShare({ files: [file] })) return file;
    } catch { /* try the next type */ }
  }
  return null;
}

/** True when the page was opened by the service worker after a Web Share Target POST. */
export function parseSharedFlag(search) {
  try {
    return new URLSearchParams(search || '').get('shared') === '1';
  } catch {
    return false;
  }
}
