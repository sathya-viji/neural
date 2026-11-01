import { BrowserWindow, WebContentsView, session, shell } from "electron";

export interface BrowserState {
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * The app's built-in browser: a panel next to the chat for source links and
 * for looking at Google yourself.
 *
 * Pages run sandboxed in their own browsing session (cookies and sign-ins
 * kept separate from the app), with no access to the app, the kernel or files.
 */
export class MiniBrowser {
  private view?: WebContentsView;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };

  constructor(private win: BrowserWindow, private onState: (s: BrowserState) => void) {}

  state(): BrowserState {
    const wc = this.view?.webContents;
    return {
      open: !!this.view,
      url: wc?.getURL() ?? "",
      title: wc?.getTitle() ?? "",
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    };
  }

  open(url: string): void {
    const target = normalise(url);
    if (!this.view) this.create();
    void this.view!.webContents.loadURL(target).catch(() => {});
    this.emit();
  }

  /** Words become a Google search; anything that looks like an address is opened. */
  go(input: string): void {
    const text = input.trim();
    if (!text) return;
    const looksLikeUrl = /^https?:\/\//i.test(text) || (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text) && !/\s/.test(text));
    this.open(looksLikeUrl ? text : `https://www.google.com/search?q=${encodeURIComponent(text)}`);
  }

  back(): void {
    this.view?.webContents.navigationHistory.goBack();
  }

  forward(): void {
    this.view?.webContents.navigationHistory.goForward();
  }

  reload(): void {
    this.view?.webContents.reload();
  }

  openExternal(): void {
    const url = this.view?.webContents.getURL();
    if (url?.startsWith("https://") || url?.startsWith("http://")) void shell.openExternal(url);
  }

  close(): void {
    if (!this.view) return;
    this.win.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = undefined;
    this.emit();
  }

  /** The panel's position, measured by the window's layout. */
  setBounds(b: { x: number; y: number; width: number; height: number }): void {
    this.bounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) };
    this.view?.setBounds(this.bounds);
  }

  /**
   * The page the user is looking at, as text, for the AI. Google's own results
   * pages are excluded: programs may not read them.
   */
  async pageText(maxChars = 8000): Promise<{ url: string; title: string; text: string } | null> {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return null;
    const url = wc.getURL();
    if (!/^https?:/.test(url) || isGoogleResults(url)) return null;
    const text = (await Promise.race([
      wc.executeJavaScript("document.body ? document.body.innerText : ''", true),
      new Promise((resolve) => setTimeout(() => resolve(""), 3000)),
    ])) as string;
    const clean = String(text).replace(/\n{3,}/g, "\n\n").trim();
    return { url, title: wc.getTitle(), text: clean.length > maxChars ? `${clean.slice(0, maxChars)}\n… [page shortened]` : clean };
  }

  private create(): void {
    const ses = session.fromPartition("persist:uab-browser");
    // Pages can't use the camera, microphone, location, notifications and so on.
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    const view = new WebContentsView({
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
    });
    view.setBackgroundColor("#ffffff");
    const wc = view.webContents;
    // Links that would open a new window open in the panel instead.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void wc.loadURL(url);
      return { action: "deny" };
    });
    wc.on("will-navigate", (e, url) => {
      if (!/^https?:/.test(url)) e.preventDefault();
    });
    for (const event of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"] as const) {
      wc.on(event as "did-navigate", () => this.emit());
    }
    this.win.contentView.addChildView(view);
    view.setBounds(this.bounds);
    this.view = view;
  }

  private emit(): void {
    this.onState(this.state());
  }
}

function normalise(url: string): string {
  const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const parsed = new URL(u);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Only web pages can be opened");
  return parsed.href;
}

export function isGoogleResults(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)google\.[a-z.]+$/.test(u.hostname) && (u.pathname === "/search" || u.pathname === "/");
  } catch {
    return false;
  }
}

/** Does the request refer to the page being viewed? Only then is its text shared with the AI. */
export function refersToPage(text: string): boolean {
  return /\b(this|the|that|current|open)\s+(page|article|site|website|tab|link|post|story)\b|\bon (this|the) page\b|\bsummari[sz]e (this|it)\b|\bwhat does (this|it) say\b/i.test(text);
}
