import { Component, type ReactNode } from "react";
import { walletErrorMessage } from "@/lib/wallet-error";

/**
 * Jaring pengaman terakhir: satu komponen yang crash tidak boleh
 * menghitamkan seluruh aplikasi (pelajaran dari crash observer).
 * Menampilkan fallback ber-style situs + tombol pulih.
 */

interface ErrorBoundaryState {
  error: Error | null;
}

export class SiteErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("[gattai] uncaught render error:", error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div className="empty" style={{ maxWidth: 520 }}>
            <p style={{ fontSize: 15, color: "var(--text)", marginBottom: 8 }}>
              Something broke while rendering this page.
            </p>
            <p className="muted mono" style={{ fontSize: 12, marginBottom: 16, wordBreak: "break-word" }}>
              {walletErrorMessage(this.state.error, "Unknown error.")}
            </p>
            <button className="btn btn-acc" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
