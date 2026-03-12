import type { ErrorInfo, ReactNode } from "react";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./app/style.css";
import { AuthProvider } from "./contexts/AuthContext";

class ErrorBoundary extends React.Component<
	{ children: ReactNode },
	{ hasError: boolean }
> {
	constructor(props: { children: ReactNode }) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError() {
		return { hasError: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("[ErrorBoundary]", error, info.componentStack);
	}

	render() {
		if (this.state.hasError) {
			return (
				<div
					style={{
						display: "grid",
						placeItems: "center",
						height: "100dvh",
						fontFamily: "Outfit, sans-serif",
						color: "#eff3fa",
						textAlign: "center",
						gap: "0.75rem",
					}}
				>
					<div>
						<h1 style={{ fontSize: "1.4rem", marginBottom: "0.5rem" }}>
							Something went wrong
						</h1>
						<button
							type="button"
							onClick={() => window.location.reload()}
							style={{
								padding: "0.5rem 1.2rem",
								borderRadius: "8px",
								border: "1px solid rgba(255,255,255,0.2)",
								background: "rgba(255,255,255,0.1)",
								color: "#eff3fa",
								cursor: "pointer",
								fontSize: "0.9rem",
							}}
						>
							Reload
						</button>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<ErrorBoundary>
			<AuthProvider>
				<App />
			</AuthProvider>
		</ErrorBoundary>
	</React.StrictMode>,
);
