// The app is free and has no Apple Developer certificate. Apple Silicon Macs
// refuse to run code with no signature at all, so after packing we sign the
// app "ad hoc" (no identity). Gatekeeper still asks the user to approve it once.
const { execFileSync } = require('child_process');
const path = require('path');
exports.default = async (ctx) => {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
