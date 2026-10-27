import { Capacitor } from '@capacitor/core';

// True inside the Android/iOS WebView shell; the Electron build sets window.lumen
// from the preload instead and never touches the mobile platform layer.
export const isMobile = Capacitor.isNativePlatform();
