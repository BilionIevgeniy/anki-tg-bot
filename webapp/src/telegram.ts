/** Minimal typing of window.Telegram.WebApp — only what we use. */
interface TelegramWebApp {
  initData: string;
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  close(): void;
  disableVerticalSwipes?: () => void;
  showConfirm?: (message: string, callback: (ok: boolean) => void) => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export const tg: TelegramWebApp | undefined = window.Telegram?.WebApp;

export function initTelegram(): void {
  if (!tg) return;
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.(); // swiping a card must not close the app
}

export const haptic = {
  tap: () => tg?.HapticFeedback?.impactOccurred('light'),
  good: () => tg?.HapticFeedback?.notificationOccurred('success'),
  bad: () => tg?.HapticFeedback?.notificationOccurred('error'),
};

/** Native Telegram confirm dialog (falls back to the browser one outside Telegram). */
export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (tg?.showConfirm) {
      try {
        tg.showConfirm(message, (ok) => resolve(ok));
        return;
      } catch {
        // old Telegram client without popups → fall through
      }
    }
    resolve(window.confirm(message));
  });
}
