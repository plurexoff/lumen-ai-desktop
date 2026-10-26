import type { DesktopAPI } from '../electron/shared';
declare global { interface Window { lumen: DesktopAPI; } }
export {};
