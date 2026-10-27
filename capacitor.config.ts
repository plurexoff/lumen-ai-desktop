import type { CapacitorConfig } from '@capacitor/cli';

// Android build of Lumen AI: the renderer from `dist` runs in a WebView; the
// Electron preload API is replaced by src/platform/mobile.ts (sql.js storage,
// Capacitor Preferences for keys, CapacitorHttp for provider calls).
const config: CapacitorConfig = {
 appId: 'ai.lumen.app',
 appName: 'Lumen AI',
 webDir: 'dist',
 backgroundColor: '#0d0f12',
 android: {
  allowMixedContent: true, // loopback providers (Ollama/LM Studio) over plain http
 },
};

export default config;
