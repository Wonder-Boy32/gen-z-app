// Post-install fixes for legacy native modules that break on Expo 57 / RN 0.86.
// Runs automatically after every `npm install` (including EAS cloud installs),
// so the fixes survive fresh installs.
//
// 1. node_modules/react-native/android — ffmpeg-kit-react-native's build.gradle
//    throws unless this local maven-repo path exists; RN 0.86+ no longer ships it.
// 2. ffmpeg-kit-react-native still points at the DEAD com.arthenica artifacts
//    (FFmpegKit retired Jan 2025; binaries removed from Maven Central Apr 2025).
//    Repoint to the maintained dev.ffmpegkit-maintained group + a real version,
//    and re-add the missing smart-exception dependency (the maintained AAR
//    dropped it; without it the app crashes at startup with
//    NoClassDefFoundError: com.arthenica.smartexception.java.Exceptions).
const fs = require('fs');
const path = require('path');

// ---- 1) react-native/android maven dir ----
const rnAndroid = path.join(__dirname, '..', 'node_modules', 'react-native', 'android');
if (!fs.existsSync(rnAndroid)) {
  fs.mkdirSync(rnAndroid, { recursive: true });
  console.log('[postinstall] created missing dir:', rnAndroid);
} else {
  console.log('[postinstall] react-native/android already present');
}

// ---- 2) ffmpeg-kit-react-native coordinates ----
const fkDir = path.join(__dirname, '..', 'node_modules', 'ffmpeg-kit-react-native', 'android');
const fkGradle = path.join(fkDir, 'build.gradle');
const fkProps = path.join(fkDir, 'gradle.properties');

if (fs.existsSync(fkGradle)) {
  let before = fs.readFileSync(fkGradle, 'utf8');
  let after = before.replace(/'com\.arthenica:ffmpeg-kit-'/g, "'dev.ffmpegkit-maintained:ffmpeg-kit-'");
  // re-add smart-exception (dropped from the maintained AAR) — idempotent
  if (!after.includes("'com.arthenica:smart-exception-java:0.2.1'")) {
    after = after.replace(
      "api 'com.facebook.react:react-native:+'",
      "api 'com.facebook.react:react-native:+'\n    implementation 'com.arthenica:smart-exception-java:0.2.1'"
    );
  }
  if (after !== before) {
    fs.writeFileSync(fkGradle, after);
    console.log('[postinstall] ffmpeg-kit gradle: -> dev.ffmpegkit-maintained + smart-exception-java');
  }
}

if (fs.existsSync(fkProps)) {
  const before = fs.readFileSync(fkProps, 'utf8');
  const after = before
    .replace(/ffmpegKit\.android\.main\.version=.*/g, 'ffmpegKit.android.main.version=8.1.7')
    .replace(/ffmpegKit\.android\.lts\.version=.*/g, 'ffmpegKit.android.lts.version=8.1.7');
  if (after !== before) {
    fs.writeFileSync(fkProps, after);
    console.log('[postinstall] ffmpeg-kit version -> 8.1.7 (maintained LTS)');
  }
}
