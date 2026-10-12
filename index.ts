import { registerRootComponent } from 'expo';
import { initThemeSync } from './src/theme';

// ============================================================
// Apply the saved theme BEFORE the app graph is imported.
//
// Ordering here is load-bearing, not tidiness. Every one of the app's 81
// StyleSheet.create() calls reads `colors.*` while its module is being imported,
// and those reads are frozen into style objects at that moment. So the palette
// has to be correct before ./App is even evaluated.
//
// That is also why this is a require() and not an ES import. `import App from
// './App'` would be HOISTED above initThemeSync() and the app graph would load
// first — leaving a light-theme user booting in dark and then visibly flipping
// on every launch, because the only thing left to do at that point would be a
// post-render repaint.
// ============================================================
initThemeSync();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const App = require('./App').default;

registerRootComponent(App);
