// Browser stubs for node built-ins that kokoro-js imports but only uses
// on its node code path (loading voices from the filesystem). In the
// browser those branches never run; these no-ops just satisfy the import.
const join = (...a) => a.filter(Boolean).join('/').replace(/\/+/g, '/');
const resolve = (...a) => join(...a);
const dirname = (p = '') => p.replace(/\/[^/]*$/, '') || '.';
const basename = (p = '') => p.split('/').pop();
const notInBrowser = async () => { throw new Error('filesystem access is not available in the browser'); };

const path = { join, resolve, dirname, basename, sep: '/' };
const fsp = { readFile: notInBrowser, writeFile: notInBrowser, access: notInBrowser, mkdir: notInBrowser };

export default path;
export { join, resolve, dirname, basename };
export const readFile = notInBrowser;
export const writeFile = notInBrowser;
export const access = notInBrowser;
export { fsp };
