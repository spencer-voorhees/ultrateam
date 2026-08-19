// electron-builder refuses to copy node_modules through extraResources, no
// matter the filter — so the staged production deps are copied into the
// packaged Resources/core here instead. afterPack runs before signing, so a
// future signed build still covers these files.
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  const staged = path.join(__dirname, '..', 'core-staging', 'node_modules');
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
  const target = path.join(resources, 'core', 'node_modules');
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(staged, target, { recursive: true });
  console.log(`  • copied core node_modules → ${target}`);
};
