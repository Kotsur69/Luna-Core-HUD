// ============================================================================
// LunaCore - image lightbox (Luna's Work screenshots, Electron HUD and phone)
// ----------------------------------------------------------------------------
// openLightbox() shows one image large over a dark backdrop, fitted to the
// viewport. It closes on a backdrop click, the close button and Escape, and
// hands focus back to what had it. No dependencies on purpose: the phone app
// (mobile/) imports this same file. The caller owns the strings and the CSS
// (.lw-lightbox*), and the src is whatever the caller already shows as a
// thumbnail (a data: URL), so the CSP img-src is untouched.
// ============================================================================

'use strict';

/** Does this keydown key close the lightbox? */
export function isCloseKey(key) {
  return key === 'Escape' || key === 'Esc';
}

/**
 * @param {{src:string, alt?:string, closeLabel?:string, closeOnImageClick?:boolean}} opts
 * @returns {() => void} close function (no-op when already closed)
 */
export function openLightbox({ src, alt = '', closeLabel = 'Close', closeOnImageClick = false }) {
  if (typeof src !== 'string' || !src.startsWith('data:image/')) return () => {};
  const opener = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'lw-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', alt);

  const img = document.createElement('img');
  img.className = 'lw-lightbox__img';
  img.src = src;
  img.alt = alt;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lw-lightbox__close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', closeLabel);
  closeBtn.title = closeLabel;

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (opener && typeof opener.focus === 'function') opener.focus();
  }
  function onKey(e) {
    if (!isCloseKey(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || (closeOnImageClick && e.target === img)) close();
  });
  document.addEventListener('keydown', onKey, true);

  overlay.append(img, closeBtn);
  document.body.append(overlay);
  closeBtn.focus();
  return close;
}
