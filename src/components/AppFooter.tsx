import packageJson from "../../package.json";

export function AppFooter() {
  return (
    <footer className="text-muted-foreground mt-6 text-center text-xs">
      {packageJson.version}
    </footer>
  );
}
