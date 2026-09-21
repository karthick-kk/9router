export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Combo model reachability ticker: evicts offline models from routing so a
    // dead upstream can't burn the full combo timeout on every request.
    const { startComboHealthScheduler } = await import("@/sse/services/comboHealthScheduler.js");
    startComboHealthScheduler();
  }
}
