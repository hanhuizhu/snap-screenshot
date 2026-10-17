/* Standalone API debugger window (main.js showApiWindow). The console's second
 * tab mounts the very same component — see apidebug.js. */
'use strict';

window.SnapApiDebug.mount(document.getElementById('api-root'), window.snapHost);
