// Post-install: upgrade ffmpeg-expo from the BROKEN npm 0.1.0 build to the
// fixed repo-main build.
//
// Why: npm ffmpeg-expo@0.1.0 predates the library's own "embed the upstream
// FFmpeg command frontend" fix (merged into main Jul 27 + Aug 11 2026). The
// 0.1.0 native wrapper + its r2 binaries mishandle complex multi-input
// filtergraphs — the exact cause of our photo "code -2" and video
// "audio-only output" failures. Main's native code + the `embed` binaries
// (release ffmpeg-6.1.1-embed-96ed6ff) fix this.
//
// What this does (idempotent, runs on every npm install incl. EAS cloud):
//   1. Downloads the repo-main tarball and overlays android/ios/plugin +
//      module config over node_modules/ffmpeg-expo (KEEPS the compiled
//      build/ JS from npm, which shares the same run/execute API).
//   2. Points binaryReleaseTag at the fixed `embed` binary release.
//   3. Re-runs the package postinstall to fetch those binaries.
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

const MAIN_COMMIT = '0a8a341aeb7bb0680662da68f4b2bfe1c6063b47';
const EMBED_TAG = 'ffmpeg-6.1.1-embed-96ed6ff';
const PKG = path.join(__dirname, '..', 'node_modules', 'ffmpeg-expo');

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    https
      .get(url, { headers: { 'User-Agent': 'genz-postinstall' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4) {
          f.close();
          fs.unlinkSync(dest);
          resolve(download(res.headers.location, dest, redirects + 1));
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(f);
        f.on('finish', () => f.close(resolve));
      })
      .on('error', (e) => {
        try {
          fs.unlinkSync(dest);
        } catch {}
        reject(e);
      });
  });
}

async function main() {
  const pkgJsonPath = path.join(PKG, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    console.log('[patch-ffmpeg] ffmpeg-expo not installed — skipping');
    return;
  }
  const tmp = path.join(os.tmpdir(), `ffmpeg-expo-main-${process.pid}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    // 1) fetch main sources
    const tarball = path.join(tmp, 'main.tar.gz');
    console.log('[patch-ffmpeg] fetching ffmpeg-expo main sources…');
    await download(
      `https://github.com/kingjnr4/ffmpeg-expo/archive/${MAIN_COMMIT}.tar.gz`,
      tarball
    );
    try {
      execSync(`tar -xzf "${tarball}" -C "${tmp}"`, { stdio: 'inherit' });
    } catch (e) {
      throw new Error(`tar extraction failed: ${e.message}`);
    }
    const entries = fs.readdirSync(tmp).filter((n) => n.startsWith('ffmpeg-expo-'));
    if (entries.length === 0) throw new Error(`main tarball layout unexpected: ${fs.readdirSync(tmp).join(', ')}`);
    const src = path.join(tmp, entries[0], 'packages', 'expo-ffmpeg');
    if (!fs.existsSync(src)) throw new Error(`expo-ffmpeg package not found under ${entries[0]}`);

    // 2) overlay ONLY the native sources. Keep npm's compiled JS (build/),
    //    config plugin (plugin/build), app.plugin.js, expo-module.config.json
    //    and scripts — main's repo doesn't commit those compiled artifacts.
    for (const part of ['android', 'ios']) {
      const from = path.join(src, part);
      const to = path.join(PKG, part);
      if (fs.existsSync(from)) {
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(from, to, { recursive: true });
      }
    }

    // 3) patch the binary release tag + explicit FFmpeg version.
    //    The embed tag (ffmpeg-6.1.1-embed-96ed6ff) does NOT match the
    //    postinstall's `-r<N>` version regex, so WITHOUT ffmpegVersion the
    //    C++ headers are never downloaded and gradle fails.
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    pkg.ffmpegExpo = pkg.ffmpegExpo || {};
    const changed = pkg.ffmpegExpo.binaryReleaseTag !== EMBED_TAG || pkg.ffmpegExpo.ffmpegVersion !== '6.1.1';
    pkg.ffmpegExpo.binaryReleaseTag = EMBED_TAG;
    pkg.ffmpegExpo.ffmpegVersion = '6.1.1';
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('[patch-ffmpeg] binaryReleaseTag ->', EMBED_TAG, '| ffmpegVersion -> 6.1.1', changed ? '(changed)' : '(already)');

    // 4) clean stale binaries, re-fetch the fixed ones
    for (const rel of ['android/libs', 'android/jniLibs', 'android/include', 'ios/Frameworks']) {
      fs.rmSync(path.join(PKG, rel), { recursive: true, force: true });
    }
    for (const f of fs.readdirSync(PKG)) {
      if (f.startsWith('temp-') && f.endsWith('.tar.gz')) fs.rmSync(path.join(PKG, f), { force: true });
    }
    const post = path.join(PKG, 'scripts', 'postinstall.js');
    if (fs.existsSync(post)) {
      console.log('[patch-ffmpeg] fetching embed binaries…');
      execSync(`node "${post}"`, { stdio: 'inherit', cwd: PKG });
    }
    console.log('[patch-ffmpeg] done — ffmpeg-expo now uses the fixed main build');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('');
  console.error('============================================================');
  console.error('[patch-ffmpeg] FAILED:', e.message);
  console.error('');
  console.error('  The install will continue with the BROKEN npm 0.1.0 binary,');
  console.error('  whose filtergraph handling is the documented cause of:');
  console.error('    - saved downloads with NO GEN Z watermark');
  console.error('    - "amix"/"aresample" filter-not-present errors');
  console.error('    - an ffmpeg error dialog on every save');
  console.error('');
  console.error('  Any build made from this tree will ship without branding.');
  console.error('  Re-run `npm install` with network access, or set');
  console.error('  GENZ_ALLOW_FFMPEG_PATCH_FAILURE=1 to accept that knowingly.');
  console.error('============================================================');
  console.error('');
  // This used to be exit(0) "because EAS reruns on the next build". It does
  // not: a failed fetch here is silent, the build succeeds, and the resulting
  // APK brands nothing. Failing loudly is the only way this stays fixed.
  process.exit(process.env.GENZ_ALLOW_FFMPEG_PATCH_FAILURE === '1' ? 0 : 1);
});
