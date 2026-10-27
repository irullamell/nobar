import { useRoute, navigate, loadHostCredentials } from "./lib/navigation";
import { Home } from "./pages/Home";
import { HostRoom } from "./pages/HostRoom";
import { ViewerRoom } from "./pages/ViewerRoom";

export function App() {
  const route = useRoute();

  if (route.view === "home") {
    return <Home onNavigate={navigate} />;
  }

  const hostCreds = loadHostCredentials(route.code);
  if (hostCreds) {
    return <HostRoom code={route.code} hostToken={hostCreds.hostToken} hostName={hostCreds.name} onExit={() => navigate("/")} />;
  }
  return <ViewerRoom code={route.code} onExit={() => navigate("/")} />;
}
