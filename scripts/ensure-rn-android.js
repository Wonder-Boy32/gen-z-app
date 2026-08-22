// Ensures node_modules/react-native/android exists.
// ffmpeg-kit-react-native's android/build.gradle throws a GradleException
// ("unable to locate React Native android sources") unless it can find this
// local maven-repo path. RN 0.86+ no longer ships that directory, so we
// recreate it (empty is fine — RN artifacts resolve from Expo's repos).
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'node_modules', 'react-native', 'android');

if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
  console.log('[ensure-rn-android] created missing dir:', dir);
} else {
  console.log('[ensure-rn-android] already present:', dir);
}
