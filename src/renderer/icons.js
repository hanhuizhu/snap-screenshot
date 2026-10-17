/* WeChat-style line icons. Each entry is an SVG body for a 24x24 viewBox,
 * stroked with currentColor so the CSS `color` drives them. */

window.ICONS = {
  rect: '<rect x="4" y="4" width="16" height="16" rx="1.6"/>',

  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="7.2"/>',

  arrow:
    '<path d="M3.8 20.2 L16.2 7.8"/>' +
    '<path d="M20.2 3.8 L17.33 11.21 L12.79 6.67 Z" fill="currentColor" stroke="none"/>',

  pen: '<path d="M3.6 15.2c2.1-6.4 4.2-6.4 6.3 0s4.2 6.4 6.3 0 2.4-4.6 4.2-5.6"/>',

  mosaic:
    '<rect x="3.6" y="3.6" width="6.4" height="6.4" rx="1"/>' +
    '<rect x="14" y="3.6" width="6.4" height="6.4" rx="1"/>' +
    '<rect x="3.6" y="14" width="6.4" height="6.4" rx="1"/>' +
    '<rect x="10" y="10" width="4" height="4" rx="0.8" opacity=".85"/>' +
    '<rect x="14" y="14" width="6.4" height="6.4" rx="1" opacity=".85"/>',

  text: '<path d="M5 5.6h14"/><path d="M12 5.6v13"/><path d="M9.4 18.6h5.2"/>',

  undo: '<path d="M4.6 9.4h9.6a4.8 4.8 0 0 1 0 9.6H7.6"/><path d="M8.2 5.6 4.4 9.4l3.8 3.8"/>',

  redo: '<path d="M19.4 9.4H9.8a4.8 4.8 0 0 0 0 9.6h6.6"/><path d="M15.8 5.6l3.8 3.8-3.8 3.8"/>',

  pin:
    '<path d="M9.2 3.6h5.6"/>' +
    '<path d="M10.2 3.6l-.7 5.9-2.6 3v2.1h10.2v-2.1l-2.6-3-.7-5.9"/>' +
    '<path d="M12 14.6v5.8"/>',

  save: '<path d="M12 3.6v10.2"/><path d="M7.8 9.9 12 14.1l4.2-4.2"/><path d="M4.6 18.4h14.8"/>',

  copy:
    '<rect x="8.6" y="8.6" width="11.8" height="11.8" rx="2.2"/>' +
    '<path d="M15.4 8.6V6.2a2.2 2.2 0 0 0-2.2-2.2H6.2A2.2 2.2 0 0 0 4 6.2v7a2.2 2.2 0 0 0 2.2 2.2h2.4"/>',

  cancel: '<path d="M6.2 6.2 17.8 17.8"/><path d="M17.8 6.2 6.2 17.8"/>',

  close:
    '<circle cx="12" cy="12" r="8.4"/>' +
    '<path d="M9.2 9.2l5.6 5.6"/><path d="M14.8 9.2l-5.6 5.6"/>',
};

/** Render an icon into an SVG element of the given CSS size. */
window.svgIcon = function svgIcon(name, size = 20) {
  const body = window.ICONS[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
};
